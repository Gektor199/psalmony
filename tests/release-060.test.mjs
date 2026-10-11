import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID, createHash, scryptSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import sharp from 'sharp';
import {openTicket} from '../server/audio-protocol.mjs';

const base = process.env.RELEASE_TEST_BASE;
const password = 'release QA password 603!';
const digest = value => createHash('sha256').update(value).digest('hex');

function configuration() {
  const endpoint = new URL(base), database = new URL(process.env.DATABASE_URL);
  for (const url of [endpoint, database]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Release checks require loopback endpoints');
  assert.match(database.pathname, /(?:_test(?:_|$)|_release_060$)/, 'Release checks require an isolated database');
  return database.href;
}

function client(cookie = '') {
  return {cookie, async request(path, method = 'GET', body, extra = {}) {
    const response = await fetch(base + path, {
      method, headers: {Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extra},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000),
    });
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    return {status: response.status, value: await response.json(), headers: response.headers};
  }};
}

async function fixture(t) {
  const pool = new pg.Pool({connectionString: configuration()}), users = [], bands = [], files = [];
  t.after(async () => {
    // Only rows created by this fixture are eligible for cleanup.
    for (const file of files) {
      await file.owner.client.request('/api/bands/switch', 'POST', {id: file.band});
      assert.ok([200, 404].includes((await file.owner.client.request('/api/files/' + file.id, 'DELETE')).status));
    }
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query('DELETE FROM sessions WHERE "user"=ANY($1::text[])', [users]);
      await conn.query('DELETE FROM invites WHERE band=ANY($1::text[])', [bands]);
      await conn.query('DELETE FROM members WHERE band=ANY($1::text[]) OR "user"=ANY($2::text[])', [bands, users]);
      await conn.query('DELETE FROM files WHERE band=ANY($1::text[])', [bands]);
      await conn.query('DELETE FROM bands WHERE id=ANY($1::text[])', [bands]);
      await conn.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
      await conn.query('COMMIT');
    } catch (error) {await conn.query('ROLLBACK'); throw error;}
    finally {conn.release(); await pool.end();}
  });
  async function session(user, band = null) {
    const token = randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token,"user",band,expires) VALUES($1,$2,$3,$4)', [digest(token), user.id, band, Date.now() + 600000]);
    return client('psalmony=' + token);
  }
  async function user() {
    const id = randomUUID(), login = 'release_' + randomBytes(7).toString('hex'), salt = randomBytes(16).toString('hex');
    await pool.query('INSERT INTO users(id,email,name,password,guest,login) VALUES($1,$2,$3,$4,0,$3)', [id, login + '@example.invalid', login, salt + ':' + scryptSync(password, salt, 64).toString('hex')]);
    users.push(id);
    return {id, login, client: await session({id})};
  }
  async function band(owner) {
    const name = 'Release QA ' + randomBytes(5).toString('hex');
    const result = await owner.client.request('/api/bands', 'POST', {name});
    assert.equal(result.status, 201, JSON.stringify(result.value));
    bands.push(result.value.id); return {id: result.value.id, name};
  }
  async function join(owner, user, role) {
    const invite = await owner.client.request('/api/invites', 'POST', {role});
    assert.equal(invite.status, 201);
    assert.equal((await user.client.request('/api/invites/join', 'POST', {token: invite.value.token})).status, 200);
  }
  async function upload(owner, band) {
    const response = await fetch(base + '/api/files', {method: 'POST', headers: {Cookie: owner.client.cookie, 'X-File-Name': 'release-score.pdf'}, body: '%PDF-1.7 release QA attachment', signal: AbortSignal.timeout(15000)});
    assert.equal(response.status, 201);
    const file = await response.json(); files.push({...file, owner, band}); return file;
  }
  // Force a real request to pause at PostgreSQL's account lock. A permission or
  // session change committed during that pause must be checked again on resume.
  async function queuedMutation(user, startRequest, change) {
    const conn = await pool.connect(); let result;
    try {
      await conn.query('BEGIN');
      await conn.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const {pid} = (await conn.query('SELECT pg_backend_pid() AS pid')).rows[0];
      result = startRequest();
      const deadline = Date.now() + 5000; let blocked = false;
      do {
        blocked = (await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
        if (!blocked) await delay(20);
      } while (!blocked && Date.now() < deadline);
      assert.equal(blocked, true, 'Request must reach the account lock before changing its authority');
      await change(conn);
      await conn.query('COMMIT');
      return await result;
    } catch (error) {await conn.query('ROLLBACK'); if (result) await result.catch(() => {}); throw error;}
    finally {conn.release();}
  }
  return {pool, user, session, band, join, upload, queuedMutation};
}

test('release HTTP routes serve separate site/app/legal shells and retain old invite links', {skip: !base}, async () => {
  configuration();
  const pages = new Map();
  for (const path of ['/', '/app', '/app/', '/privacy', '/terms', '/help']) {
    const response = await fetch(base + path, {signal: AbortSignal.timeout(10000)});
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    pages.set(path, await response.text());
  }
  assert.equal(pages.get('/app'), pages.get('/app/'));
  assert.notEqual(pages.get('/'), pages.get('/app'));
  assert.match(pages.get('/app'), /src="\/app\.js"/);
  assert.match(pages.get('/'), /href="\/app"/);
  assert.match(pages.get('/privacy'), /черновик|проект документа/i);
  assert.match(pages.get('/terms'), /черновик|проект документа/i);
  assert.match(pages.get('/help'), /<h1[^>]*>[^<]*(Справка|Помощь)/i);
  const redirect = await fetch(base + '/?invite=release%2Btoken&source=qa', {redirect: 'manual'});
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/app?invite=release%2Btoken&source=qa');
  assert.equal(redirect.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/missing-release-route')).status, 404);
  assert.equal((await fetch(base + '/privacy', {method: 'POST'})).status, 405);
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.start_url, '/app');
  assert.equal((await client().request('/api/state')).status, 401);
  for (const asset of ['/app.js', '/accounts.js', '/drafts.js', '/account-controls.js', '/sw.js', '/site/site.css', '/site/site.js']) assert.equal((await fetch(base + asset)).status, 200, asset);
});

test('release access boundaries, context changes and persistence use live PostgreSQL', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), editor = await f.user(), viewer = await f.user(), outsider = await f.user();
  const otherBand = await f.band(owner), group = await f.band(owner);
  await f.join(owner, editor, 'editor'); await f.join(owner, viewer, 'viewer');
  const foreign = await f.band(outsider);
  let snapshot = (await owner.client.request('/api/state')).value;
  await t.test('fresh groups contain no demo songs and shared members omit private email', async () => {
    assert.equal(snapshot.state.songs.length, 0); assert.equal(snapshot.state.setlists.length, 0);
    assert.equal(snapshot.members.length, 3);
    for (const member of snapshot.members) for (const key of ['email', 'login', 'password', 'token']) assert.equal(member[key], undefined, key);
    assert.equal(snapshot.user.email, owner.login + '@example.invalid');
    const exported = await editor.client.request('/api/account/export');
    assert.equal(exported.status, 200); assert.equal(exported.value.profile.id, editor.id);
    assert.equal(exported.value.memberships.length, 1);
    assert.ok(!JSON.stringify(exported.value).includes(owner.login));
    assert.equal(exported.headers.get('cache-control'), 'no-store');
  });
  await t.test('body bandId mismatch and stale revisions cannot alter either group', async () => {
    const change = {...snapshot.state, activity: [{id: 'qa', text: 'original-band-only', at: new Date().toISOString()}]};
    assert.equal((await owner.client.request('/api/state', 'PUT', {state: change, revision: snapshot.revision, bandId: otherBand.id})).status, 409);
    assert.equal((await owner.client.request('/api/state')).value.revision, snapshot.revision);
    const saved = await owner.client.request('/api/state', 'PUT', {state: change, revision: snapshot.revision, bandId: group.id});
    assert.equal(saved.status, 200);
    assert.equal((await owner.client.request('/api/state', 'PUT', {state: snapshot.state, revision: snapshot.revision, bandId: group.id})).status, 409);
    snapshot = (await owner.client.request('/api/state')).value;
    assert.equal(snapshot.state.activity[0].text, 'original-band-only');
    assert.equal((await f.pool.query('SELECT state,revision FROM bands WHERE id=$1', [group.id])).rows[0].revision, saved.value.revision);
    assert.equal((await f.pool.query('SELECT state FROM bands WHERE id=$1', [otherBand.id])).rows[0].state.activity.length, 0);
  });
  await t.test('viewer writes and non-owner destructive actions are rejected', async () => {
    assert.equal((await viewer.client.request('/api/state', 'PUT', {state: snapshot.state, revision: snapshot.revision, bandId: group.id})).status, 403);
    for (const actor of [viewer, editor]) {
      assert.equal((await actor.client.request('/api/bands/current', 'DELETE', {password, confirmation: group.name})).status, 403);
      assert.equal((await actor.client.request('/api/bands/transfer', 'POST', {password, userId: owner.id})).status, 403);
      assert.equal((await actor.client.request('/api/members/' + owner.id, 'DELETE')).status, 403);
    }
    const renamed = {...snapshot.state, bandName: 'editor cannot rename'};
    assert.equal((await editor.client.request('/api/state', 'PUT', {state: renamed, revision: snapshot.revision, bandId: group.id})).status, 403);
    assert.equal((await owner.client.request('/api/state')).value.revision, snapshot.revision);
  });
  await t.test('a same-band account switch cannot submit the previous account draft', async () => {
    const before = (await f.pool.query('SELECT state,revision FROM bands WHERE id=$1', [group.id])).rows[0];
    const changed = {...snapshot.state, activity: [{id: 'wrong-account', text: 'Must never be written by another account', at: new Date().toISOString()}]};
    // Both accounts are current editors of this band, but this draft belongs to owner.
    const result = await editor.client.request('/api/state', 'PUT', {state: changed, revision: snapshot.revision, bandId: group.id, userId: owner.id});
    assert.equal(result.status, 401);
    assert.deepEqual((await f.pool.query('SELECT state,revision FROM bands WHERE id=$1', [group.id])).rows[0], before);
    assert.equal((await editor.client.request('/api/auth/logout', 'POST', {}, {'X-User-Id': owner.id, 'X-Band-Id': group.id})).status, 401);
    assert.equal((await editor.client.request('/api/account')).status, 200, 'Identity mismatch must not delete the new account session');
  });
  await t.test('raw files and artwork reject stale account or band context before storage', async () => {
    const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#548cde'}}).png().toBuffer();
    const send = async (actor, path, body, expectedUser, expectedBand) => {
      const response = await fetch(base + path, {
        method: 'POST', headers: {Cookie: actor.client.cookie, 'X-File-Name': 'never-store.pdf', 'X-Revision': '1', 'X-User-Id': expectedUser, 'X-Band-Id': expectedBand}, body: new Blob([body]), signal: AbortSignal.timeout(10000),
      });
      await response.text();
      return response;
    };
    const rows = async () => (await f.pool.query("SELECT 'files' AS kind,id,band FROM files WHERE band=ANY($1::text[]) UNION ALL SELECT 'images' AS kind,id,band FROM images WHERE band=ANY($1::text[]) OR owner_id=ANY($2::text[]) ORDER BY kind,id", [[group.id, otherBand.id], [owner.id, editor.id]])).rows;
    const before = await rows();
    assert.equal((await send(editor, '/api/files', '%PDF-only QA bytes', owner.id, group.id)).status, 401);
    assert.equal((await send(editor, '/api/images?kind=avatar', png, owner.id, group.id)).status, 401);
    assert.equal((await owner.client.request('/api/bands/switch', 'POST', {id: otherBand.id})).status, 200);
    assert.equal((await send(owner, '/api/files', '%PDF-only QA bytes', owner.id, group.id)).status, 409);
    assert.equal((await send(owner, '/api/images?kind=band', png, owner.id, group.id)).status, 409);
    assert.deepEqual(await rows(), before);
    assert.equal((await owner.client.request('/api/bands/switch', 'POST', {id: group.id})).status, 200);
  });
  const file = await f.upload(owner, group.id);
  await t.test('private files stay within membership and viewers cannot delete them', async () => {
    const read = await fetch(base + '/api/files/' + file.id, {headers: {Cookie: viewer.client.cookie}});
    assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store');
    assert.match(await read.text(), /release QA attachment/);
    assert.equal((await viewer.client.request('/api/files/' + file.id, 'DELETE')).status, 403);
    assert.equal((await outsider.client.request('/api/files/' + file.id)).status, 404);
    assert.equal((await outsider.client.request('/api/files/' + file.id, 'DELETE')).status, 404);
    assert.equal((await outsider.client.request('/api/bands/switch', 'POST', {id: group.id})).status, 403);
    assert.equal((await outsider.client.request('/api/state')).value.user.bandId, foreign.id);
  });
  await t.test('in-flight save rechecks active session group before committing', async () => {
    const before = await f.pool.query('SELECT id,state,revision FROM bands WHERE id=ANY($1::text[]) ORDER BY id', [[group.id, otherBand.id]]);
    const result = await f.queuedMutation(owner,
      () => owner.client.request('/api/state', 'PUT', {state: snapshot.state, revision: snapshot.revision, bandId: group.id}),
      conn => conn.query('UPDATE sessions SET band=$1 WHERE token=$2', [otherBand.id, digest(owner.client.cookie.split('=')[1])]),
    );
    assert.equal(result.status, 409);
    assert.deepEqual((await f.pool.query('SELECT id,state,revision FROM bands WHERE id=ANY($1::text[]) ORDER BY id', [[group.id, otherBand.id]])).rows, before.rows);
    assert.equal((await owner.client.request('/api/bands/switch', 'POST', {id: group.id})).status, 200);
  });
  await t.test('in-flight save rechecks a role downgrade and a revoked session', async () => {
    const result = await f.queuedMutation(editor,
      () => editor.client.request('/api/state', 'PUT', {state: snapshot.state, revision: snapshot.revision, bandId: group.id}),
      conn => conn.query("UPDATE members SET role='viewer' WHERE band=$1 AND \"user\"=$2", [group.id, editor.id]),
    );
    assert.equal(result.status, 403);
    assert.equal((await owner.client.request('/api/members/' + editor.id, 'PATCH', {role: 'editor'})).status, 200);
    const revoked = await f.queuedMutation(editor,
      () => editor.client.request('/api/state', 'PUT', {state: snapshot.state, revision: snapshot.revision, bandId: group.id}),
      conn => conn.query('DELETE FROM sessions WHERE "user"=$1', [editor.id]),
    );
    assert.equal(revoked.status, 401);
    assert.equal((await owner.client.request('/api/state')).value.revision, snapshot.revision);
    editor.client = await f.session(editor, group.id);
  });
  await t.test('leaving revokes every session context but preserves shared material', async () => {
    const second = await f.session(viewer, group.id);
    assert.equal((await viewer.client.request('/api/bands/leave', 'POST', {})).status, 200);
    for (const current of [viewer.client, second]) {
      assert.equal((await current.request('/api/state')).value.state, null);
      assert.equal((await current.request('/api/files/' + file.id)).status, 403);
      assert.equal((await current.request('/api/bands/switch', 'POST', {id: group.id})).status, 403);
      assert.equal((await current.request('/api/audio/ticket', 'POST', {})).status, 403);
    }
    assert.equal((await f.pool.query('SELECT id FROM files WHERE id=$1', [file.id])).rowCount, 1);
    assert.equal((await owner.client.request('/api/state')).value.revision, snapshot.revision);
  });
  await t.test('audio tickets bind the current session and revoked sessions cannot mint', {skip: !process.env.RELEASE_AUDIO_TICKET_SECRET}, async () => {
    const temporary = await f.session(editor, group.id);
    const minted = await temporary.request('/api/audio/ticket', 'POST', {});
    assert.equal(minted.status, 201);
    const claims = openTicket(Buffer.from(process.env.RELEASE_AUDIO_TICKET_SECRET, 'hex'), minted.value.ticket);
    assert.equal(claims.session, digest(temporary.cookie.split('=')[1]));
    assert.equal(claims.band, group.id); assert.equal(claims.user, editor.id);
    assert.equal((await editor.client.request('/api/account/sessions/revoke', 'POST', {password})).status, 200);
    assert.equal((await temporary.request('/api/audio/ticket', 'POST', {})).status, 401);
  });
});
