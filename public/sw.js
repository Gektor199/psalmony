const VERSION='psalmony-shell-v14';
const ASSETS=['/app','/index.html','/app.js','/accounts.js','/drafts.js','/account-controls.js','/desktop.js','/music.js','/arrangement.js','/rehearsal.js','/offline.js','/media.js','/storage.js','/vendor/soundtouch.js','/vendor/osmd.min.js','/style.css','/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest'];
const PUBLIC_PAGES=['/help','/','/privacy','/terms','/site/index.html','/site/site.css','/site/site.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('psalmony-shell-')&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  const appPage=['/app','/app/','/index.html'].includes(url.pathname);
  // Keep authenticated responses, invitation URLs and installers out of the shell cache.
  if(!appPage&&!ASSETS.includes(url.pathname)&&!PUBLIC_PAGES.includes(url.pathname))return;
  const key=appPage?'/app':url.pathname;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&!r.redirected){const copy=r.clone();e.waitUntil(caches.open(VERSION).then(c=>c.put(key,copy)));}
    return r;
  }).catch(async()=>await caches.match(key)||Response.error()));
});
