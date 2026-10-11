import {unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';

// All authenticated mutations acquire user rows before rechecking the session and band.
// Multi-user operations must acquire the complete, sorted user set at once.
export function createAccountGuard({q, all, fail}) {
  return async function lockAccount(s, {band = false, userIds = []} = {}) {
    const ids = [...new Set([s.user, ...userIds])].sort();
    const users = await all('SELECT * FROM users WHERE id=ANY(?::text[]) ORDER BY id FOR UPDATE', ids);
    const user = users.find(user => user.id === s.user);
    if (!user || user.guest) fail(401, 'Войдите в аккаунт');
    const current = await q('SELECT * FROM sessions WHERE token=? AND user=? AND expires>?', s.token, s.user, Date.now());
    if (!current) fail(401, 'Сессия завершена. Войдите снова');
    if (band && current.band !== s.band) fail(409, 'Активная группа изменилась. Обновите страницу');
    if (band) {
      if (!current.band || !await q('SELECT id FROM bands WHERE id=? FOR UPDATE', current.band)) fail(403, 'Нет доступа к группе');
    }
    const member = current.band ? await q('SELECT role FROM members WHERE band=? AND user=?', current.band, s.user) : null;
    if (band && !member) fail(403, 'Нет доступа к группе');
    return {...s, ...current, name: user.name, email: user.email, login: user.login, avatar_id: user.avatar_id, guest: user.guest, role: member?.role, password: user.password};
  };
}

export async function accountLifecycleSchema(pool) {
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS members_single_owner ON members(band) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS account_file_cleanup(
      kind TEXT NOT NULL CHECK(kind IN ('images','files')),
      id TEXT NOT NULL,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(kind,id)
    );
  `);
}

// The queue is committed with account deletion. Only exact, generated attachment IDs
// may become paths; unrelated files and artwork are never swept.
export function createAccountFileCleanup({pool, data, unlinkFile = unlink}) {
  const dir = resolve(data);
  let pending;
  return function cleanup() {
    if (pending) return pending;
    pending = (async () => {
      const {rows} = await pool.query(`SELECT c.kind,c.id FROM account_file_cleanup c
        WHERE c.next_attempt<=now() AND NOT EXISTS(SELECT 1 FROM images i WHERE c.kind='images' AND i.id=c.id)
          AND NOT EXISTS(SELECT 1 FROM files f WHERE c.kind='files' AND f.id=c.id)
        ORDER BY c.queued_at LIMIT 100`);
      for (const {kind, id} of rows) {
        if (!['images','files'].includes(kind) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
        try {
          await unlinkFile(join(dir, kind, id));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            await pool.query(`UPDATE account_file_cleanup SET attempts=attempts+1,
              next_attempt=now()+interval '1 minute' WHERE kind=$1 AND id=$2`, [kind, id]);
            continue;
          }
        }
        await pool.query('DELETE FROM account_file_cleanup WHERE kind=$1 AND id=$2', [kind, id]);
      }
    })().finally(() => {pending = undefined;});
    return pending;
  };
}

export function accountLifecycleHandlers({pool, data, q, all, run, transaction, need, json, send, fail, cookie, password, matches, limit, ip, lockAccount}) {
  const cleanup = createAccountFileCleanup({pool, data});
  const cleanupSafely = () => cleanup().catch(error => console.error('Account file cleanup failed:', error.code || 'database error'));
  void cleanupSafely();
  setInterval(cleanupSafely, 60000).unref();
  async function sensitive(req, s) {
    await limit('account-sensitive-ip:' + ip(req), 60, 300000);
    await limit('account-sensitive-user:' + s.user, 15, 300000);
  }
  async function checkPassword(value, encoded) {
    if (!await matches(value, encoded)) fail(403, 'Текущий пароль неверный');
  }
  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/account/password' && req.method === 'POST') {
      const s = await need(req, false), b = await json(req);
      await sensitive(req, s);
      const revokedSessions = await transaction(async () => {
        const current = await lockAccount(s);
        await checkPassword(b.currentPassword, current.password);
        const encoded = await password(b.newPassword);
        await run('UPDATE users SET password=? WHERE id=?', encoded, s.user);
        return (await run('DELETE FROM sessions WHERE user=? AND token<>?', s.user, s.token)).rowCount;
      });
      return send(res, 200, {ok: true, revokedSessions});
    }
    if (p === '/api/account/sessions/revoke' && req.method === 'POST') {
      const s = await need(req, false), b = await json(req);
      await sensitive(req, s);
      const revokedSessions = await transaction(async () => {
        const current = await lockAccount(s);
        await checkPassword(b.password, current.password);
        return (await run('DELETE FROM sessions WHERE user=? AND token<>?', s.user, s.token)).rowCount;
      });
      return send(res, 200, {ok: true, revokedSessions});
    }
    if (p === '/api/account/export' && req.method === 'GET') {
      const s = await need(req, false);
      await limit('account-export:' + s.user, 20);
      const exported = await transaction(async () => {
        const current = await lockAccount(s);
        return {
          format: 'psalmony-account', version: 1, exportedAt: new Date().toISOString(),
          profile: {id: current.user, login: current.login, email: current.email, name: current.name, avatarId: current.avatar_id},
          memberships: await all(`SELECT m.band AS "bandId", b.state->>'bandName' AS name, m.role, m.instrument
            FROM members m JOIN bands b ON b.id=m.band WHERE m.user=? ORDER BY m.band`, current.user),
        };
      });
      res.setHeader('Content-Disposition', 'attachment; filename="psalmony-account.json"');
      return send(res, 200, exported);
    }
    if (p === '/api/bands/leave' && req.method === 'POST') {
      const s = await need(req); await json(req);
      const bandId = await transaction(async () => {
        const current = await lockAccount(s);
        if (current.band !== s.band) fail(409, 'Активная группа изменилась. Обновите страницу');
        const candidate = (await q('SELECT band FROM members WHERE user=? AND band<>? ORDER BY band LIMIT 1', current.user, current.band))?.band || null;
        // Updating sessions.band also takes a foreign-key lock on the destination.
        // Acquire both bands in order before either mutation to avoid A -> B / B -> A deadlocks.
        const bands = await all('SELECT id FROM bands WHERE id=ANY(?::text[]) ORDER BY id FOR UPDATE', [current.band, candidate].filter(Boolean));
        if (!current.band || !bands.some(band => band.id === current.band)) fail(403, 'Нет доступа к группе');
        const member = await q('SELECT role FROM members WHERE band=? AND user=?', current.band, current.user);
        if (!member) fail(403, 'Нет доступа к группе');
        if (member.role === 'owner') fail(409, 'Сначала передайте владение группой другому участнику');
        const next = candidate && await q('SELECT 1 FROM members WHERE band=? AND user=?', candidate, current.user) ? candidate : null;
        await run('DELETE FROM live_sessions WHERE band=? AND leader_user=?', current.band, current.user);
        await run('DELETE FROM rehearsal_reports WHERE band=? AND musician=?', current.band, current.user);
        await run('DELETE FROM members WHERE band=? AND user=?', current.band, current.user);
        await run('UPDATE sessions SET band=? WHERE user=? AND band=?', next, current.user, current.band);
        return next;
      });
      return send(res, 200, {ok: true, bandId});
    }
    if (p === '/api/bands/transfer' && req.method === 'POST') {
      const s = await need(req), b = await json(req);
      await sensitive(req, s);
      if (typeof b.userId !== 'string' || !b.userId || b.userId.length > 100 || b.userId === s.user) fail(400, 'Выберите другого участника группы');
      await transaction(async () => {
        const current = await lockAccount(s, {band: true, userIds: [b.userId]});
        if (current.role !== 'owner') fail(403, 'Действие доступно владельцу группы');
        await checkPassword(b.password, current.password);
        if (!await q('SELECT 1 FROM members WHERE band=? AND user=?', current.band, b.userId)) fail(404, 'Участник не найден в этой группе');
        await run("UPDATE members SET role='editor' WHERE band=? AND user=?", current.band, current.user);
        await run("UPDATE members SET role='owner' WHERE band=? AND user=?", current.band, b.userId);
        await run('DELETE FROM invites WHERE band=?', current.band);
      });
      return send(res, 200, {ok: true});
    }
    if (p === '/api/bands/current' && req.method === 'DELETE') {
      const s = await need(req), b = await json(req);
      await sensitive(req, s);
      await transaction(async () => {
        const current = await lockAccount(s, {band: true});
        if (current.role !== 'owner') fail(403, 'Действие доступно владельцу группы');
        await checkPassword(b.password, current.password);
        const band = await q('SELECT state FROM bands WHERE id=?', current.band);
        if (typeof b.confirmation !== 'string' || b.confirmation !== band.state.bandName) fail(400, 'Для удаления введите точное название группы');
        await run("INSERT INTO account_file_cleanup(kind,id) SELECT 'images',id FROM images WHERE band=? ON CONFLICT(kind,id) DO NOTHING", current.band);
        await run("INSERT INTO account_file_cleanup(kind,id) SELECT 'files',id FROM files WHERE band=? ON CONFLICT(kind,id) DO NOTHING", current.band);
        await run('UPDATE sessions SET band=NULL WHERE band=?', current.band);
        await run('DELETE FROM invites WHERE band=?', current.band);
        await run('DELETE FROM files WHERE band=?', current.band);
        await run('DELETE FROM members WHERE band=?', current.band);
        await run('DELETE FROM bands WHERE id=?', current.band);
      });
      await cleanupSafely();
      return send(res, 200, {ok: true, bandId: null});
    }
    if (p === '/api/account' && req.method === 'DELETE') {
      const s = await need(req, false), b = await json(req);
      await sensitive(req, s);
      if (b.confirmation !== 'DELETE') fail(400, 'Для удаления введите DELETE');
      await transaction(async () => {
        const current = await lockAccount(s);
        await checkPassword(b.password, current.password);
        // Joining, creating and transferring groups also lock this user first.
        // Lock every membership band in stable order before deleting dependent data.
        await all('SELECT id FROM bands WHERE id IN (SELECT band FROM members WHERE user=?) ORDER BY id FOR UPDATE', current.user);
        if (await q("SELECT 1 FROM members WHERE user=? AND role='owner' LIMIT 1", current.user)) fail(409, 'Сначала передайте владение всеми своими группами');
        await run("INSERT INTO account_file_cleanup(kind,id) SELECT 'images',id FROM images WHERE owner_id=? AND band IS NULL ON CONFLICT(kind,id) DO NOTHING", current.user);
        await run('DELETE FROM images WHERE owner_id=? AND band IS NULL', current.user);
        // Preserve shared artwork even if an older row also had an owner_id.
        await run('UPDATE images SET owner_id=NULL WHERE owner_id=? AND band IS NOT NULL', current.user);
        await run('DELETE FROM live_sessions WHERE leader_user=?', current.user);
        await run('DELETE FROM rehearsal_reports WHERE musician=?', current.user);
        await run('DELETE FROM members WHERE user=?', current.user);
        await run('DELETE FROM sessions WHERE user=?', current.user);
        await run('DELETE FROM users WHERE id=?', current.user);
      });
      cookie(res, '', 0);
      await cleanupSafely();
      return send(res, 200, {ok: true});
    }
    return false;
  };
}
