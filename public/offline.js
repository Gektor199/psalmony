export const SHELL_VERSION = 'psalmony-shell-v14';
export const SHELL_ASSETS = ['/app', '/index.html', '/app.js','/accounts.js','/drafts.js','/account-controls.js', '/desktop.js', '/music.js', '/arrangement.js','/rehearsal.js', '/offline.js', '/media.js', '/storage.js', '/vendor/soundtouch.js', '/vendor/osmd.min.js', '/style.css', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

export function collectBundle(set, library) {
  const ids = [...new Set(set.items.filter(i=>i.type==='song').map(i=>i.songId))];
  const songs = ids.map(id => {
    const song=library.find(s=>s.id===id);
    if (!song) throw new Error('В программе есть отсутствующая песня');
    return structuredClone(song);
  });
  const files=[...new Map(songs.flatMap(s=>s.files).map(f=>[f.id,f])).values()];
  return {set:structuredClone(set),songs,files};
}

// Compare content, not library revision: edits to unrelated songs do not invalidate a concert.
export function bundleFingerprint(bundle) {
  // PostgreSQL JSONB changes object key order; array order remains meaningful.
  return JSON.stringify({set:bundle.set,songs:bundle.songs},(_,value)=>
    value&&typeof value==='object'&&!Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value);
}

export async function prepareBundle(bundle, io, {signal,onProgress=()=>{}}={}) {
  let done=0;
  for (const file of bundle.files) {
    signal?.throwIfAborted();
    onProgress({done,total:bundle.files.length,name:file.name});
    let blob=await io.read(file.id);
    if (!blob || blob.size!==file.size) {
      blob=await io.download(file,signal);
      signal?.throwIfAborted();
      if (blob.size!==file.size) throw new Error(`Размер файла «${file.name}» не совпадает. Повторите скачивание.`);
      await io.write(file.id,blob);
    }
    const verified=await io.read(file.id);
    if (!verified || verified.size!==file.size) throw new Error(`Не удалось сохранить «${file.name}» на устройстве`);
    onProgress({done:++done,total:bundle.files.length,name:file.name});
  }
  signal?.throwIfAborted();
  const manifest={...bundle,signature:bundleFingerprint(bundle),savedAt:new Date().toISOString()};
  await io.save(manifest); // Commit readiness only after every attachment is verified.
  return manifest;
}

export async function inspectBundle(bundle, manifest, read) {
  if (!manifest) return {status:'missing',missing:bundle.files.length};
  if (manifest.signature!==bundleFingerprint(bundle)) return {status:'stale'};
  let missing=0;
  for (const file of bundle.files) {const blob=await read(file.id);if(!blob||blob.size!==file.size)missing++;}
  return {status:missing?'incomplete':'ready',missing,savedAt:manifest.savedAt};
}

export async function shellReady() {
  if(globalThis.psalmonyDesktop?.version)return true; // The native host serves the entire bundled shell from disk.
  if (!('caches' in globalThis) || !navigator.serviceWorker?.controller) return false;
  const cache=await caches.open(SHELL_VERSION);
  return (await Promise.all(SHELL_ASSETS.map(url=>cache.match(url)))).every(Boolean);
}
