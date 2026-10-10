// Live diagnostics only; leaves microphone controls unchanged and records no audio.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:3188';
const html=await(await fetch(base)).text();
const config=JSON.parse(html.match(/window.psalmonyDesktop=(.*?);<\/script>/)[1]);
const samples=[];
for(let i=0;i<6;i++){
 const s=await(await fetch(base+'/desktop/audio',{headers:{'X-Psalmony-Desktop':config.token}})).json();
 assert.equal(s.connected,true,'Connect the native client before checking metrics');
 assert.equal(s.micMuted,true,'Keep the microphone muted for this network-only check');
 if(s.pingMs!==null){assert.ok(Number.isFinite(s.pingMs)&&s.pingMs>=0&&s.pingMs<3000);assert.ok(Math.abs(s.estimatedDelayMs-s.pingMs-s.jitterMs-10)<0.001);samples.push({pingMs:s.pingMs,networkJitterMs:s.networkJitterMs,estimatedDelayMs:s.estimatedDelayMs,bufferMs:s.jitterMs});}
 if(i<5)await new Promise(resolve=>setTimeout(resolve,1100));
}
assert.ok(samples.length>=4,'Expect fresh measurements');
assert.ok(samples.some(s=>Number.isFinite(s.networkJitterMs)),'Expect RTT variation after two responses');
const report={timestamp:new Date().toISOString(),test:'Mac to Yekaterinburg authenticated UDP PING/PONG',microphoneMuted:true,samples};
writeFileSync('docs/ping-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
