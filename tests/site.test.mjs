import test from 'node:test';
import assert from 'node:assert/strict';
import {siteRoute} from '../server/site.mjs';

test('public site, app and legal documents have distinct entry points', () => {
  for (const [path,file] of Object.entries({'/':'site/index.html','/app':'index.html','/app/':'index.html','/privacy':'site/privacy.html','/terms':'site/terms.html'})) {
    assert.deepEqual(siteRoute(new URL(path,'https://psalmony.example')), {file});
  }
  assert.deepEqual(siteRoute(new URL('/app.js','https://psalmony.example')), {file:null});
});

test('legacy invitations enter the app and preserve their token', () => {
  assert.deepEqual(siteRoute(new URL('/?invite=abc123&source=band','https://psalmony.example')), {redirect:'/app?invite=abc123&source=band'});
  assert.deepEqual(siteRoute(new URL('/app?invite=abc123','https://psalmony.example')), {file:'index.html'});
});


test('offline app never becomes the landing page and downloads are not cached', async () => {
  const {readFile} = await import('node:fs/promises');
  const {runInNewContext} = await import('node:vm');
  const handlers = {}, lookups = [];
  const shell = {body:'application shell'}, landing = {body:'public site'};
  const context = {
    URL, Response,
    self:{location:{origin:'https://psalmony.example'},addEventListener:(type,fn)=>handlers[type]=fn},
    fetch:async()=>{throw new Error('offline');},
    caches:{match:async key=>{lookups.push(key);return key==='/app'?shell:key==='/'?landing:undefined;}}
  };
  runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  const request = async path => {
    let response;
    handlers.fetch({request:{method:'GET',url:'https://psalmony.example'+path,mode:'navigate'},respondWith:value=>response=value,waitUntil:()=>{}});
    return response?await response:undefined;
  };
  assert.equal(await request('/app?invite=private-token'),shell);
  assert.equal(await request('/app/'),shell);
  assert.equal(await request('/'),landing);
  assert.equal(await request('/downloads/client.exe'),undefined);
  assert.equal(await request('/api/account'),undefined);
  assert.equal(await request('/desktop/state'),undefined);
  assert(lookups.every(key=>!key.includes('private-token')));
});
