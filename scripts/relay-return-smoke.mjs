import {randomUUID,randomBytes,createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import dgram from 'node:dgram';import {encodePacket,inspectPacket,unseal} from '../server/audio-protocol.mjs';
const base='https://psalmony.91.226.80.181.sslip.io',user=randomUUID(),token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex'),band=randomUUID();
const sql=q=>execFileSync('ssh',['-o','BatchMode=yes','root@91.226.80.181','cd /opt/psalmony && docker compose -p psalmony -f deploy/ekaterinburg/compose.yaml --env-file deploy/ekaterinburg/.env exec -T postgres psql -v ON_ERROR_STOP=1 -U psalmony -d psalmony'],{input:q,encoding:'utf8'});
let socket;try{
 sql(`BEGIN; INSERT INTO users(id,name,guest) VALUES('${user}','Проверка возврата',0); INSERT INTO bands(id,state) VALUES('${band}','{"bandName":"Audio smoke","songs":[],"setlists":[],"activity":[],"albums":[]}'); INSERT INTO members(band,"user",role) VALUES('${band}','${user}','viewer'); INSERT INTO sessions VALUES('${hash}','${user}','${band}',${Date.now()+600000}); COMMIT;`);
 const r=await fetch(base+'/api/audio/ticket',{method:'POST',headers:{Cookie:'psalmony='+token,'Content-Type':'application/json'},body:'{}'});const t=await r.json();if(!r.ok)throw Error(t.error);
 socket=dgram.createSocket('udp4');await new Promise(resolve=>socket.bind(0,resolve));let count=0n,joined=false,returned=false;const prefix=Buffer.from([0x43,...randomBytes(3)]),key=Buffer.from(t.key,'hex');
 socket.on('message',bytes=>{try{const p=inspectPacket(bytes),body=unseal(key,p.cipher,p.head);if(p.type===4)joined=true;if(p.type===3&&body.subarray(0,16).toString('hex')===t.id&&body.readInt16LE(20)===1234)returned=true;}catch{}});
 const send=(type,body)=>{const n=Buffer.alloc(12);prefix.copy(n);n.writeBigUInt64BE(++count,4);socket.send(encodePacket(type,t.id,key,body,n,type===1?t.ticket:''),22126,'91.226.80.181');};
 for(let i=0;i<5&&!joined;i++){send(1,Buffer.from('monitor-v1'));await new Promise(resolve=>setTimeout(resolve,1000));}
 if(joined){const pcm=Buffer.alloc(484);pcm.writeInt16LE(1234,4);send(2,pcm);await new Promise(resolve=>setTimeout(resolve,1000));send(6,Buffer.alloc(0));}
 console.log({joined,ownAudioReturned:returned});if(!returned)process.exitCode=1;
}finally{socket?.close();sql(`BEGIN; DELETE FROM sessions WHERE "user"='${user}'; DELETE FROM members WHERE "user"='${user}'; DELETE FROM bands WHERE id='${band}'; DELETE FROM users WHERE id='${user}'; COMMIT;`);}
