// Firebase's conditional PUT/DELETE operate on one path. Freeze the source and
// destination during the move, and keep both copies if anything is uncertain.
const LOCK = 'personalProgressRenameLock';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function createSafeRename({ userKey, b64EncodeUtf8, hasForbiddenKeyChars, rtdbFetch, reply, finishReferences }) {
  const pathFor = key => `/users/${encodeURIComponent(key)}.json`;
  async function read(key, env) {
    const res = await rtdbFetch(pathFor(key), env, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' } });
    if (!res.ok || !res.headers.get('ETag')) throw new Error('storage unavailable');
    return { user: await res.json(), etag: res.headers.get('ETag') };
  }
  async function put(key, value, etag, env) {
    return rtdbFetch(pathFor(key), env, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag }, body: JSON.stringify(value) });
  }
  async function remove(key, etag, env) {
    return rtdbFetch(pathFor(key), env, { method: 'DELETE', headers: { 'if-match': etag } });
  }
  async function unlock(key, token, env) {
    for (let i = 0; i < 5; i++) {
      const current = await read(key, env);
      if (!current.user || current.user[LOCK]?.id !== token) return false;
      const next = { ...current.user }; delete next[LOCK];
      const result = await put(key, next, current.etag, env);
      if (result.ok) return true;
      if (result.status !== 412) return false;
    }
    return false;
  }
  async function cleanupTarget(key, expected, token, env) {
    const target = await read(key, env);
    if (!target.user) return true;
    if (target.user[LOCK]?.id !== token || canonical(target.user) !== canonical(expected)) return false;
    return (await remove(key, target.etag, env)).ok;
  }
  async function finish(oldKey, newKey, displayName, user, lock, env) {
    // Keep the destination frozen until all cross references are repaired.
    await finishReferences(oldKey, newKey, displayName, user, env);
    if (!await unlock(newKey, lock.id, env)) return reply({ error: 'rename pending; retry with original nickname' }, 503);
    return reply({ ok: true, username: displayName }, 200);
  }
  return async function safeRename(body, env) {
    const { username, password, newUsername } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || typeof newUsername !== 'string' || !username || !password || !newUsername) return reply({ error: 'missing data' }, 400);
    const displayName = newUsername.trim();
    if (displayName.length < 3) return reply({ error: 'username must be at least 3 chars' }, 400);
    if (hasForbiddenKeyChars(displayName) || displayName.includes('/')) return reply({ error: 'username contains invalid characters' }, 400);
    const oldKey = userKey(username), newKey = userKey(displayName);
    if (!oldKey || /[.#$\[\]\/]/.test(oldKey)) return reply({ error: 'invalid auth' }, 401);
    try {
      let source = await read(oldKey, env);
      if (!source.user) {
        // Recovery after a crash between source deletion and final unlock.
        if (oldKey === newKey) return reply({ error: 'invalid auth' }, 401);
        const destination = await read(newKey, env);
        const lock = destination.user?.[LOCK];
        if (!lock || lock.from !== oldKey || lock.to !== newKey || lock.displayName !== displayName || destination.user.password !== b64EncodeUtf8(password)) return reply({ error: 'invalid auth' }, 401);
        return await finish(oldKey, newKey, displayName, destination.user, lock, env);
      }
      if (source.user.password !== b64EncodeUtf8(password)) return reply({ error: 'invalid auth' }, 401);
      if (oldKey === newKey) {
        if (source.user[LOCK]) return reply({ error: 'account rename in progress' }, 409);
        const result = await put(oldKey, { ...source.user, username: displayName }, source.etag, env);
        return result.ok ? reply({ ok: true, username: displayName }, 200) : reply({ error: 'account changed; retry' }, 409);
      }
      let lock = source.user[LOCK];
      if (lock && (lock.from !== oldKey || lock.to !== newKey || lock.displayName !== displayName || typeof lock.id !== 'string')) return reply({ error: 'another account rename is in progress' }, 409);
      if (!lock) {
        lock = { id: crypto.randomUUID(), from: oldKey, to: newKey, displayName };
        const locked = await put(oldKey, { ...source.user, [LOCK]: lock }, source.etag, env);
        if (!locked.ok) return reply({ error: 'account changed; retry' }, locked.status === 412 ? 409 : 503);
        source = await read(oldKey, env);
        if (!source.user || source.user[LOCK]?.id !== lock.id) return reply({ error: 'rename pending; retry' }, 503);
      }
      const expected = { ...source.user, username: displayName };
      let target = await read(newKey, env);
      if (target.user === null) {
        const created = await put(newKey, expected, target.etag, env);
        if (!created.ok && created.status !== 412) return reply({ error: 'rename pending; retry' }, 503);
        target = await read(newKey, env);
      }
      if (!target.user || target.user[LOCK]?.id !== lock.id) {
        if (!await unlock(oldKey, lock.id, env)) return reply({ error: 'rename pending; retry' }, 503);
        return reply({ error: 'username already taken' }, 409);
      }
      // If either copy has changed, retain both and keep sync frozen. Never
      // overwrite or delete a destination that may contain newer edits.
      if (canonical(target.user) !== canonical(expected)) return reply({ error: 'rename requires recovery; data preserved' }, 409);
      const deleted = await remove(oldKey, source.etag, env);
      if (!deleted.ok) {
        const current = await read(oldKey, env);
        if (!current.user) return await finish(oldKey, newKey, displayName, target.user, lock, env);
        if (current.user[LOCK]?.id !== lock.id) return reply({ error: 'rename requires recovery; data preserved' }, 409);
        if (!await cleanupTarget(newKey, expected, lock.id, env)) return reply({ error: 'rename requires recovery; data preserved' }, 409);
        if (!await unlock(oldKey, lock.id, env)) return reply({ error: 'rename pending; retry' }, 503);
        return reply({ error: 'account changed; retry' }, 409);
      }
      return await finish(oldKey, newKey, displayName, target.user, lock, env);
    } catch (_) {
      // Lock and data remain for a retry; do not claim the operation succeeded.
      return reply({ error: 'rename pending; retry with original nickname' }, 503);
    }
  };
}
