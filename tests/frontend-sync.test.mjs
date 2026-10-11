import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {createDraftStore,restoreLibrary,saveFailure} from '../public/drafts.js';
// Exercise the real orchestration up to the view layer, with network/storage
// boundaries replaced. This catches swallowed errors and queue/context races.
const core=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).split('function currentSongId()')[0].replace(/^import .*;\n/gm,'');
function harness({fetch,quota=false}={}){
 const values=new Map(),element={textContent:'',innerHTML:'',classList:{add(){},remove(){}}},storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>{if(quota)throw Error('quota');values.set(k,v);},removeItem:k=>values.delete(k)};
 const context=vm.createContext({structuredClone,AbortSignal,crypto:webcrypto,createDraftStore,restoreLibrary,saveFailure,fetch,localStorage:storage,navigator:{onLine:true},document:{querySelector:()=>element,documentElement:{dataset:{}}},setTimeout:()=>0,clearTimeout(){},stopTools(){},closeModal(){},render(){}});
 vm.runInContext(core+`\n globalThis.h={apply,commit,sync,changeContext,get:()=>({data,user,revision,pending,conflict,localSaved}),edit:title=>{data.songs.push({title});},draft:(id,band)=>drafts.get(id,band)};`,context);
 const initial={state:{songs:[],activity:[]},user:{id:'alice',bandId:'one',role:'editor'},members:[],revision:1};context.h.apply(initial);return context.h;
}
const response=(status,body)=>({ok:status<400,status,json:async()=>body});
for(const status of [400,403,409,500])test(`HTTP ${status} rejects save and retains the original scoped draft`,async()=>{
 const h=harness({fetch:async()=>response(status,{error:'Rejected'})});h.edit('Local song');await assert.rejects(h.commit(),e=>e.status===status);assert.equal(h.get().pending,true);assert.equal(h.get().conflict,status===409);assert.equal(h.draft('alice','one').state.songs[0].title,'Local song');
});
test('401 hides current data and preserves a recoverable draft for the same account',async()=>{const h=harness({fetch:async()=>response(401,{error:'Expired'})});h.edit('Offline song');await assert.rejects(h.commit(),e=>e.status===401);assert.equal(h.get().user,null);assert.equal(h.get().data,null);assert.equal(h.draft('alice','one').pending,true);h.apply({state:{songs:[],activity:[]},user:{id:'bob',bandId:'one',role:'editor'},members:[],revision:1});assert.equal(h.get().data.songs.length,0);h.apply({state:{songs:[],activity:[]},user:{id:'alice',bandId:'one',role:'editor'},members:[],revision:2});assert.equal(h.get().data.songs[0].title,'Offline song');assert.equal(h.get().conflict,true);});
test('offline save reports local only and quota failure rejects instead of claiming saved',async()=>{const fetch=async()=>{throw Error('offline');};const h=harness({fetch});h.edit('Offline song');assert.equal((await h.commit()).status,'local');assert.equal(h.get().pending,true);const failed=harness({fetch,quota:true});failed.edit('Memory only');await assert.rejects(failed.commit(),/Локальное сохранение не удалось/);assert.equal(failed.get().pending,true);assert.equal(failed.get().localSaved,false);});
test('context switch waits for in-flight save and PUT carries the source band',async()=>{let release,body;const h=harness({fetch:async(_url,options)=>{body=JSON.parse(options.body);return new Promise(resolve=>release=()=>resolve(response(200,{revision:2})));}});h.edit('Source group');const save=h.commit();await new Promise(resolve=>setImmediate(resolve));let changed=false;const change=h.changeContext(async()=>{changed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(changed,false);release();await save;await change;assert.equal(changed,true);assert.equal(body.bandId,'one');assert.equal(body.state.songs[0].title,'Source group');assert.equal(h.get().pending,false);});
test('failed queued save prevents join/create/switch callback',async()=>{const h=harness({fetch:async()=>response(500,{error:'Retry later'})});h.edit('Unsaved');const save=h.commit();const change=h.changeContext(async()=>assert.fail('Context must not switch'));await assert.rejects(save);await assert.rejects(change,/несинхронизированные/);assert.equal(h.draft('alice','one').pending,true);});

 test('a queued save after 401 rejects instead of reporting the unpersisted second edit as saved',async()=>{
 let release;const h=harness({fetch:()=>new Promise(resolve=>release=()=>resolve(response(401,{error:'Expired'})))});
 h.edit('First edit');const first=h.commit();await new Promise(resolve=>setImmediate(resolve));h.edit('Second edit');const second=h.commit();const results=Promise.allSettled([first,second]);release();
 assert.deepEqual((await results).map(r=>r.status),['rejected','rejected']);assert.equal(h.get().user,null);assert.equal(h.draft('alice','one').pending,true);assert.equal(h.draft('alice','one').state.songs.length,2);
});
