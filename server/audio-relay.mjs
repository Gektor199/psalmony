import dgram from 'node:dgram';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {TYPES,encodePacket,inspectPacket,unseal,openTicket,ReplayWindow} from './audio-protocol.mjs';
export function createRelay({secret,socket=dgram.createSocket('udp4'),capacity=8,maxSessions=64,member=async()=>true,now=Date.now}){
 const sessions=new Map(),joins=new Map();let dropped=0;
 function send(s,type,body){const nonce=Buffer.alloc(12);s.prefix.copy(nonce);nonce.writeBigUInt64BE(++s.counter,4);const bytes=encodePacket(type,s.id,s.key,body,nonce);socket.send(bytes,s.port,s.address,()=>{});}
 function group(band){return [...sessions.values()].filter(s=>s.band===band);}
 function presence(band){const peers=group(band),body=Buffer.from(JSON.stringify({members:peers.map(s=>({id:s.id,name:s.name})),capacity,sampleRate:48000,frameSamples:240}));for(const s of peers)send(s,TYPES.PRESENCE,body);}
 function remove(s){sessions.delete(s.id);presence(s.band);}
 socket.on('message',(bytes,rinfo)=>{try{
  const p=inspectPacket(bytes);if(p.cipher[0]!==0x43)return;let s=sessions.get(p.id);
  if(p.type===TYPES.JOIN){
   if(!s){const bucket=joins.get(rinfo.address);if(bucket&&bucket.until>now()&&bucket.n>=5)return;joins.set(rinfo.address,{until:now()+1000,n:bucket?.until>now()?bucket.n+1:1});
    const c=openTicket(secret,p.ticket,now());if(c.id!==p.id||sessions.size>=maxSessions)return;
    const key=Buffer.from(c.key,'hex');const joinBody=unseal(key,p.cipher,p.head);
    s={...c,key,monitorSelf:joinBody.equals(Buffer.from('monitor-v1')),address:rinfo.address,port:rinfo.port,seen:new ReplayWindow(),prefix:Buffer.concat([Buffer.from([0x53]),randomBytes(3)]),counter:0n,last:now(),packets:0,window:now(),pings:0,pingWindow:now()};
    const previous=group(s.band).find(peer=>peer.user===s.user);if(previous)remove(previous);
    if(group(s.band).length>=capacity){send(s,TYPES.ERROR,Buffer.from('В комнате уже 8 участников'));return;}sessions.set(s.id,s);
   }
   if(s.address!==rinfo.address||s.port!==rinfo.port)return;
   unseal(s.key,p.cipher,p.head);if(!s.seen.accept(p.cipher.subarray(0,12)))return;s.last=now();presence(s.band);return;
  }
  if(!s||s.address!==rinfo.address||s.port!==rinfo.port||s.expires<=now())return;
  const plain=unseal(s.key,p.cipher,p.head);if(!s.seen.accept(p.cipher.subarray(0,12)))return;s.last=now();
  if(p.type===TYPES.LEAVE){remove(s);return;}if(p.type===TYPES.KEEP){presence(s.band);return;}
  // Authenticated, bounded echoes use the same UDP path as the audio.
  if(p.type===TYPES.PING){if(plain.length!==8)return;if(now()-s.pingWindow>=1000){s.pingWindow=now();s.pings=0;}if(++s.pings<=4)send(s,TYPES.PONG,plain);return;}
  if(p.type!==TYPES.AUDIO||plain.length!==484)return;
  if(now()-s.window>=1000){s.window=now();s.packets=0;}if(++s.packets>240)return;
  const payload=Buffer.concat([Buffer.from(s.id,'hex'),plain]);for(const target of group(s.band))if(target.id!==s.id||s.monitorSelf)send(target,TYPES.MIX,payload);
 }catch{dropped++;}});
 const cleanup=setInterval(async()=>{for(const s of sessions.values()){if(now()-s.last>10000||s.expires<=now()){remove(s);continue;}try{if(!await member(s.band,s.user)){send(s,TYPES.ERROR,Buffer.from('Доступ к группе закрыт'));remove(s);}}catch{send(s,TYPES.ERROR,Buffer.from('Не удалось проверить доступ'));remove(s);}}for(const [ip,b]of joins)if(b.until<now())joins.delete(ip);},5000);cleanup.unref();
 return {socket,sessions,stats:()=>({sessions:sessions.size,dropped}),close:()=>{clearInterval(cleanup);socket.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const secret=Buffer.from(process.env.AUDIO_TICKET_SECRET||'','hex');if(secret.length!==32)throw Error('AUDIO_TICKET_SECRET must be 32 random bytes in hex');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});
 const relay=createRelay({secret,member:async(band,user)=>(await pool.query('SELECT 1 FROM members WHERE band=$1 AND "user"=$2',[band,user])).rowCount>0});
 relay.socket.on('error',e=>{console.error('Audio relay:',e.message);process.exit(1);});relay.socket.bind(Number(process.env.AUDIO_PORT||22126),process.env.AUDIO_HOST||'0.0.0.0',()=>console.log('Psalmony audio relay ready: UDP',process.env.AUDIO_PORT||22126));
 for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{relay.close();pool.end().then(()=>process.exit(0));});
}
