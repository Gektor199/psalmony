// Operator check for an idle Mac client. Keeps all physical playback at zero.
// --relay briefly sends input to a new private test room and removes only its fixtures.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base='http://127.0.0.1:3188';
const config=JSON.parse((await(await fetch(base)).text()).match(/window.psalmonyDesktop=(.*?);<\/script>/)[1]);
const raw=async(path,body)=>fetch(base+'/desktop/'+path,{headers:{'X-Psalmony-Desktop':config.token,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
const api=async(path,body)=>{const r=await raw(path,body);const v=await r.json();assert.equal(r.status,200,v.error);return v;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const collect=async(ms=1200)=>{const rows=[];for(let i=0;i<ms/100;i++){await pause(100);const s=await api('audio');assert.equal(s.master,0,'Physical speakers must stay silent');assert.equal(s.outputLevel,0);rows.push(s);}return rows;};
const peak=(rows,key)=>Math.max(...rows.map(s=>s[key]||0));
assert.equal((await api('audio')).running,false,'Disconnect the current rehearsal before running this check');
let fixture;
const sql=q=>execFileSync('ssh',['-o','BatchMode=yes','-i',process.env.PSALMONY_SSH_KEY||`${process.env.HOME}/.ssh/id_ed25519`,'root@91.226.80.181','cd /opt/psalmony && docker compose --env-file deploy/ekaterinburg/.env -f deploy/ekaterinburg/compose.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U psalmony -d psalmony'],{input:q,encoding:'utf8'});
try{
 await api('preview',{});let s;for(let i=0;i<50;i++){await pause(100);s=await api('audio');assert.equal(s.master,0);assert.equal(s.outputLevel,0);assert.equal(s.error,null);if(s.inputLevel>0)break;}assert.ok(s.inputLevel>0,'Microphone did not produce a signal within 5 seconds');assert.ok(s.running&&s.preview&&!s.connected);assert.equal(s.monitorMode,'off');assert.equal(s.micMuted,true);assert.equal(s.master,0);
 await api('controls',{inputGain:0,monitorMode:'local'});await pause(150);const zero=await collect();assert.ok(peak(zero,'inputLevel')>0,'A live microphone signal is needed');assert.equal(peak(zero,'inputPostLevel'),0);assert.ok(zero.every(s=>s.sent===0&&s.received===0&&s.micMuted));
 await api('controls',{inputGain:.5});await pause(150);const local=await collect();assert.ok(peak(local,'inputPostLevel')>0);assert.ok(local.every(s=>s.monitorMode==='local'&&s.localMonitor&&s.sent===0&&s.received===0));
 assert.equal((await raw('controls',{monitorMode:'server'})).status,400);assert.equal((await api('audio')).monitorMode,'local');
 await api('disconnect',{});s=await api('audio');assert.equal(s.running,false);assert.equal(s.monitorMode,'off');
 const report={version:config.version,preview:true,rawInput:peak(local,'inputLevel'),postFaderInput:peak(local,'inputPostLevel'),zeroFaderSilent:true,previewSent:0,physicalOutput:0};
 if(process.argv.includes('--relay')){
  const user=randomUUID(),band=randomUUID(),token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');fixture={user,band};
  sql(`BEGIN; INSERT INTO users(id,name,guest) VALUES('${user}','Проверка микшера 061',0); INSERT INTO bands(id,state) VALUES('${band}','{"bandName":"Monitor smoke 061","songs":[],"setlists":[],"activity":[],"albums":[]}'); INSERT INTO members(band,"user",role) VALUES('${band}','${user}','owner'); INSERT INTO sessions VALUES('${hash}','${user}','${band}',${Date.now()+120000}); COMMIT;`);
  const r=await fetch('https://psalmony.91.226.80.181.sslip.io/api/audio/ticket',{method:'POST',headers:{Cookie:'psalmony='+token,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,201);const ticket=await r.json();await api('connect',ticket);
  for(let i=0;i<60;i++){s=await api('audio');if(s.connected)break;await pause(100);}assert.ok(s.connected);assert.equal(s.monitorMode,'off');assert.equal(s.master,0);assert.equal(s.micMuted,true);
  await api('controls',{muted:false,inputGain:1,monitorMode:'server',id:ticket.id,gain:.7});const network=await collect(1800);assert.ok(network.every(s=>s.monitorMode==='server'&&!s.localMonitor));const own=network.map(s=>s.members.find(m=>m.self));assert.ok(own.some(m=>m?.level>0),'Own nonzero input must return from the relay');assert.ok(own.at(-1).received>0);assert.ok(own.at(-1).lastFrameAgeMs<1000);
  await api('controls',{muted:true});await pause(1500);const muted=await collect();assert.ok(Math.max(...muted.map(s=>s.members.find(m=>m.self)?.level||0))<.000001);assert.ok(muted.at(-1).received>network.at(-1).received,'Silence still travels through the relay');
  await api('controls',{monitorMode:'local'});await pause(200);s=await api('audio');assert.equal(s.monitorMode,'local');assert.equal(s.localMonitor,true);assert.equal(s.micMuted,true);assert.equal(s.master,0);
  Object.assign(report,{relayConnected:true,ownReturnPeak:Math.max(...own.map(m=>m?.level||0)),ownReturnFrames:own.at(-1).received,sendMuteVerified:true,monitorModesExclusive:true});
 }
 console.log(JSON.stringify(report,null,2));
}finally{
 await api('disconnect',{}).catch(()=>{});
 if(fixture)sql(`BEGIN; DELETE FROM sessions WHERE "user"='${fixture.user}'; DELETE FROM members WHERE "user"='${fixture.user}'; DELETE FROM bands WHERE id='${fixture.band}'; DELETE FROM users WHERE id='${fixture.user}'; COMMIT;`);
}
