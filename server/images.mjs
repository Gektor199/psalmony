import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,unlinkSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
export async function imageSchema(pool){await pool.query(`CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,band TEXT REFERENCES bands(id) ON DELETE CASCADE,owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,size INTEGER NOT NULL,created_at TIMESTAMPTZ DEFAULT now());`);}
export function imageHandlers({data,q,run,transaction,need,editor,owner,body,send,fail,rate}){
 const dir=join(data,'images');mkdirSync(dir,{recursive:true});
 return async(req,res,url)=>{
  if(url.pathname==='/api/images'&&req.method==='POST'){
   const kind=url.searchParams.get('kind'),target=url.searchParams.get('id');
   if(!['avatar','band','song','album'].includes(kind))fail(400,'Выберите назначение изображения');
   const s=await need(req,kind!=='avatar');if(kind==='band')owner(s);else if(kind!=='avatar')editor(s);
   rate(req,'images',20);const bytes=await body(req,8*1024*1024);let output;
   const raster=(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')||(bytes.toString('ascii',4,8)==='ftyp'&&['avif','avis'].includes(bytes.toString('ascii',8,12)));if(!raster)fail(400,'Используйте JPG, PNG, WebP или AVIF');
   try{const image=sharp(bytes,{limitInputPixels:25000000,animated:false,failOn:'warning'}),meta=await image.metadata();if(!['jpeg','png','webp','avif','heif'].includes(meta.format)||(meta.pages||1)>1)fail(400,'Используйте неподвижный JPG, PNG, WebP или AVIF');output=await image.rotate().resize(kind==='avatar'?512:1200,kind==='avatar'?512:1200,{fit:'cover',position:'attention',withoutEnlargement:true}).webp({quality:85}).toBuffer();}catch(e){if(e.status)throw e;fail(400,'Изображение не читается или превышает 25 мегапикселей');}
   const id=randomUUID();writeFileSync(join(dir,id),output,{mode:0o600});
   try{await transaction(async()=>{
    const u=await q('SELECT id FROM users WHERE id=? FOR UPDATE',s.user);if(!u)fail(401,'Войдите снова');
    const group=kind!=='avatar'?await q('SELECT state,revision FROM bands WHERE id=? FOR UPDATE',s.band):null;
    const used=await q('SELECT coalesce(sum(size),0) AS size FROM images WHERE '+(kind==='avatar'?'owner_id=?':'band=?'),kind==='avatar'?s.user:s.band);
    if(Number(used.size)+output.length>(kind==='avatar'?20:200)*1024*1024)fail(413,'Лимит изображений исчерпан');
    if(group&&group.revision!==Number(req.headers['x-revision']))fail(409,'Группа изменилась. Обновите страницу и повторите загрузку');
    if(group&&kind!=='band'&&!group.state[kind==='song'?'songs':'albums']?.some(item=>item.id===target))fail(404,'Песня или альбом не найден');
    await run('INSERT INTO images(id,band,owner_id,size) VALUES(?,?,?,?)',id,kind==='avatar'?null:s.band,kind==='avatar'?s.user:null,output.length);
    if(kind==='avatar')await run('UPDATE users SET avatar_id=? WHERE id=?',id,s.user);
    else {if(kind==='band')group.state.coverId=id;else group.state[kind==='song'?'songs':'albums'].find(item=>item.id===target).coverId=id;await run('UPDATE bands SET state=?,revision=revision+1 WHERE id=?',JSON.stringify(group.state),s.band);}
   });}catch(e){unlinkSync(join(dir,id));throw e;}
   return send(res,201,{id,size:output.length,mime:'image/webp'});
  }
  if(url.pathname.startsWith('/api/images/')&&req.method==='GET'){
   const s=await need(req,false),id=url.pathname.split('/').pop(),f=await q('SELECT * FROM images WHERE id=?',id);if(!f)fail(404,'Изображение не найдено');
   const allowed=f.owner_id===s.user||(f.band&&await q('SELECT 1 FROM members WHERE band=? AND user=?',f.band,s.user))||(f.owner_id&&await q('SELECT 1 FROM members a JOIN members b ON a.band=b.band WHERE a.user=? AND b.user=?',s.user,f.owner_id));
   if(!allowed)fail(404,'Изображение не найдено');res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'private, no-store','Content-Length':f.size});const stream=createReadStream(join(dir,id));stream.on('error',()=>res.destroy());stream.pipe(res);return;
  }
  return false;
 };
}
export async function validateCovers(state,band,q,fail){
 const albums=state.albums||[];if(!Array.isArray(albums)||albums.length>500)fail(400,'Некорректные альбомы');const ids=new Set();
 for(const a of albums){if(!a||typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||ids.has(a.id)||typeof a.title!=='string'||!a.title.trim()||a.title.length>200||typeof a.artist!=='string'||a.artist.length>200)fail(400,'Проверьте название и исполнителя альбома');ids.add(a.id);}
 for(const song of state.songs)if(song.albumId&&!ids.has(song.albumId))fail(400,'Альбом песни не найден');
 const covers=[state.coverId,...state.songs.map(s=>s.coverId),...albums.map(a=>a.coverId)].filter(Boolean);
 for(const id of new Set(covers))if(typeof id!=='string'||!await q('SELECT 1 FROM images WHERE id=? AND band=?',id,band))fail(400,'Обложка недоступна этой группе');
}
