import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc16,pingPacket,parsePing,probeJamulus} from '../server/jamulus-probe.mjs';
import {validAddress,validReport} from '../server/rehearsal.mjs';

test('Jamulus probe uses the standard CRC vector and rejects unrelated or damaged replies',()=>{
 assert.equal(crc16(Buffer.from('123456789')),0xd64e);
 const nonce=Buffer.from('1234'),packet=pingPacket(nonce);packet[11]=8;packet.writeUInt16LE(crc16(packet.subarray(0,12)),12);
 assert.deepEqual(parsePing(packet,nonce),{connected:8});
 assert.equal(parsePing(packet,Buffer.from('5678')),null);
 assert.equal(parsePing(packet.subarray(0,12),nonce),null);
 packet[11]=9;assert.equal(parsePing(packet,nonce),null);
});
test('rehearsal accepts explicit audio endpoints and never URL paths or credentials',()=>{
 for(const value of ['127.0.0.1:22124','ekb.example.org:22124','localhost:1'])assert.ok(validAddress(value));
 for(const value of ['https://example.org:22124','host:0','host:65536','a..b:22124','user@host:22124','host:22124/path','-host:22124','host:22124\n'])assert.equal(validAddress(value),false,value);
});
test('manual results preserve unknown latency and reject invalid measurements',()=>{
 const report={city:'Екатеринбург',device:'Test interface',network:'ethernet',headphones:'wired',experience:'not-tested',pingMs:null,overallMs:null,notes:''};
 assert.ok(validReport(report));assert.ok(validReport({...report,pingMs:0,overallMs:24.5}));
 for(const value of [-1,NaN,Infinity,'20',2001])assert.equal(validReport({...report,overallMs:value}),false);
 assert.equal(validReport({...report,experience:'ready'}),false);
});
test('missing audio server DNS and invalid ports return unavailable without crashing the app',async()=>{
 assert.equal((await probeJamulus({host:'psalmony-test.invalid',timeout:250})).reachable,false);
 assert.equal((await probeJamulus({host:'127.0.0.1',port:70000,timeout:250})).reachable,false);
});
test('real Jamulus responds on the local UDP port without joining an audio channel',{skip:process.env.TEST_JAMULUS!=='1'},async()=>{
 const result=await probeJamulus({host:'127.0.0.1'});assert.equal(result.reachable,true);assert.ok(Number.isInteger(result.connected));assert.ok(result.backendRttMs>=0);
});
