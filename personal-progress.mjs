const MAX_AYAHS = 6236;
const MAX_ENTRIES = 20000;
const MAX_COUNT = 1000000;
const MAX_BODY = 2_000_000;

export function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.version !== 1) return false;
  const { ayahs, qada } = snapshot;
  if (!Array.isArray(ayahs) || ayahs.length > MAX_AYAHS || new Set(ayahs).size !== ayahs.length) return false;
  if (!ayahs.every(key => typeof key === 'string' && /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/.test(key) && Number(key.split(':')[0]) <= 114 && Number(key.split(':')[1]) <= 286)) return false;
  if (qada === null) return true;
  if (!qada || typeof qada !== 'object' || Array.isArray(qada) || qada.version !== 1 || typeof qada.hasPlan !== 'boolean') return false;
  const countsOk = counts => Array.isArray(counts) && counts.length === 5 && counts.every(n => Number.isInteger(n) && n >= 0 && n <= MAX_COUNT);
  if (!countsOk(qada.totals) || !Array.isArray(qada.entries) || qada.entries.length > MAX_ENTRIES) return false;
  const ids = new Set();
  const totals = [0, 0, 0, 0, 0];
  for (const entry of qada.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length < 1 || entry.id.length > 128 || ids.has(entry.id)) return false;
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !countsOk(entry.counts) || !entry.counts.some(n => n > 0)) return false;
    const parsedDate = new Date(entry.date + 'T00:00:00.000Z');
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== entry.date) return false;
    ids.add(entry.id);
    for (let i = 0; i < 5; i++) { totals[i] += entry.counts[i]; if (totals[i] > qada.totals[i]) return false; }
  }
  return qada.hasPlan || (qada.totals.every(n => n === 0) && qada.entries.length === 0);
}

function bytesToBase64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function base64ToBytes(value) { return Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
async function encryptionKey(env) {
  if (typeof env.PERSONAL_PROGRESS_KEY !== 'string') throw new Error('missing key');
  const raw = base64ToBytes(env.PERSONAL_PROGRESS_KEY);
  if (raw.length !== 32) throw new Error('invalid key');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encrypt(key, context, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { version: 1, context, revision: crypto.randomUUID(), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}
async function decrypt(key, record) {
  if (!record || record.version !== 1 || typeof record.context !== 'string' || typeof record.revision !== 'string' || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') throw new Error('invalid record');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv), additionalData: new TextEncoder().encode(record.context) }, key, base64ToBytes(record.ciphertext));
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext));
  if (!validSnapshot(snapshot)) throw new Error('invalid snapshot');
  return snapshot;
}

export function createProgressHandler({ userKey, b64EncodeUtf8, rtdbFetch, reply }) {
  return async function handlePersonalProgress(body, env) {
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) return reply({ error: 'missing auth' }, 401);
    const username = userKey(body.username);
    if (!username || /[.#$\[\]\/]/.test(username)) return reply({ error: 'invalid auth' }, 401);
    const path = `/users/${encodeURIComponent(username)}.json`;
    let response = await rtdbFetch(path, env, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' } });
    if (!response.ok) return reply({ error: 'storage unavailable' }, 503);
    let etag = response.headers.get('ETag');
    if (!etag) return reply({ error: 'storage unavailable' }, 503);
    let user;
    try { user = await response.json(); } catch (_) { return reply({ error: 'storage unavailable' }, 503); }
    if (!user || user.password !== b64EncodeUtf8(body.password)) return reply({ error: 'invalid auth' }, 401);
    // A rename freezes both names until the move is finished. In-flight writes
    // that read before the freeze fail their parent-record ETag check.
    if (user.personalProgressRenameLock) return reply({ error: 'account rename in progress' }, 409);
    let key;
    try { key = await encryptionKey(env); } catch (_) { return reply({ error: 'personal progress unavailable' }, 503); }
    if (body.action !== 'read' && body.action !== 'write') return reply({ error: 'invalid action' }, 400);
    if (body.action === 'write' && (!validSnapshot(body.snapshot) || JSON.stringify(body.snapshot).length > MAX_BODY || typeof body.accountId !== 'string' || !(body.revision === null || typeof body.revision === 'string'))) return reply({ error: 'invalid progress data' }, 400);
    // A permanent account identifier follows the record across nickname moves.
    // It is established by compare-and-swap, never derived from the nickname.
    if (user.personalAccountId == null) {
      // The caller must read and bind the identity before attempting a write.
      if (body.action === 'write') return reply({ error: 'account changed; retry' }, 409);
      const assignedId = crypto.randomUUID();
      const assigned = await rtdbFetch(path, env, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag }, body: JSON.stringify({ ...user, personalAccountId: assignedId }) });
      if (assigned.status === 412) return reply({ error: 'account changed; retry' }, 409);
      if (!assigned.ok) return reply({ error: 'storage unavailable' }, 503);
      response = await rtdbFetch(path, env, { method: 'GET', headers: { 'X-Firebase-ETag': 'true' } });
      if (!response.ok || !response.headers.get('ETag')) return reply({ error: 'storage unavailable' }, 503);
      etag = response.headers.get('ETag');
      try { user = await response.json(); } catch (_) { return reply({ error: 'storage unavailable' }, 503); }
      if (!user || user.password !== b64EncodeUtf8(body.password) || user.personalAccountId !== assignedId || user.personalProgressRenameLock) return reply({ error: 'account changed; retry' }, 409);
    }
    if (typeof user.personalAccountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.personalAccountId)) return reply({ error: 'invalid account identity' }, 503);
    if (body.action === 'write' && body.accountId !== user.personalAccountId) return reply({ error: 'account changed; retry' }, 409);
    const old = user.personalProgressV1 ?? null;
    let current = null;
    try { if (old !== null) current = { revision: old.revision, snapshot: await decrypt(key, old) }; }
    catch (_) { return reply({ error: 'progress cannot be decrypted' }, 503); }
    if (body.action === 'read') return reply({ accountId: user.personalAccountId, progress: current }, 200);
    if ((current?.revision ?? null) !== body.revision) return reply({ error: 'progress conflict', accountId: user.personalAccountId, progress: current }, 409);
    const record = await encrypt(key, old?.context || crypto.randomUUID(), body.snapshot);
    const put = await rtdbFetch(path, env, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag }, body: JSON.stringify({ ...user, personalProgressV1: record }) });
    if (put.status === 412) return reply({ error: 'progress conflict' }, 409);
    if (!put.ok) return reply({ error: 'storage unavailable' }, 503);
    return reply({ accountId: user.personalAccountId, revision: record.revision }, 200);
  };
}
