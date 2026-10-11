import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID, createHash, scryptSync} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import {createAccountFileCleanup} from '../server/account-lifecycle.mjs';

const base = process.env.ACCOUNT_LIFECYCLE_TEST_BASE;
const digest = value => createHash('sha256').update(value).digest('hex');
const originalPassword = 'test lifecycle password 842!';

// No default server/DB: these destructive checks require an explicit isolated DB.
function isolatedDatabase() {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Lifecycle tests require a loopback PostgreSQL database');
  assert.match(url.pathname, /(?:_test(?:_|$)|_release_060$)/, 'Lifecycle tests refuse a normal application database');
  const endpoint = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Lifecycle tests require a loopback server');
  return url.href;
}

function client(cookie = '') {
  return {cookie, async req(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + '/api' + path, {
      method, headers: {Cookie: this.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000),
    });
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    return {status: response.status, value: await response.json()};
  }};
}

async function fixture(t) {
  const pool = new pg.Pool({connectionString: isolatedDatabase()});
  const users = [], bands = [];
  t.after(async () => {
    for (const band of bands) {
      await pool.query('UPDATE sessions SET band=NULL WHERE band=$1', [band]);
      await pool.query('DELETE FROM invites WHERE band=$1', [band]);
      await pool.query('DELETE FROM files WHERE band=$1', [band]);
      await pool.query('DELETE FROM members WHERE band=$1', [band]);
      await pool.query('DELETE FROM bands WHERE id=$1', [band]);
    }
    for (const user of users) {
      await pool.query('DELETE FROM sessions WHERE "user"=$1', [user]);
      await pool.query('DELETE FROM members WHERE "user"=$1', [user]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    }
    await pool.end();
  });
  async function session(user, band = null) {
    const token = randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token,"user",band,expires) VALUES($1,$2,$3,$4)', [digest(token), user.id, band, Date.now() + 600000]);
    return client('psalmony=' + token);
  }
  async function user() {
    const id = randomUUID(), login = 'lifecycle_' + randomBytes(7).toString('hex'), salt = randomBytes(16).toString('hex');
    const encoded = salt + ':' + scryptSync(originalPassword, salt, 64).toString('hex');
    await pool.query('INSERT INTO users(id,email,name,password,guest,login) VALUES($1,$2,$3,$4,0,$3)', [id, login + '@example.invalid', login, encoded]);
    users.push(id);
    return {id, login, email: login + '@example.invalid', client: await session({id})};
  }
  async function band(user, name = 'Lifecycle ' + randomBytes(5).toString('hex')) {
    const result = await user.client.req('/bands', 'POST', {name});
    assert.equal(result.status, 201, JSON.stringify(result.value));
    bands.push(result.value.id);
    return {id: result.value.id, name};
  }
  async function invite(owner, member, role = 'editor') {
    const result = await owner.client.req('/invites', 'POST', {role});
    assert.equal(result.status, 201, JSON.stringify(result.value));
    assert.equal((await member.client.req('/invites/join', 'POST', {token: result.value.token})).status, 200);
  }
  return {pool, user, session, band, invite};
}

test('password changes serialize, invalidate other devices, and keep the current session', {skip: !base}, async t => {
  const f = await fixture(t), a = await f.user(), second = await f.session(a), third = await f.session(a);
  assert.equal((await a.client.req('/account/password', 'POST', {currentPassword: 'wrong', newPassword: originalPassword})).status, 403);
  assert.equal((await a.client.req('/account/password', 'POST', {currentPassword: originalPassword, newPassword: 'short'})).status, 400);
  assert.equal((await second.req('/account')).status, 200);
  const changedPassword = 'changed lifecycle password 853!';
  const changed = await a.client.req('/account/password', 'POST', {currentPassword: originalPassword, newPassword: changedPassword});
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  assert.equal(changed.value.revokedSessions, 2);
  assert.equal((await second.req('/account')).status, 401);
  assert.equal((await third.req('/account')).status, 401);
  assert.equal((await a.client.req('/account')).status, 200);
  assert.equal((await client().req('/auth/login', 'POST', {identity: a.login, password: originalPassword})).status, 401);
  const loggedIn = client();
  assert.equal((await loggedIn.req('/auth/login', 'POST', {identity: a.login, password: changedPassword})).status, 200);
  const concurrent = await Promise.all(['first', 'second'].map(part => a.client.req('/account/password', 'POST', {currentPassword: changedPassword, newPassword: part + ' new lifecycle password'})));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 403]);
  assert.equal((await loggedIn.req('/account')).status, 401);
  const winningPassword = (concurrent[0].status === 200 ? 'first' : 'second') + ' new lifecycle password';
  const racingLogin = client();
  const loginRace = await Promise.all([
    a.client.req('/account/password', 'POST', {currentPassword: winningPassword, newPassword: 'final lifecycle password 975!'}),
    racingLogin.req('/auth/login', 'POST', {identity: a.login, password: winningPassword}),
  ]);
  assert.equal(loginRace[0].status, 200);
  assert.ok([200, 401].includes(loginRace[1].status));
  assert.equal((await racingLogin.req('/account')).status, 401, 'An old-password login cannot survive a concurrent password change');
  assert.equal(Number((await f.pool.query('SELECT count(*) FROM sessions WHERE "user"=$1', [a.id])).rows[0].count), 1);
});

test('session revocation requires password and export contains only the own profile and memberships', {skip: !base}, async t => {
  const f = await fixture(t), a = await f.user(), b = await f.user();
  const group = await f.band(a); await f.invite(a, b);
  const other = await f.session(a, group.id);
  assert.equal((await a.client.req('/account/sessions/revoke', 'POST', {password: 'wrong'})).status, 403);
  assert.equal((await other.req('/account')).status, 200);
  assert.equal((await a.client.req('/account/sessions/revoke', 'POST', {password: originalPassword}, {Origin: 'https://outside.example.invalid'})).status, 403);
  const result = await a.client.req('/account/sessions/revoke', 'POST', {password: originalPassword});
  assert.deepEqual(result, {status: 200, value: {ok: true, revokedSessions: 1}});
  assert.equal((await other.req('/account')).status, 401);
  const exported = await a.client.req('/account/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.value.profile.email, a.email);
  assert.deepEqual(exported.value.memberships, [{bandId: group.id, name: group.name, role: 'owner', instrument: ''}]);
  assert.deepEqual(Object.keys(exported.value).sort(), ['exportedAt', 'format', 'memberships', 'profile', 'version']);
  assert.deepEqual(Object.keys(exported.value.profile).sort(), ['avatarId', 'email', 'id', 'login', 'name']);
  assert.ok(!JSON.stringify(exported.value).includes(b.email));
  assert.ok(!JSON.stringify(exported.value).includes('password'));
  assert.equal((await client().req('/account/export')).status, 401);
});

test('ownership transfer is atomic, revokes invites and checks roles under locks', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), next = await f.user(), other = await f.user();
  const group = await f.band(owner); await f.invite(owner, next);
  assert.equal((await owner.client.req('/bands/leave', 'POST', {})).status, 409);
  assert.equal((await owner.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'DELETE'})).status, 409);
  assert.equal((await owner.client.req('/bands/transfer', 'POST', {userId: other.id, password: originalPassword})).status, 404);
  assert.equal((await next.client.req('/bands/transfer', 'POST', {userId: owner.id, password: originalPassword})).status, 403);
  assert.equal((await owner.client.req('/bands/transfer', 'POST', {userId: next.id, password: 'wrong'})).status, 403);
  const invitation = await owner.client.req('/invites', 'POST', {role: 'viewer'});
  const transfers = await Promise.all([1, 2].map(() => owner.client.req('/bands/transfer', 'POST', {userId: next.id, password: originalPassword})));
  assert.deepEqual(transfers.map(result => result.status).sort(), [200, 403]);
  assert.deepEqual((await f.pool.query('SELECT "user",role FROM members WHERE band=$1 ORDER BY role', [group.id])).rows, [{user: owner.id, role: 'editor'}, {user: next.id, role: 'owner'}]);
  assert.equal((await other.client.req('/invites/join', 'POST', {token: invitation.value.token})).status, 404);
  assert.equal((await owner.client.req('/invites', 'POST', {role: 'editor'})).status, 403);
  assert.equal((await owner.client.req('/bands/leave', 'POST', {})).status, 200);
  assert.equal((await owner.client.req('/state')).value.state, null);
  assert.equal((await owner.client.req('/bands/switch', 'POST', {id: group.id})).status, 403);
});

test('opposite group departures avoid foreign-key deadlocks and retain the other membership', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), first = await f.user(), second = await f.user();
  const a = await f.band(owner); await f.invite(owner, first); await f.invite(owner, second);
  const b = await f.band(owner); await f.invite(owner, first); await f.invite(owner, second);
  assert.equal((await first.client.req('/bands/switch', 'POST', {id: a.id})).status, 200);
  const firstOtherDevice = await f.session(first, a.id), secondOtherDevice = await f.session(second, b.id);
  // Give simultaneous departures time to overlap after locking their source band.
  // This test-only trigger affects exactly these two temporary fixture accounts.
  const trigger = 'lifecycle_leave_' + randomBytes(6).toString('hex');
  await f.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD."user"=ANY(TG_ARGV) THEN PERFORM pg_sleep(0.15); END IF;
      RETURN OLD;
    END;
  $$`);
  try {
    await f.pool.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON members FOR EACH ROW EXECUTE FUNCTION ${trigger}('${first.id}','${second.id}')`);
    const results = await Promise.all([
      first.client.req('/bands/leave', 'POST', {}), second.client.req('/bands/leave', 'POST', {}),
    ]);
    assert.deepEqual(results, [
      {status: 200, value: {ok: true, bandId: b.id}},
      {status: 200, value: {ok: true, bandId: a.id}},
    ]);
    assert.equal((await firstOtherDevice.req('/account')).value.bandId, b.id);
    assert.equal((await secondOtherDevice.req('/account')).value.bandId, a.id);
    assert.deepEqual((await first.client.req('/account')).value.bands.map(band => band.id), [b.id]);
    assert.deepEqual((await second.client.req('/account')).value.bands.map(band => band.id), [a.id]);
    assert.equal((await first.client.req('/bands/switch', 'POST', {id: a.id})).status, 403);
    assert.equal((await second.client.req('/bands/switch', 'POST', {id: b.id})).status, 403);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM members WHERE band=ANY($1::text[]) AND role='owner'", [[a.id, b.id]])).rows[0].n, 2);
  } finally {
    await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON members`);
    await f.pool.query(`DROP FUNCTION ${trigger}()`);
  }
});

test('deleting a member removes personal data and preserves shared music and artwork', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), member = await f.user();
  const group = await f.band(owner); await f.invite(owner, member);
  const second = await f.session(member, group.id);
  const avatar = randomUUID(), cover = randomUUID(), file = randomUUID();
  await f.pool.query('INSERT INTO images(id,band,owner_id,size) VALUES($1,NULL,$2,1),($3,$4,NULL,1)', [avatar, member.id, cover, group.id]);
  await f.pool.query('UPDATE users SET avatar_id=$1 WHERE id=$2', [avatar, member.id]);
  await f.pool.query('INSERT INTO files(id,band,name,mime,size) VALUES($1,$2,$3,$4,1)', [file, group.id, 'score.pdf', 'application/pdf']);
  await f.pool.query('INSERT INTO rehearsal_reports(band,set_id,musician,report) VALUES($1,$2,$3,$4)', [group.id, 'personal-report', member.id, '{}']);
  await f.pool.query('INSERT INTO live_sessions(band,id,leader_user,control_hash,snapshot,position) VALUES($1,$2,$3,$4,$5,$6)', [group.id, randomUUID(), member.id, digest('control'), '{}', '{}']);
  const before = (await owner.client.req('/state')).value;
  assert.equal((await member.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'delete'})).status, 400);
  assert.equal((await member.client.req('/account', 'DELETE', {password: 'wrong', confirmation: 'DELETE'})).status, 403);
  assert.equal((await member.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'DELETE'})).status, 200);
  assert.equal((await second.req('/account')).status, 401);
  for (const [table, field] of [['users','id'], ['sessions','"user"'], ['members','"user"'], ['live_sessions','leader_user'], ['rehearsal_reports','musician'], ['images','owner_id']]) {
    assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${field}=$1`, [member.id])).rows[0].n, 0, table);
  }
  assert.equal((await f.pool.query('SELECT id FROM images WHERE id=$1', [avatar])).rowCount, 0);
  assert.equal((await f.pool.query('SELECT id FROM images WHERE id=$1', [cover])).rowCount, 1);
  assert.equal((await f.pool.query('SELECT id FROM files WHERE id=$1', [file])).rowCount, 1);
  const after = (await owner.client.req('/state')).value;
  assert.deepEqual(after.state, before.state);
  assert.equal(after.revision, before.revision);
});

test('owner can delete a confirmed group without deleting accounts or another group', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), member = await f.user();
  const retained = await f.band(owner), removed = await f.band(owner); await f.invite(owner, member);
  const memberSecond = await f.session(member, removed.id);
  assert.equal((await member.client.req('/bands/current', 'DELETE', {password: originalPassword, confirmation: removed.name})).status, 403);
  assert.equal((await owner.client.req('/bands/current', 'DELETE', {password: originalPassword, confirmation: 'wrong'})).status, 400);
  const image = await sharp({create: {width: 8, height: 8, channels: 3, background: '#548cde'}}).png().toBuffer();
  const uploaded = await fetch(base + '/api/images?kind=band', {method: 'POST', headers: {Cookie: owner.client.cookie, 'X-Revision': '1'}, body: image});
  assert.equal(uploaded.status, 201);
  const cover = (await uploaded.json()).id;
  const attachment = await fetch(base + '/api/files', {method: 'POST', headers: {Cookie: owner.client.cookie, 'X-File-Name': 'score.pdf'}, body: Buffer.from('%PDF-lifecycle-test')});
  assert.equal(attachment.status, 201);
  const file = (await attachment.json()).id;
  const result = await owner.client.req('/bands/current', 'DELETE', {password: originalPassword, confirmation: removed.name});
  assert.deepEqual(result, {status: 200, value: {ok: true, bandId: null}});
  assert.equal((await member.client.req('/account')).status, 200);
  assert.equal((await memberSecond.req('/account')).value.bandId, null);
  assert.equal((await owner.client.req('/account')).value.bandId, null);
  assert.equal((await owner.client.req('/bands/switch', 'POST', {id: retained.id})).status, 200);
  assert.equal((await f.pool.query('SELECT id FROM images WHERE id=$1', [cover])).rowCount, 0);
  assert.equal((await f.pool.query('SELECT id FROM files WHERE id=$1', [file])).rowCount, 0);
  assert.equal((await f.pool.query('SELECT id FROM account_file_cleanup WHERE id=ANY($1::text[])', [[cover, file]])).rowCount, 0);
  assert.equal((await f.pool.query('SELECT id FROM bands WHERE id=$1', [retained.id])).rowCount, 1);
});

test('account deletion races safely against group creation, invite join and ownership transfer', {skip: !base}, async t => {
  const f = await fixture(t);
  const creator = await f.user();
  const created = await Promise.all([
    creator.client.req('/bands', 'POST', {name: 'Concurrent creation'}),
    creator.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'DELETE'}),
  ]);
  if (created[0].status === 201) {
    assert.equal(created[1].status, 409); // An owner must remain after creation wins.
    const id = created[0].value.id;
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM members WHERE band=$1 AND role='owner'", [id])).rows[0].n, 1);
    assert.equal((await creator.client.req('/bands/current', 'DELETE', {password: originalPassword, confirmation: 'Concurrent creation'})).status, 200);
  } else {
    assert.equal(created[0].status, 401); assert.equal(created[1].status, 200);
  }
  const owner = await f.user(), joining = await f.user(), next = await f.user();
  const group = await f.band(owner);
  const invitation = await owner.client.req('/invites', 'POST', {role: 'editor'});
  const joined = await Promise.all([
    joining.client.req('/invites/join', 'POST', {token: invitation.value.token}),
    joining.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'DELETE'}),
  ]);
  assert.ok([200, 401].includes(joined[0].status), JSON.stringify(joined));
  assert.equal(joined[1].status, 200);
  assert.equal((await f.pool.query('SELECT "user" FROM members WHERE "user"=$1', [joining.id])).rowCount, 0);
  await f.invite(owner, next);
  const transferred = await Promise.all([
    owner.client.req('/bands/transfer', 'POST', {userId: next.id, password: originalPassword}),
    next.client.req('/account', 'DELETE', {password: originalPassword, confirmation: 'DELETE'}),
  ]);
  assert.ok((transferred[0].status === 200 && transferred[1].status === 409) || (transferred[0].status === 404 && transferred[1].status === 200), JSON.stringify(transferred));
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM members WHERE band=$1 AND role='owner'", [group.id])).rows[0].n, 1);
});

test('login and group deletion cannot leave a session referencing the deleted group', {skip: !base}, async t => {
  const f = await fixture(t), owner = await f.user(), member = await f.user();
  const group = await f.band(owner); await f.invite(owner, member);
  const signedIn = client(member.client.cookie);
  const results = await Promise.all([
    signedIn.req('/auth/login', 'POST', {identity: member.login, password: originalPassword}),
    owner.client.req('/bands/current', 'DELETE', {password: originalPassword, confirmation: group.name}),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal((await signedIn.req('/account')).value.bandId, null);
  assert.equal((await f.pool.query('SELECT token FROM sessions WHERE band=$1', [group.id])).rowCount, 0);
});

test('sensitive action throttling is persisted in PostgreSQL', {skip: !base}, async t => {
  const f = await fixture(t), a = await f.user();
  const key = digest('account-sensitive-user:' + a.id);
  await f.pool.query('INSERT INTO auth_limits(key,count,expires) VALUES($1,15,$2)', [key, Date.now() + 300000]);
  assert.equal((await a.client.req('/account/sessions/revoke', 'POST', {password: originalPassword})).status, 429);
  assert.equal((await a.client.req('/account')).status, 200);
  await f.pool.query('DELETE FROM auth_limits WHERE key=$1', [key]);
});

test('file cleanup retries errors and never follows arbitrary queue paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'psalmony-cleanup-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, 'images')); await mkdir(join(dir, 'files'));
  const id = randomUUID(), unrelated = randomUUID();
  await writeFile(join(dir, 'images', id), 'avatar');
  await writeFile(join(dir, 'images', unrelated), 'unrelated');
  const entries = [{kind: 'images', id}, {kind: 'images', id: '../../outside'}], operations = [];
  const pool = {async query(sql, args) {
    if (sql.startsWith('SELECT')) return {rows: [...entries]};
    operations.push({sql, args});
    if (sql.startsWith('DELETE')) entries.splice(entries.findIndex(row => row.kind === args[0] && row.id === args[1]), 1);
    return {rows: []};
  }};
  const failed = createAccountFileCleanup({pool, data: dir, unlinkFile: async () => {throw Object.assign(new Error('locked'), {code: 'EACCES'});}});
  await failed();
  assert.equal(entries.length, 2);
  assert.equal(operations.length, 1);
  assert.match(operations[0].sql, /attempts=attempts\+1/);
  await createAccountFileCleanup({pool, data: dir})();
  assert.deepEqual(entries, [{kind: 'images', id: '../../outside'}]);
  assert.equal(await readFile(join(dir, 'images', unrelated), 'utf8'), 'unrelated');
  await assert.rejects(readFile(join(dir, 'images', id)), {code: 'ENOENT'});
});
