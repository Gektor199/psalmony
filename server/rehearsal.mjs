import {probeJamulus} from './jamulus-probe.mjs';

export function validAddress(value) {
 if(typeof value!=='string'||value.length>260)return false;
 const match=value.match(/^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):([0-9]{1,5})$/);
 if(!match||Number(match[2])<1||Number(match[2])>65535)return false;
 return match[1].split('.').every(part=>part.length>0&&part.length<=63&&!part.startsWith('-')&&!part.endsWith('-'));
}
export function validReport(b) {
 const str=(v,max)=>typeof v==='string'&&v.length<=max;
 const ms=v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=2000);
 return !!b&&str(b.city,100)&&str(b.device,200)&&str(b.notes,2000)&&
 ['unknown','ethernet','wifi','mobile'].includes(b.network)&&['unknown','wired','bluetooth'].includes(b.headphones)&&
 ['not-tested','comfortable','difficult','unusable'].includes(b.experience)&&ms(b.pingMs)&&ms(b.overallMs);
}
export async function createRehearsalSchema(pool) {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS rehearsal_rooms(
   band TEXT PRIMARY KEY REFERENCES bands(id) ON DELETE CASCADE,
   address TEXT NOT NULL,location TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS rehearsal_reports(
   band TEXT REFERENCES bands(id) ON DELETE CASCADE,set_id TEXT NOT NULL,
   musician TEXT REFERENCES users(id) ON DELETE CASCADE,report JSONB NOT NULL,
   revision INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   PRIMARY KEY(band,set_id,musician));
 `);
}
export function rehearsalHandlers({lockAccount,q,all,run,transaction,need,owner,json,send,fail,config={}}) {
 let cachedProbe,pendingProbe;
 const check=async()=>{
  if(cachedProbe&&Date.now()-cachedProbe.at<5000)return cachedProbe.value;
  if(!pendingProbe)pendingProbe=probeJamulus({host:config.host,port:config.port||22124}).then(r=>{
   const value={reachable:r.reachable,connected:r.connected,checkedAt:r.checkedAt};cachedProbe={at:Date.now(),value};return value;
  }).finally(()=>{pendingProbe=null;});
  return pendingProbe;
 };
 const room=async band=>await q('SELECT address,location,revision FROM rehearsal_rooms WHERE band=?',band)||{address:'',location:config.location||'Екатеринбург',revision:0};
 const ensureSet=async(band,id)=>{
  if(typeof id!=='string'||id.length>80)fail(400,'Выберите сет-лист');
  const b=await q('SELECT state FROM bands WHERE id=?',band);
  if(!b.state.setlists.some(set=>set.id===id))fail(404,'Сет-лист не найден');
 };
 return async(req,res,url)=>{
  let s=await need(req);const p=url.pathname;
  if(p==='/api/rehearsal'&&req.method==='GET'){
   const setId=url.searchParams.get('setId');await ensureSet(s.band,setId);
   const reports=await all(`SELECT r.musician,r.report,r.revision,r.updated_at,u.name FROM rehearsal_reports r
    JOIN members m ON m.band=r.band AND m.user=r.musician JOIN users u ON u.id=r.musician WHERE r.band=? AND r.set_id=? ORDER BY u.name`,s.band,setId);
   return send(res,200,{room:await room(s.band),reports,pilot:config.address?{address:config.address,location:config.location||'Екатеринбург',capacity:8}:null});
  }
  if(p==='/api/rehearsal/room'&&req.method==='PUT'){
   owner(s);const b=await json(req);
   if(!validAddress(b.address)||typeof b.location!=='string'||!b.location.trim()||b.location.length>100||!Number.isInteger(b.revision)||b.revision<0)fail(400,'Укажите адрес вида host:22124 и город сервера');
   await transaction(async()=>{
    s=await lockAccount(s,{band:true});if(p==='/api/rehearsal/room')owner(s);if(p==='/api/rehearsal/report')await ensureSet(s.band,b.setId);
    const current=await room(s.band);if(current.revision!==b.revision)fail(409,'Настройки комнаты изменились. Обновите комнату.');
    await run(`INSERT INTO rehearsal_rooms(band,address,location,revision) VALUES(?,?,?,1)
     ON CONFLICT(band) DO UPDATE SET address=EXCLUDED.address,location=EXCLUDED.location,revision=rehearsal_rooms.revision+1`,s.band,b.address.trim(),b.location.trim());
   });
   return send(res,200,await room(s.band));
  }
  if(p==='/api/rehearsal/status'&&req.method==='GET'){
   const current=await room(s.band);
   if(!current.address)return send(res,200,{status:'not-configured'});
   if(!config.host||current.address!==config.address)return send(res,200,{status:'external',checkedAt:null});
   return send(res,200,{status:'checked',...await check()});
  }
  if(p==='/api/rehearsal/report'&&req.method==='PUT'){
   const b=await json(req);await ensureSet(s.band,b.setId);
   if(!validReport(b.report)||!Number.isInteger(b.revision)||b.revision<0)fail(400,'Проверьте данные проверки: задержки от 0 до 2000 мс или пустые поля');
   let result;
   await transaction(async()=>{
    s=await lockAccount(s,{band:true});if(p==='/api/rehearsal/room')owner(s);if(p==='/api/rehearsal/report')await ensureSet(s.band,b.setId);
    const current=await q('SELECT revision FROM rehearsal_reports WHERE band=? AND set_id=? AND musician=?',s.band,b.setId,s.user);
    if((current?.revision||0)!==b.revision)fail(409,'Ваша проверка изменена в другой вкладке. Обновите комнату.');
    const r=await room(s.band);
    if(!r.address)fail(400,'Сначала владелец должен настроить аудиосервер');
    if(b.roomRevision!==r.revision)fail(409,'Аудиосервер изменился. Обновите комнату перед сохранением измерений.');
    const report={...Object.fromEntries(['city','device','notes','network','headphones','experience','pingMs','overallMs'].map(k=>[k,b.report[k]])),address:r.address,roomRevision:r.revision};
    result=await q(`INSERT INTO rehearsal_reports(band,set_id,musician,report) VALUES(?,?,?,?)
     ON CONFLICT(band,set_id,musician) DO UPDATE SET report=EXCLUDED.report,revision=rehearsal_reports.revision+1,updated_at=now() RETURNING revision`,s.band,b.setId,s.user,JSON.stringify(report));
   });
   return send(res,200,result);
  }
  fail(404,'Метод репетиции не найден');
 };
}
