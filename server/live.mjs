import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {validPosition} from '../public/arrangement.js';

export const LIVE_TTL_MS=20000;
const digest=token=>createHash('sha256').update(String(token||'')).digest('hex');

export async function createLiveSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS live_sessions (
    band TEXT PRIMARY KEY REFERENCES bands(id) ON DELETE CASCADE,
    id TEXT NOT NULL, leader_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    control_hash TEXT NOT NULL, snapshot JSONB NOT NULL, position JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`);
}

export function liveHandlers({lockAccount,q,run,transaction,need,editor,json,send,fail}) {
  const active=row=>row?.active && row.leader_allowed && Date.now()-new Date(row.updated_at).getTime()<LIVE_TTL_MS;
  const read=band=>q(`SELECT l.*,u.name AS leader_name, EXISTS(SELECT 1 FROM members m WHERE m.band=l.band AND m.user=l.leader_user AND m.role IN ('owner','editor')) AS leader_allowed FROM live_sessions l JOIN users u ON u.id=l.leader_user WHERE l.band=?`,band);
  const publicState=(row,full=false)=>({active:!!active(row),...(active(row)?{id:row.id,leaderId:row.leader_user,leaderName:row.leader_name,position:row.position,revision:row.revision,setId:row.snapshot.setId,setTitle:row.snapshot.setTitle,updatedAt:row.updated_at,...(full?{snapshot:row.snapshot}:{})}:{})});
  return async function handle(req,res,url) {
    let s=await need(req);const p=url.pathname;
    if(p==='/api/live'&&req.method==='GET')return send(res,200,publicState(await read(s.band),url.searchParams.get('full')==='1'));
    if(p==='/api/live/start'&&req.method==='POST'){
      editor(s);const b=await json(req),token=randomBytes(32).toString('hex');
      await transaction(async()=>{
        s=await lockAccount(s,{band:true});
        if(p!=='/api/live/stop')editor(s);
        const library=await q('SELECT state,revision FROM bands WHERE id=? FOR UPDATE',s.band);
        if(library.revision!==b.libraryRevision)fail(409,'Обновите библиотеку перед началом эфира');
        if(active(await read(s.band)))fail(409,'В группе уже идёт эфир. Присоединитесь к ведущему.');
        const set=library.state.setlists.find(set=>set.id===b.setId);
        if(!set?.items.length)fail(400,'Выберите непустой сет-лист');
        const ids=new Set(set.items.filter(i=>i.type==='song').map(i=>i.songId));
        const snapshot={setId:set.id,setTitle:set.title,items:set.items,songs:library.state.songs.filter(song=>ids.has(song.id))};
        await run(`INSERT INTO live_sessions(band,id,leader_user,control_hash,snapshot,position) VALUES(?,?,?,?,?,?) ON CONFLICT(band) DO UPDATE SET id=EXCLUDED.id,leader_user=EXCLUDED.leader_user,control_hash=EXCLUDED.control_hash,snapshot=EXCLUDED.snapshot,position=EXCLUDED.position,revision=1,active=TRUE,updated_at=clock_timestamp()`,s.band,randomUUID(),s.user,digest(token),JSON.stringify(snapshot),JSON.stringify({index:0,part:0}));
      });
      return send(res,201,{...publicState(await read(s.band),true),controlToken:token});
    }
    if(p==='/api/live'&&req.method==='PATCH'){
      editor(s);const b=await json(req);
      await transaction(async()=>{
        s=await lockAccount(s,{band:true});
        if(p!=='/api/live/stop')editor(s);
        const row=await q('SELECT * FROM live_sessions WHERE band=? FOR UPDATE',s.band);
        if(!row||row.id!==b.id||!row.active||Date.now()-new Date(row.updated_at).getTime()>=LIVE_TTL_MS)fail(409,'Эфир завершён. Начните новый эфир.');
        if(row.leader_user!==s.user||row.control_hash!==digest(b.controlToken))fail(403,'Эфиром управляет устройство ведущего');
        if(row.revision!==b.revision)fail(409,'Команда устарела. Переподключитесь к эфиру.');
        if(!validPosition(row.snapshot,b.position))fail(400,'Песня или раздел отсутствуют в программе эфира');
        const moved=JSON.stringify(row.position)!==JSON.stringify(b.position);
        await run('UPDATE live_sessions SET position=?,revision=revision+?,updated_at=clock_timestamp() WHERE band=?',JSON.stringify(b.position),moved?1:0,s.band);
      });
      return send(res,200,publicState(await read(s.band)));
    }
    if(p==='/api/live/stop'&&req.method==='POST'){
      const b=await json(req);
      await transaction(async()=>{
        s=await lockAccount(s,{band:true});
        if(p!=='/api/live/stop')editor(s);
        const row=await q('SELECT * FROM live_sessions WHERE band=? FOR UPDATE',s.band);
        if(!row||row.id!==b.id)fail(404,'Эфир не найден');
        if(s.role!=='owner'&&(row.leader_user!==s.user||row.control_hash!==digest(b.controlToken)))fail(403,'Только ведущий или владелец может завершить эфир');
        await run('UPDATE live_sessions SET active=FALSE,updated_at=clock_timestamp() WHERE band=?',s.band);
      });
      return send(res,200,{active:false});
    }
    fail(404,'Метод эфира не найден');
  };
}
