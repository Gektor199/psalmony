import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {ACTIVE_KEY, createDraftStore, restoreLibrary, saveFailure} from '../public/drafts.js';

// Run the actual state/auth orchestration, controlling only network completion
// and DOM/storage boundaries. No application server or user data is involved.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const core = source.split('function currentSongId()')[0].replace(/^import .*;\n/gm, '');
const poll = source.split('\n').find(line => line.startsWith('setInterval(async()=>{if(!data'));
const refresh = source.split('\n').find(line => line.startsWith('async function refresh()'));
const bootstrap = source.slice(source.indexOf('async function bootstrap(){'), source.indexOf("\nwindow.addEventListener('online'"));
const library = (id = 'alice', bandId = 'one', revision = 1) => ({
  state: {songs: [{title: `Private ${id}/${bandId}`}], activity: []},
  user: {id, bandId, role: 'editor'}, members: [], revision,
});
const response = (status, value) => ({status, ok: status < 400, json: async () => value});

function harness() {
  const requests = [], values = new Map();
  const element = {open: false, textContent: '', innerHTML: '', classList: {add() {}, remove() {}}};
  let pollCallback;
  const context = vm.createContext({
    structuredClone, AbortSignal, crypto: webcrypto, createDraftStore, restoreLibrary, saveFailure,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
    localStorage: {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
    navigator: {onLine: true},
    document: {hidden: false, activeElement: null, querySelector: () => element, documentElement: {dataset: {}}},
    setTimeout: () => 0, clearTimeout() {}, setInterval: callback => {pollCallback = callback;},
    stopTools() {}, closeModal() {}, render() {}, checkInvite() {},
  });
  vm.runInContext(core + '\n' + refresh + '\n' + bootstrap + '\n' + poll + `
    globalThis.h = {apply, sessionExpired, readState, refresh, bootstrap, changeContext, commit,
      edit: title => data.songs.push({title}),
      get: () => ({data, user, pending, conflict}),
      draft: (id, band) => drafts.get(id, band)};
  `, context);
  context.h.apply(library());
  return {...context.h, poll: () => pollCallback(), requests, values};
}

test('delayed polling success cannot reopen the library or offline entry after logout', async () => {
  const h = harness(), reading = h.poll();
  assert.equal(h.requests.length, 1);
  h.sessionExpired();
  h.requests[0].resolve(response(200, library('alice', 'one', 2)));
  await reading;
  assert.equal(h.get().user, null);
  assert.equal(h.get().data, null);
  assert.equal(h.values.has(ACTIVE_KEY), false);
});

test('delayed explicit state read cannot replace a newly selected group', async () => {
  const h = harness(), reading = h.readState();
  await h.changeContext(async () => h.apply(library('alice', 'two')));
  h.requests[0].resolve(response(200, library('alice', 'one', 2)));
  assert.equal(await reading, false);
  assert.equal(h.get().user.bandId, 'two');
  assert.equal(h.get().data.songs[0].title, 'Private alice/two');
});

test('delayed polling 401 cannot sign out a newly authenticated account', async () => {
  const h = harness(), reading = h.poll();
  h.sessionExpired();
  h.apply(library('bob', 'two'));
  h.requests[0].resolve(response(401, {error: 'Old session expired'}));
  await reading;
  assert.equal(h.get().user.id, 'bob');
  assert.equal(h.get().data.songs[0].title, 'Private bob/two');
});

test('older poll cannot restore an account after a newer poll discovers another tab login', async () => {
  const h = harness(), oldReading = h.poll(), newReading = h.poll();
  // Poll interval is 8s while request timeout is 10s, so two polls may overlap.
  // Another tab has replaced the shared cookie; only the newer request saw it.
  h.requests[1].resolve(response(200, library('bob', 'two')));
  await newReading;
  assert.equal(h.get().user.id, 'bob');
  h.requests[0].resolve(response(200, library('alice', 'one', 2)));
  await oldReading;
  assert.equal(h.get().user.id, 'bob');
  assert.equal(h.get().data.songs[0].title, 'Private bob/two');
});

test('delayed refresh success after logout does not unlock a cached account', async () => {
  const h = harness(), reading = h.refresh();
  h.sessionExpired();
  h.requests[0].resolve(response(200, library('alice', 'one', 2)));
  assert.equal(await reading, false);
  assert.equal(h.get().user, null);
  assert.equal(h.values.has(ACTIVE_KEY), false);
});

test('bootstrap network failure after logout does not restore its captured offline copy', async () => {
  const h = harness(), reading = h.bootstrap();
  h.sessionExpired();
  h.requests[0].reject(new Error('Network unavailable'));
  await reading;
  assert.equal(h.get().user, null);
  assert.equal(h.get().data, null);
  assert.equal(h.values.has(ACTIVE_KEY), false);
});

test('delayed save 401 preserves a new login and the original account draft', async () => {
  const h = harness();
  h.edit('Alice unsaved work');
  const saving = h.commit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests[0].options.method, 'PUT');
  // Another authenticated request has expired the old session while PUT was
  // in flight. Login completes before that old PUT's response arrives.
  h.sessionExpired();
  h.apply(library('bob', 'two'));
  h.requests[0].resolve(response(401, {error: 'Old session expired'}));
  await assert.rejects(saving, error => error.status === 401);
  assert.equal(h.get().user?.id, 'bob');
  assert.equal(h.draft('alice', 'one').pending, true);
  assert.equal(h.draft('alice', 'one').state.songs.at(-1).title, 'Alice unsaved work');
});
