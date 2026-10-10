import {imageSchema,imageHandlers,validateCovers} from './images.mjs';
import {accountSchema,accountHandlers} from './accounts.mjs';
import http from 'node:http';
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';
import {validateArrangement,arrangementText} from '../public/arrangement.js';
import {createLiveSchema,liveHandlers} from './live.mjs';
import {mintTicket} from './audio-protocol.mjs';
import {createRehearsalSchema,rehearsalHandlers} from './rehearsal.mjs';

const scrypt = promisify(scryptCb), root=resolve(fileURLToPath(new URL('../public/', import.meta.url))), data=resolve(process.env.DATA_DIR||'data');
mkdirSync(join(data,'files'),{recursive:true});
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL || 'postgres://psalmony:psalmony-local@127.0.0.1:54329/psalmony', max:10});
const tx = new AsyncLocalStorage();
await pool.query(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT NOT NULL,password TEXT,guest INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bands(id TEXT PRIMARY KEY,state JSONB NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS members(band TEXT REFERENCES bands(id),"user" TEXT REFERENCES users(id),role TEXT NOT NULL,instrument TEXT DEFAULT '',PRIMARY KEY(band,"user"));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,"user" TEXT REFERENCES users(id),band TEXT REFERENCES bands(id),expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,band TEXT REFERENCES bands(id),role TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,band TEXT REFERENCES bands(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
`);
await accountSchema(pool);
await imageSchema(pool);
await createLiveSchema(pool);
await createRehearsalSchema(pool);
function sql(text) { let n=0; return text.replace(/\?/g,()=>'$'+(++n)).replace(/\buser\b/g,'"user"'); }
const execute=(text,args)=>(tx.getStore()||pool).query(sql(text),args);
const q=async(text,...args)=>(await execute(text,args)).rows[0];
const all=async(text,...args)=>(await execute(text,args)).rows;
const run=async(text,...args)=>execute(text,args);
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const rates=new Map();
function rate(req,name,limit=30){const client=process.env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').pop().trim():req.socket.remoteAddress;const k=`${client}:${name}`,now=Date.now();const v=rates.get(k);if(!v||v.until<now) rates.set(k,{count:1,until:now+60000});else if(++v.count>limit)fail(429,'Слишком много запросов. Попробуйте через минуту.');}
setInterval(async()=>{try{const now=Date.now();for(const [k,v]of rates)if(v.until<now)rates.delete(k);await run('DELETE FROM sessions WHERE expires < ?',now);await run('DELETE FROM invites WHERE expires < ?',now);}catch(e){console.error('Session cleanup failed:',e.message);}},60000).unref();
async function body(req,max=2*1024*1024){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>max)fail(413,'Файл или запрос слишком большой');chunks.push(c);}return Buffer.concat(chunks);}
async function json(req){if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'Ожидается JSON');try{return JSON.parse((await body(req)).toString());}catch(e){if(e.status)throw e;fail(400,'Некорректный JSON');}}
async function session(req){const token=req.headers.cookie?.match(/(?:^|;\s*)psalmony=([^;]+)/)?.[1];if(!token)return null;return await q('SELECT sessions.*,users.name,users.email,users.login,users.avatar_id,users.guest,members.role FROM sessions JOIN users ON users.id=sessions.user LEFT JOIN members ON members.user=sessions.user AND members.band=sessions.band WHERE token=? AND expires>?',hash(token),Date.now());}
async function need(req,band=true){const s=await session(req);if(!s||s.guest)fail(401,'Войдите в аккаунт');if(band&&(!s.band||!s.role))fail(403,'Сначала создайте группу или примите приглашение');return s;}
function editor(s){if(s.role==='viewer')fail(403,'Для изменения нужны права редактора');}
function owner(s){if(s.role!=='owner')fail(403,'Действие доступно владельцу группы');}
function cookie(res,token,age=2592000){res.setHeader('Set-Cookie',`psalmony=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);}
async function newSession(res,user,band){const token=randomBytes(32).toString('hex');await run('INSERT INTO sessions VALUES(?,?,?,?)',hash(token),user,band,Date.now()+2592000000);cookie(res,token);}
async function profile(s){return {id:s.user,name:s.name,email:s.email,login:s.login,avatarId:s.avatar_id,guest:false,role:s.role,bandId:s.band,bands:await all('SELECT bands.id, members.role, bands.state->>\'bandName\' as name FROM members JOIN bands ON bands.id=members.band WHERE members.user=?',s.user)};}
async function state(s){if(!s.band||!s.role)return {state:null,revision:0,user:await profile(s),members:[]};const b=await q('SELECT * FROM bands WHERE id=?',s.band);return {state:b.state,revision:b.revision,user:await profile(s),members:await all('SELECT users.id,users.name,users.email,users.avatar_id AS "avatarId",members.role,members.instrument FROM members JOIN users ON users.id=members.user WHERE band=?',s.band)};}
async function transaction(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await tx.run(client,fn);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
function validState(s){
 const safeId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v);
 const str=(v,max=2000)=>typeof v==='string'&&v.length<=max;
 if(Array.isArray(s?.songs))for(const song of s.songs){
   if(!song||typeof song!=='object')fail(400,'Некорректная песня');
   if(song.arrangement!==undefined){if(!validateArrangement(song.arrangement))fail(400,'Некорректная аранжировка');if(song.lyrics!==arrangementText(song.arrangement))fail(400,'Текст должен соответствовать аранжировке');}
   if(!safeId(song.id)||!str(song.artist,200)||!str(song.key,5)||!/^([A-G][b#]?m?)$/.test(song.key)||!str(song.meter,8)||!str(song.notes,50000)||!str(song.color,30)||!Array.isArray(song.tags)||song.tags.some(t=>!str(t,80))||!Array.isArray(song.links)||song.links.some(l=>!str(l,2000))||!Array.isArray(song.files)||song.files.some(f=>!safeId(f.id)||!str(f.name,200)||!str(f.mime,80)))fail(400,'Некорректные поля песни');
   if(song.annotations!==undefined&&(!Array.isArray(song.annotations)||song.annotations.length>1000||song.annotations.some(a=>!str(a.color,9)||!/^#[a-fA-F0-9]{6}$/.test(a.color)||!Number.isFinite(a.width)||a.width<1||a.width>10||!Array.isArray(a.points)||a.points.length>20000||a.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||Math.abs(n)>10000)))))fail(400,'Некорректные рукописные заметки');
 }
 if(Array.isArray(s?.setlists))for(const set of s.setlists)if(!safeId(set.id)||!str(set.date,30)||!str(set.location,1000)||!str(set.kind,80)||!str(set.description,10000)||!str(set.color,30)||!Array.isArray(set.items)||set.items.some(i=>!safeId(i.id)))fail(400,'Некорректные поля сет-листа');
 if(s?.activity&&(!Array.isArray(s.activity)||s.activity.some(a=>!safeId(a.id)||!str(a.text,2000)||!str(a.at,50))))fail(400,'Некорректная история изменений');

 if(!s||typeof s.bandName!=='string'||!s.bandName.trim()||s.bandName.length>120||!Array.isArray(s.songs)||s.songs.length>3000||!Array.isArray(s.setlists)||s.setlists.length>1000||!Array.isArray(s.activity)||s.activity.length>200)fail(400,'Некорректные данные библиотеки');
 const ids=new Set();for(const song of s.songs){if(typeof song.id!=='string'||ids.has(song.id)||typeof song.title!=='string'||!song.title.trim()||song.title.length>200||typeof song.lyrics!=='string'||song.lyrics.length>200000||!Number.isFinite(song.bpm)||song.bpm<20||song.bpm>300||!Number.isFinite(song.duration)||song.duration<0||song.duration>86400||!Array.isArray(song.tags)||!Array.isArray(song.files)||!Array.isArray(song.links))fail(400,'Некорректные данные песни');ids.add(song.id);}
 const sets=new Set();for(const set of s.setlists){if(typeof set.id!=='string'||sets.has(set.id)||typeof set.title!=='string'||!set.title.trim()||!Array.isArray(set.items)||set.items.length>500)fail(400,'Некорректный сет-лист');sets.add(set.id);for(const i of set.items)if(!['song','break','note'].includes(i.type)||(i.type==='song'&&!ids.has(i.songId))||(i.type==='break'&&(!Number.isFinite(i.duration)||i.duration<0||i.duration>86400)))fail(400,'Некорректный элемент сет-листа');}
}
async function password(value){if(typeof value!=='string'||value.length<10||value.length>200)fail(400,'Пароль должен содержать от 10 до 200 символов');const salt=randomBytes(16).toString('hex');return salt+':'+Buffer.from(await scrypt(value,salt,64)).toString('hex');}
async function matches(value,encoded){if(typeof value!=='string'||value.length>200||!encoded)return false;const[salt,digest]=encoded.split(':');const test=Buffer.from(await scrypt(value,salt,64));return timingSafeEqual(Buffer.from(digest,'hex'),test);}
async function newBand(user,name,demo=true){const id=randomUUID(),s=seed();if(!demo){s.songs=[];s.setlists=[];s.activity=[];}s.albums=[];s.bandName=name;await run('INSERT INTO bands(id,state) VALUES(?,?)',id,JSON.stringify(s));await run('INSERT INTO members(band,user,role) VALUES(?,?,?)',id,user,'owner');return id;}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.png':'image/png','.dmg':'application/x-apple-diskimage','.exe':'application/octet-stream','.zip':'application/zip','.json':'application/json','.txt':'text/plain; charset=utf-8'};
const handleLive=liveHandlers({q,run,transaction,need,editor,json,send,fail});
const handleRehearsal=rehearsalHandlers({q,all,run,transaction,need,owner,json,send,fail,config:{host:process.env.JAMULUS_PROBE_HOST,port:Number(process.env.JAMULUS_PROBE_PORT||22124),address:process.env.JAMULUS_CLIENT_ADDRESS,location:process.env.JAMULUS_LOCATION}});
const handleAccounts=accountHandlers({pool,q,all,run,transaction,session,need,owner,json,send,fail,newSession,cookie,password,matches,newBand,profile,state});
const handleImages=imageHandlers({data,q,run,transaction,need,editor,owner,body,send,fail,rate});
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'");
 try{
 const url=new URL(req.url,'http://localhost'),p=url.pathname;
 if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
   const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)fail(403,'Запрос с другого сайта отклонён');
   if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Запрос с другого сайта отклонён');
 }
 if(p.startsWith('/api/images')){if(await handleImages(req,res,url)!==false)return;}
 if(p==='/api/health'){await pool.query('SELECT 1');return send(res,200,{ok:true,version:'0.5.0',database:'postgresql'});}
 if(p==='/api/audio/ticket'&&req.method==='POST'){
  const s=await need(req);await json(req);rate(req,'audio-ticket',10);const secret=Buffer.from(process.env.AUDIO_TICKET_SECRET||'','hex');if(secret.length!==32||!process.env.AUDIO_CLIENT_ADDRESS)fail(503,'Свой аудиосервер пока не настроен');
  const claims={v:1,id:randomBytes(16).toString('hex'),key:randomBytes(32).toString('hex'),band:s.band,user:s.user,name:s.name.slice(0,80),expires:Date.now()+3600000};
  return send(res,201,{id:claims.id,key:claims.key,ticket:mintTicket(secret,claims),address:process.env.AUDIO_CLIENT_ADDRESS,expires:claims.expires,name:claims.name,protocol:'psm1-pcm16-mono-48k',capacity:8});
 }
 if(p.startsWith('/api/auth/')||p==='/api/account'||p.startsWith('/api/bands')||p.startsWith('/api/invites')){const handled=await handleAccounts(req,res,url);if(handled!==false)return;}
 if(p.startsWith('/api/live')){await handleLive(req,res,url);return;}
 if(p.startsWith('/api/rehearsal')){await handleRehearsal(req,res,url);return;}
 if(p==='/api/state'){
  const s=await need(req,req.method!=='GET');if(req.method==='GET')return send(res,200,await state(s));
  if(req.method==='PUT'){editor(s);const b=await json(req);validState(b.state);await validateCovers(b.state,s.band,q,fail);const revision=await transaction(async()=>{const current=await q('SELECT revision,state FROM bands WHERE id=? FOR UPDATE',s.band);if(current.revision!==b.revision)fail(409,'Библиотека изменилась на другом устройстве. Сохраните копию и загрузите актуальные данные.');if(s.role!=='owner'&&(current.state.bandName!==b.state.bandName||current.state.coverId!==b.state.coverId))fail(403,'Название группы может менять владелец');await run('UPDATE bands SET state=?,revision=revision+1 WHERE id=?',JSON.stringify(b.state),s.band);return current.revision+1;});return send(res,200,{revision});}
 }
 if(p.startsWith('/api/members/')&&req.method==='PATCH'){const s=await need(req),id=p.split('/').pop(),b=await json(req),m=await q('SELECT * FROM members WHERE band=? AND user=?',s.band,id);if(!m)fail(404,'Участник не найден');if(s.user!==id)owner(s);if(b.role!==undefined){owner(s);if(m.role==='owner')fail(400,'Нельзя изменить роль владельца');if(!['editor','viewer'].includes(b.role))fail(400,'Неизвестная роль');await run('UPDATE members SET role=? WHERE band=? AND user=?',b.role,s.band,id);}if(b.instrument!==undefined)await run('UPDATE members SET instrument=? WHERE band=? AND user=?',String(b.instrument).slice(0,80),s.band,id);return send(res,200,{ok:true});}
 if(p.startsWith('/api/members/')&&req.method==='DELETE'){const s=await need(req);owner(s);const id=p.split('/').pop();if((await q('SELECT role FROM members WHERE band=? AND user=?',s.band,id))?.role==='owner')fail(400,'Владельца нельзя удалить');await transaction(async()=>{await run('DELETE FROM members WHERE band=? AND user=?',s.band,id);await run('DELETE FROM sessions WHERE band=? AND user=?',s.band,id);});return send(res,200,{ok:true});}
 if(p==='/api/files'&&req.method==='POST'){
  const s=await need(req);editor(s);rate(req,'uploads',30);const name=decodeURIComponent(req.headers['x-file-name']||'file').slice(0,180),ext=extname(name).toLowerCase();const types={'.pdf':'application/pdf','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.webm':'audio/webm','.musicxml':'application/xml','.xml':'application/xml'};if(!types[ext])fail(400,'Поддерживаются PDF, MusicXML и аудио MP3/WAV/M4A/OGG/WEBM');const bytes=await body(req,30*1024*1024);if(!bytes.length)fail(400,'Пустой файл');const used=Number((await q('SELECT coalesce(sum(size),0) AS size FROM files WHERE band=?',s.band)).size);if(used+bytes.length>500*1024*1024)fail(413,'Лимит группы — 500 МБ');const id=randomUUID();writeFileSync(join(data,'files',id),bytes,{mode:0o600});try{await run('INSERT INTO files VALUES(?,?,?,?,?)',id,s.band,name,types[ext],bytes.length);}catch(e){unlinkSync(join(data,'files',id));throw e;}return send(res,201,{id,name,mime:types[ext],size:bytes.length});
 }
 if(p.startsWith('/api/files/')){
  const s=await need(req),f=await q('SELECT * FROM files WHERE id=? AND band=?',p.split('/').pop(),s.band);if(!f)fail(404,'Файл не найден');
  if(req.method==='DELETE'){editor(s);await run('DELETE FROM files WHERE id=?',f.id);try{unlinkSync(join(data,'files',f.id));}catch{}return send(res,200,{ok:true});}
  if(req.method==='GET'||req.method==='HEAD'){const file=join(data,'files',f.id);res.setHeader('Content-Type',f.mime);res.setHeader('Cache-Control','private, no-store');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Disposition',`${f.mime==='application/xml'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);let start=0,end=f.size-1;const range=req.headers.range;if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m)fail(416,'Некорректный диапазон');if(!m[1])start=Math.max(0,f.size-Number(m[2]));else start=Number(m[1]);if(m[1]&&m[2])end=Math.min(end,Number(m[2]));if(start>end||start>=f.size){res.setHeader('Content-Range',`bytes */${f.size}`);fail(416,'Диапазон за пределами файла');}res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${f.size}`);}res.setHeader('Content-Length',end-start+1);if(req.method==='HEAD')res.end();else createReadStream(file,{start,end}).pipe(res);return;}
 }
 if(p.startsWith('/api/'))fail(404,'Метод не найден');
 if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'Метод не поддерживается');
 const file=p==='/'?join(root,'index.html'):resolve(root,'.'+decodeURIComponent(p));if(!file.startsWith(root+'/')||!existsSync(file)||!statSync(file).isFile())fail(404,'Страница не найдена');
 res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-cache');if(req.method==='HEAD')res.end();else res.end(readFileSync(file));
 }catch(e){if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Ошибка сервера'});else res.end();if(!e.status)console.error(e);}
});
server.listen(Number(process.env.PORT||3180),process.env.HOST||'127.0.0.1',()=>console.log(`Psalmony: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3180}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0);}));
