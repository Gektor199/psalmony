import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {arrangementFromLyrics,arrangementText,validateArrangement,songParts,validPosition} from '../public/arrangement.js';
import {collectBundle,prepareBundle,inspectBundle,bundleFingerprint,SHELL_VERSION,SHELL_ASSETS,shellReady} from '../public/offline.js';

test('offline fingerprint survives PostgreSQL JSONB key reordering but tracks performance order',()=>{
 const a={set:{title:'Set',items:[{songId:'s1',type:'song'},{type:'break',duration:30}]},songs:[{id:'s1',title:'Song',arrangement:{blocks:[{id:'verse',lyrics:'C'}],order:['verse']}}]};
 const b=JSON.parse(JSON.stringify(a,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
 assert.equal(bundleFingerprint(a),bundleFingerprint(b));
 b.set.items.reverse();assert.notEqual(bundleFingerprint(a),bundleFingerprint(b));
});

test('lyrics migration reuses repeated blocks without duplicating source text',()=>{
 const a=arrangementFromLyrics('{comment:Куплет}\n[C]Свет\n\n{comment:Припев}\n[F]Вместе\n\n{comment:Припев}\n[F]Вместе');
 assert.equal(a.blocks.length,2);assert.deepEqual(a.order,['part-1','part-2','part-2']);assert.ok(validateArrangement(a));
 a.blocks[1].lyrics='[G]Новый текст';assert.equal(arrangementText(a).match(/Новый текст/g).length,2);
});
test('changing the arrangement order preserves independent block sources',()=>{
 const a=arrangementFromLyrics('{comment:Куплет}\nC\n{comment:Бридж}\nD');a.order=['part-2','part-1','part-2'];
 assert.deepEqual(songParts({arrangement:a}).map(p=>p.title),['Бридж','Куплет','Бридж']);
 assert.equal(a.blocks.length,2);
});
test('arrangement validates references, unique IDs, titles and expanded size',()=>{
 const base={blocks:[{id:'a',title:'Куплет',lyrics:'C'}],order:['a']};
 assert.ok(validateArrangement(base));assert.equal(validateArrangement({...base,order:['missing']}),false);
 assert.equal(validateArrangement({...base,blocks:[...base.blocks,...base.blocks]}),false);
 assert.equal(validateArrangement({...base,order:[]}),false);
 assert.equal(validateArrangement({...base,blocks:[{id:'a',title:'{bad}',lyrics:'C'}]}),false);
 assert.equal(validateArrangement({...base,blocks:[{id:'a',title:'A',lyrics:'x'.repeat(100001)}],order:['a','a']}),false);
});
test('leader positions distinguish repeated sections and reject absent items',()=>{
 const snapshot={items:[{type:'song',songId:'s'},{type:'break',duration:30}],songs:[{id:'s',arrangement:{blocks:[{id:'a',title:'Verse',lyrics:'C'}],order:['a','a']}}]};
 assert.ok(validPosition(snapshot,{index:0,part:1}));assert.ok(validPosition(snapshot,{index:1,part:0}));
 for(const p of [{index:0,part:2},{index:2,part:0},{index:1,part:1},{index:-1,part:0},{index:0,part:1.1}])assert.equal(validPosition(snapshot,p),false);
});
const file={id:'f',name:'score.pdf',size:4,mime:'application/pdf'};
const song={id:'s',title:'Song',lyrics:'C',files:[file],links:[]};
const set={id:'set',title:'Concert',items:[{type:'song',songId:'s'},{type:'break',duration:10},{type:'song',songId:'s'}]};
function memoryIO(){const files=new Map();let manifest=null,downloads=0;return {read:id=>files.get(id),write:(id,b)=>files.set(id,b),download:async()=>{downloads++;return new Blob(['test']);},save:m=>manifest=m,get manifest(){return manifest;},get downloads(){return downloads;},files};}
test('concert bundle includes repeated set entries and downloads unique attachments once',async()=>{
 const bundle=collectBundle(set,[song]),io=memoryIO();assert.equal(bundle.songs.length,1);assert.equal(bundle.files.length,1);assert.equal(bundle.set.items.length,3);
 await prepareBundle(bundle,io);assert.equal(io.downloads,1);assert.equal((await inspectBundle(bundle,io.manifest,io.read)).status,'ready');
 await prepareBundle(bundle,io);assert.equal(io.downloads,1);
});
test('download failure leaves no ready manifest and supports retry',async()=>{
 const bundle=collectBundle(set,[song]),io=memoryIO();await assert.rejects(prepareBundle(bundle,{...io,download:()=>{throw new Error('offline');}}),/offline/);assert.equal(io.manifest,null);
 await prepareBundle(bundle,io);assert.equal((await inspectBundle(bundle,io.manifest,io.read)).status,'ready');
});
test('quota failure and incomplete downloaded bytes never mark a concert ready',async()=>{
 const bundle=collectBundle(set,[song]),io=memoryIO();
 await assert.rejects(prepareBundle(bundle,{...io,write:()=>{throw new Error('quota');}}),/quota/);assert.equal(io.manifest,null);
 await assert.rejects(prepareBundle(bundle,{...io,download:()=>new Blob(['bad'])}),/Размер/);assert.equal(io.manifest,null);
});
test('cancellation keeps successfully cached files without claiming completion',async()=>{
 const second={...file,id:'g'},bundle=collectBundle(set,[{...song,files:[file,second]}]),io=memoryIO(),controller=new AbortController();
 await assert.rejects(prepareBundle(bundle,io,{signal:controller.signal,onProgress:p=>{if(p.done===1)controller.abort();}}),{name:'AbortError'});
 assert.equal(io.files.size,1);assert.equal(io.manifest,null);await prepareBundle(bundle,io);assert.equal(io.files.size,2);
});
test('readiness detects changed song text and browser-evicted attachments',async()=>{
 const bundle=collectBundle(set,[song]),io=memoryIO();await prepareBundle(bundle,io);
 const edited=collectBundle(set,[{...song,lyrics:'D'}]);assert.notEqual(bundleFingerprint(bundle),bundleFingerprint(edited));assert.equal((await inspectBundle(edited,io.manifest,io.read)).status,'stale');
 io.files.clear();assert.equal((await inspectBundle(bundle,io.manifest,io.read)).status,'incomplete');
});
test('text-only concerts can be saved and unrelated songs do not invalidate a bundle',async()=>{
 const bundle=collectBundle(set,[{...song,files:[]}]),io=memoryIO();await prepareBundle(bundle,io);assert.equal(io.downloads,0);assert.equal((await inspectBundle(bundle,io.manifest,io.read)).status,'ready');
 assert.equal(bundleFingerprint(bundle),bundleFingerprint(collectBundle(set,[{...song,files:[]},{id:'other',lyrics:'Changed'}])));
});

test('browser offline checks match the actual service worker manifest',()=>{const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');assert.equal(source.match(/const VERSION='([^']+)'/)[1],SHELL_VERSION);for(const asset of SHELL_ASSETS)assert.ok(source.includes("'"+asset+"'"),asset);});
test('native bundled shell is available without browser service-worker support',async()=>{try{globalThis.psalmonyDesktop={version:'0.4.0'};assert.equal(await shellReady(),true);}finally{delete globalThis.psalmonyDesktop;}});
