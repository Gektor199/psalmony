// Verifies distinct hardware input and actual server-return meters. No audio is recorded.
import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:3188';const config=JSON.parse((await(await fetch(base)).text()).match(/window.psalmonyDesktop=(.*?);<\/script>/)[1]);
const api=async(path,body)=>{const r=await fetch(base+'/desktop/'+path,{headers:{'X-Psalmony-Desktop':config.token,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert.equal(r.status,200);return r.json();};
const initial=await api('audio');assert.equal(initial.connected,true);assert.equal(initial.master,0,'Keep speakers silent');assert.equal(initial.members.find(m=>m.self)?.gain,0,'Self monitor must default to zero');
const collect=async()=>{let peakInput=0,peakReturn=0,peakOutput=0;for(let i=0;i<40;i++){const s=await api('audio');assert.ok(s.connected);peakInput=Math.max(peakInput,s.inputLevel);peakReturn=Math.max(peakReturn,s.members.find(m=>m.self)?.level||0);peakOutput=Math.max(peakOutput,s.outputLevel);await new Promise(r=>setTimeout(r,100));}return {peakInput,peakReturn,peakOutput};};
try{
 await api('controls',{muted:false});const active=await collect();assert.ok(active.peakInput>0);assert.ok(active.peakReturn>0,'Own audio must arrive from server');assert.equal(active.peakOutput,0);
 await api('controls',{muted:true});await new Promise(r=>setTimeout(r,8000));const muted=await collect();assert.ok(muted.peakInput>0,'Hardware meter stays active before mute');assert.ok(muted.peakReturn<0.000001,'Server return is silent after sending mute');assert.equal(muted.peakOutput,0);
 const report={timestamp:new Date().toISOString(),test:'Mac hardware input versus own Moscow server return',active,muted,master:0,selfMonitorGain:0,muteDrainWaitMs:8000,latencyMeasured:false};writeFileSync('docs/mixer-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(report);
}finally{await api('controls',{muted:true,master:0});}
