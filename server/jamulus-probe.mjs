import dgram from 'node:dgram';
import {randomBytes} from 'node:crypto';

// Jamulus connectionless ping protocol, release 3.12.5.
// CRC-16/GENIBUS, little-endian fields. This probe never joins an audio channel.
export function crc16(bytes) {
 let crc=0xffff;
 for(const byte of bytes){crc^=byte<<8;for(let i=0;i<8;i++)crc=(crc&0x8000)?(crc<<1)^0x1021:crc<<1;crc&=0xffff;}
 return crc^0xffff;
}
export function pingPacket(nonce) {
 const p=Buffer.alloc(14);p.writeUInt16LE(1002,2);p.writeUInt16LE(5,5);nonce.copy(p,7);p.writeUInt16LE(crc16(p.subarray(0,12)),12);return p;
}
export function parsePing(p,nonce) {
 if(p.length!==14||p.readUInt16LE(0)!==0||p.readUInt16LE(2)!==1002||p[4]!==0||p.readUInt16LE(5)!==5||!p.subarray(7,11).equals(nonce)||p.readUInt16LE(12)!==crc16(p.subarray(0,12)))return null;
 return {connected:p[11]};
}
export function probeJamulus({host,port=22124,timeout=1800}) {
 return new Promise(resolve=>{
  const socket=dgram.createSocket('udp4'),nonce=randomBytes(4),started=performance.now();let finished=false;
  const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);try{socket.close();}catch{}resolve({...value,checkedAt:new Date().toISOString()});};
  const timer=setTimeout(()=>finish({reachable:false}),timeout);
  socket.on('error',()=>finish({reachable:false}));
  socket.on('message',p=>{const result=parsePing(p,nonce);if(result)finish({reachable:true,...result,backendRttMs:Math.round((performance.now()-started)*10)/10});});
  try{socket.connect(port,host,error=>{
   if(finished)return;
   if(error)return finish({reachable:false});
   try{socket.send(pingPacket(nonce),error=>{if(error)finish({reachable:false});});}catch{finish({reachable:false});}
  });}catch{finish({reachable:false});}
 });
}
