import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {randomBytes} from 'node:crypto';
import {mintTicket,openTicket,encodePacket,inspectPacket,unseal,ReplayWindow,TYPES} from '../server/audio-protocol.mjs';import {createRelay} from '../server/audio-relay.mjs';
class Socket extends EventEmitter{sent=[];send(bytes,port,address,cb){this.sent.push({bytes,port,address});cb?.();}close(){}}
const secret=randomBytes(32);const claims=(i,band='band-a')=>({v:1,id:i.toString(16).padStart(32,'0'),key:randomBytes(32).toString('hex'),band,user:'user-'+i,name:'Musician '+i,expires:Date.now()+3600000});
function peer(c){let counter=0;return{c,address:'127.0.0.'+Number.parseInt(c.id,16),port:35000,packet(type,body=Buffer.alloc(0)){const nonce=Buffer.alloc(12);nonce[0]=0x43;nonce.writeBigUInt64BE(BigInt(++counter),4);return encodePacket(type,c.id,Buffer.from(c.key,'hex'),body,nonce,type===1?mintTicket(secret,c):'');}};}
const inject=(s,p,type,body)=>s.emit('message',p.packet(type,body),{address:p.address,port:p.port});
test('audio tickets are encrypted, authenticated and expire',()=>{const c=claims(1),ticket=mintTicket(secret,c);assert.deepEqual(openTicket(secret,ticket),c);assert.ok(!Buffer.from(ticket,'base64url').includes(Buffer.from(c.key)));assert.throws(()=>openTicket(secret,ticket,Date.now()+7200000));assert.throws(()=>openTicket(randomBytes(32),ticket));});
test('eight audio peers get an isolated encrypted mix; ninth is rejected',()=>{const socket=new Socket(),relay=createRelay({secret,socket});try{const peers=Array.from({length:8},(_,i)=>peer(claims(i+1)));for(const p of peers)inject(socket,p,1);const foreign=peer(claims(10,'band-b'));inject(socket,foreign,1);const ninth=peer(claims(9));inject(socket,ninth,1);assert.equal(relay.sessions.size,9);const rejection=socket.sent.filter(p=>p.address===ninth.address).map(p=>inspectPacket(p.bytes)).at(-1);assert.equal(rejection.type,TYPES.ERROR);socket.sent=[];const pcm=Buffer.alloc(484);pcm.writeUInt32BE(7);pcm.writeInt16LE(1234,4);inject(socket,peers[0],2,pcm);assert.equal(socket.sent.length,7);for(const p of socket.sent){const c=peers.find(v=>v.address===p.address).c;const packet=inspectPacket(p.bytes);assert.equal(packet.type,3);const clear=unseal(Buffer.from(c.key,'hex'),packet.cipher,packet.head);assert.equal(clear.subarray(0,16).toString('hex'),peers[0].c.id);assert.equal(clear.readUInt32BE(16),7);assert.equal(clear.readInt16LE(20),1234);assert.throws(()=>unseal(Buffer.from(foreign.c.key,'hex'),packet.cipher,packet.head));}}finally{relay.close();}});
test('relay drops tampered, replayed and endpoint-spoofed audio',()=>{const socket=new Socket(),relay=createRelay({secret,socket});try{const a=peer(claims(1)),b=peer(claims(2));inject(socket,a,1);inject(socket,b,1);socket.sent=[];const bytes=a.packet(2,Buffer.alloc(484));socket.emit('message',bytes,{address:a.address,port:a.port});assert.equal(socket.sent.length,1);socket.emit('message',bytes,{address:a.address,port:a.port});assert.equal(socket.sent.length,1);const bad=a.packet(2,Buffer.alloc(484));bad[44]^=1;socket.emit('message',bad,{address:a.address,port:a.port});socket.emit('message',a.packet(2,Buffer.alloc(484)),{address:b.address,port:b.port});assert.equal(socket.sent.length,1);}finally{relay.close();}});
test('replay window permits reordered datagrams once',()=>{const w=new ReplayWindow();const n=i=>{const b=Buffer.alloc(12);b.writeBigUInt64BE(BigInt(i),4);return b;};assert.ok(w.accept(n(5)));assert.ok(w.accept(n(3)));assert.ok(!w.accept(n(3)));assert.ok(w.accept(n(200)));assert.ok(!w.accept(n(5)));});
test('ping echoes only to authenticated sender, rejects malformed/replayed probes and limits replies',()=>{
 let clock=Date.now();const socket=new Socket(),relay=createRelay({secret,socket,now:()=>clock});
 try{const a=peer(claims(1)),b=peer(claims(2)),outsider=peer(claims(3));const body=Buffer.from('0102030405060708','hex');
 inject(socket,outsider,TYPES.PING,body);assert.equal(socket.sent.length,0);
 inject(socket,a,TYPES.JOIN);inject(socket,b,TYPES.JOIN);socket.sent=[];
 inject(socket,a,TYPES.PING,Buffer.alloc(9));assert.equal(socket.sent.length,0);
 const probe=a.packet(TYPES.PING,body);socket.emit('message',probe,{address:a.address,port:a.port});
 assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].address,a.address);
 const pong=inspectPacket(socket.sent[0].bytes);assert.equal(pong.type,TYPES.PONG);assert.deepEqual(unseal(Buffer.from(a.c.key,'hex'),pong.cipher,pong.head),body);
 socket.emit('message',probe,{address:a.address,port:a.port});assert.equal(socket.sent.length,1);
 for(let i=0;i<8;i++)inject(socket,a,TYPES.PING,body);assert.equal(socket.sent.length,4);
 clock+=1001;inject(socket,a,TYPES.PING,body);assert.equal(socket.sent.length,5);
 clock=a.c.expires+1;inject(socket,a,TYPES.PING,body);assert.equal(socket.sent.length,5);
 }finally{relay.close();}
});
test('opt-in server return echoes own PCM; legacy clients do not hear themselves',()=>{
 const socket=new Socket(),relay=createRelay({secret,socket});try{
 const self=peer(claims(1)),legacy=peer(claims(2));inject(socket,self,TYPES.JOIN,Buffer.from('monitor-v1'));inject(socket,legacy,TYPES.JOIN);socket.sent=[];
 const pcm=Buffer.alloc(484);pcm.writeUInt32BE(42);pcm.writeInt16LE(2048,4);inject(socket,self,TYPES.AUDIO,pcm);
 assert.equal(socket.sent.length,2);const own=socket.sent.find(p=>p.address===self.address);assert.ok(own);const packet=inspectPacket(own.bytes),clear=unseal(Buffer.from(self.c.key,'hex'),packet.cipher,packet.head);assert.equal(clear.subarray(0,16).toString('hex'),self.c.id);assert.deepEqual(clear.subarray(16),pcm);
 socket.sent=[];inject(socket,legacy,TYPES.AUDIO,pcm);assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].address,self.address);
 }finally{relay.close();}
});


test('relay requires current access before admission and refuses revoked ticket reuse', async()=>{
 let allowed=true;const checked=[];const socket=new Socket();
 const relay=createRelay({secret,socket,member:async(band,user,session)=>{checked.push({band,user,session});return allowed;}});
 const c={...claims(20),session:'session-hash'},p=peer(c);
 try{
  inject(socket,p,TYPES.JOIN);await new Promise(setImmediate);assert.equal(relay.sessions.size,1);assert.equal(checked[0].session,c.session);
  allowed=false;socket.sent=[];await relay.checkAccess();assert.equal(relay.sessions.size,0);assert.equal(inspectPacket(socket.sent[0].bytes).type,TYPES.ERROR);
  socket.sent=[];inject(socket,p,TYPES.JOIN);await new Promise(setImmediate);assert.equal(relay.sessions.size,0);assert.equal(socket.sent.length,0);
 }finally{relay.close();}
});

test('relay fails closed on access-check errors and concurrent admissions preserve capacity', async()=>{
 const socket=new Socket();let reject=true;
 const relay=createRelay({secret,socket,capacity:1,member:async()=>{await new Promise(setImmediate);if(reject)throw Error('database unavailable');return true;}});
 const a=peer(claims(21)),b=peer(claims(22));
 try{
  inject(socket,a,TYPES.JOIN);await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(relay.sessions.size,0);
  reject=false;inject(socket,a,TYPES.JOIN);inject(socket,a,TYPES.JOIN);inject(socket,b,TYPES.JOIN);
  await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(relay.sessions.size,1);assert.equal(relay.sessions.get(a.c.id).user,a.c.user);
  reject=true;await relay.checkAccess();assert.equal(relay.sessions.size,0);
 }finally{relay.close();}
});
