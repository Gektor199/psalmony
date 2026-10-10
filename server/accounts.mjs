import {randomBytes,randomInt,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';
const digest=v=>createHash('sha256').update(v).digest('hex');
export async function accountSchema(pool){await pool.query(`
 ALTER TABLE users ADD COLUMN IF NOT EXISTS login TEXT;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id TEXT;
 CREATE UNIQUE INDEX IF NOT EXISTS users_login_unique ON users(lower(login)) WHERE login IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(lower(email)) WHERE email IS NOT NULL;
 CREATE TABLE IF NOT EXISTS captchas(id TEXT PRIMARY KEY,answer TEXT NOT NULL,expires BIGINT NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires BIGINT NOT NULL);
 ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
 `);}
export function accountHandlers({pool,q,all,run,transaction,session,need,owner,json,send,fail,newSession,cookie,password,matches,newBand,profile,state}){
 const ip=req=>process.env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').pop().trim():req.socket.remoteAddress;
 async function limit(key,max,window=60000){const now=Date.now();const result=await pool.query(`INSERT INTO auth_limits(key,count,expires) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_limits.expires<$3 THEN 1 ELSE auth_limits.count+1 END, expires=CASE WHEN auth_limits.expires<$3 THEN $2 ELSE auth_limits.expires END RETURNING count`,[digest(key),now+window,now]);if(result.rows[0].count>max)fail(429,'Слишком много попыток. Подождите немного.');}
 async function captchaCheck(b){const r=await q('DELETE FROM captchas WHERE id=? RETURNING answer,expires',String(b.captchaId||''));const actual=digest(String(b.captchaId||'')+':'+String(b.captchaAnswer||'').trim().toUpperCase());if(!r||r.expires<Date.now()||!timingSafeEqual(Buffer.from(r.answer,'hex'),Buffer.from(actual,'hex')))fail(400,'Код с картинки неверный или устарел. Обновите картинку.');}
 return async(req,res,url)=>{
 const p=url.pathname;
 if(p==='/api/auth/captcha'&&req.method==='GET'){
  await limit('captcha:'+ip(req),20);await run('DELETE FROM captchas WHERE expires<?',Date.now());await run('DELETE FROM auth_limits WHERE expires<?',Date.now()-86400000);
  const id=randomBytes(24).toString('hex'),alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',answer=Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join('');
  const letters=[...answer].map((ch,i)=>`<text x="${25+i*37}" y="${47+randomInt(-5,6)}" transform="rotate(${randomInt(-16,17)} ${25+i*37} 40)" font-family="DejaVu Sans,sans-serif" font-weight="bold" font-size="32" fill="hsl(${randomInt(180,270)},40%,30%)">${ch}</text>`).join('');
  const noise=Array.from({length:10},()=>`<path d="M${randomInt(280)} ${randomInt(70)} Q${randomInt(280)} ${randomInt(70)} ${randomInt(280)} ${randomInt(70)}" stroke="#94a3b8" stroke-width="1" fill="none"/>`).join('');
  const png=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="76"><rect width="280" height="76" rx="12" fill="#eef2f8"/>${noise}${letters}</svg>`)).png().toBuffer();
  await run('INSERT INTO captchas VALUES(?,?,?)',id,digest(id+':'+answer),Date.now()+300000);
  return send(res,200,{id,image:'data:image/png;base64,'+png.toString('base64'),expiresIn:300});
 }
 if(p==='/api/auth/guest')fail(410,'Гостевой режим отключён. Зарегистрируйтесь или войдите.');
 if(p==='/api/auth/register'&&req.method==='POST'){
  await limit('register:'+ip(req),10);const b=await json(req);await captchaCheck(b);
  const login=String(b.login||'').trim().toLowerCase(),email=String(b.email||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(login))fail(400,'Логин: 3–32 латинские буквы, цифры, точка, дефис или подчёркивание.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail(400,'Укажите корректную электронную почту');
  const pass=await password(b.password),id=randomUUID();
  try{await transaction(async()=>{await run('INSERT INTO users(id,email,name,password,guest,login) VALUES(?,?,?,?,0,?)',id,email,login,pass,login);});}catch(e){if(e.code==='23505')fail(409,'Логин или электронная почта уже используются');throw e;}
  await newSession(res,id,null);return send(res,201,{ok:true});
 }
 if(p==='/api/auth/login'&&req.method==='POST'){
  const b=await json(req),identity=String(b.identity||b.email||b.login||'').trim().toLowerCase();
  await limit('login-ip:'+ip(req),30);await limit('login-user:'+identity,15,300000);
  const u=await q('SELECT * FROM users WHERE (lower(email)=? OR lower(login)=?) AND guest=0',identity,identity);
  if(!u||!await matches(b.password,u.password))fail(401,'Неверный логин или пароль');
  const old=await session(req);if(old)await run('DELETE FROM sessions WHERE token=?',old.token);
  const band=(await q('SELECT band FROM members WHERE user=? ORDER BY band LIMIT 1',u.id))?.band||null;
  await newSession(res,u.id,band);return send(res,200,{ok:true});
 }
 if(p==='/api/auth/logout'&&req.method==='POST'){await json(req);const s=await session(req);if(s)await run('DELETE FROM sessions WHERE token=?',s.token);cookie(res,'',0);return send(res,200,{ok:true});}
 if(p==='/api/account'&&req.method==='GET')return send(res,200,await profile(await need(req,false)));
 if(p==='/api/account'&&req.method==='PATCH'){const s=await need(req,false),b=await json(req);const name=String(b.name||'').trim();if(!name||name.length>80)fail(400,'Имя должно содержать от 1 до 80 символов');await run('UPDATE users SET name=? WHERE id=?',name,s.user);return send(res,200,{ok:true});}
 if(p==='/api/bands'&&req.method==='POST'){const s=await need(req,false),b=await json(req);await limit('bands:'+s.user,10,3600000);const name=String(b.name||'').trim();if(!name||name.length>120)fail(400,'Укажите название группы');const id=await transaction(async()=>{const id=await newBand(s.user,name,false);await run('UPDATE sessions SET band=? WHERE token=?',id,s.token);return id;});return send(res,201,{id});}
 if(p==='/api/bands/switch'&&req.method==='POST'){const s=await need(req,false),b=await json(req);if(!await q('SELECT 1 FROM members WHERE band=? AND user=?',b.id,s.user))fail(403,'Нет доступа к группе');await run('UPDATE sessions SET band=? WHERE token=?',b.id,s.token);return send(res,200,{ok:true});}
 if(p==='/api/invites'&&req.method==='POST'){const s=await need(req);owner(s);await limit('invite:'+s.user,30);const b=await json(req);if(!['editor','viewer'].includes(b.role))fail(400,'Выберите роль участника');const token=randomBytes(24).toString('hex'),expires=Date.now()+86400000;await run('INSERT INTO invites(token,band,role,expires,created_at) VALUES(?,?,?,?,?)',digest(token),s.band,b.role,expires,Date.now());return send(res,201,{token,role:b.role,expires});}
 if(p==='/api/invites'&&req.method==='GET'){const s=await need(req);owner(s);return send(res,200,await all('SELECT token AS id,role,expires,created_at FROM invites WHERE band=? AND expires>? ORDER BY created_at DESC',s.band,Date.now()));}
 if(p.startsWith('/api/invites/')&&req.method==='DELETE'){const s=await need(req);owner(s);await run('DELETE FROM invites WHERE token=? AND band=?',p.split('/').pop(),s.band);return send(res,200,{ok:true});}
 if(p==='/api/invites/join'&&req.method==='POST'){const s=await need(req,false),b=await json(req);await limit('join:'+s.user,15);await transaction(async()=>{const i=await q('SELECT * FROM invites WHERE token=? AND expires>? FOR UPDATE',digest(String(b.token||'')),Date.now());if(!i)fail(404,'Приглашение недействительно, истекло или уже использовано');if(await q('SELECT 1 FROM members WHERE band=? AND user=?',i.band,s.user))fail(409,'Вы уже участник этой группы');await run('INSERT INTO members(band,user,role) VALUES(?,?,?)',i.band,s.user,i.role);await run('DELETE FROM invites WHERE token=?',i.token);await run('UPDATE sessions SET band=? WHERE token=?',i.band,s.token);});return send(res,200,{ok:true});}
 return false;
 };
}
