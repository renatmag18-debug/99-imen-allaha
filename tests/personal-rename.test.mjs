import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSafeRename } from '../personal-rename.mjs';
import { createProgressHandler } from '../personal-progress.mjs';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

function fakeDb() {
  const entries = new Map(); let counter = 0; let hook = null; let failRefs = false;
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const insert = (key, value) => entries.set(key, { value: clone(value), etag: '"' + (++counter) + '"' });
  insert('old', { username: 'old', password: btoa('secret'), personalProgressV1: { revision: 'old-saved-progress' }, stats: { n: 1 } });
  const fetchDb = async (path, env, options) => {
    const key = decodeURIComponent(path.match(/^\/users\/(.+)\.json$/)[1]);
    if (hook) await hook({ key, options, insert, entries });
    const cur = entries.get(key) || { value: null, etag: '"0"' };
    if (options.method === 'GET') return new Response(JSON.stringify(cur.value), { status: 200, headers: { ETag: cur.etag } });
    if (options.headers?.['if-match'] !== cur.etag) return new Response(null, { status: 412 });
    if (options.method === 'DELETE') { entries.delete(key); return new Response('null', { status: 200 }); }
    if (options.method === 'PUT') { insert(key, JSON.parse(options.body)); return new Response('null', { status: 200 }); }
    throw new Error('unexpected request');
  };
  const dependencies = {
    userKey: s => s.trim().toLowerCase(), b64EncodeUtf8: s => btoa(s),
    hasForbiddenKeyChars: s => /[.#$\[\]]/.test(s), rtdbFetch: fetchDb,
    reply: (body, status) => ({ status, body }),
    finishReferences: async () => { if (failRefs) throw new Error('offline'); },
  };
  return { entries, insert, fetchDb, dependencies, rename: createSafeRename(dependencies), setHook: value => { hook = value; }, setRefsFail: value => { failRefs = value; } };
}
const request = { username: 'old', password: 'secret', newUsername: 'new' };

test('moves the latest saved data and clears the lock', async () => {
  const db = fakeDb();
  const result = await db.rename(request, {});
  assert.equal(result.status, 200);
  assert.equal(db.entries.has('old'), false);
  assert.equal(db.entries.get('new').value.personalProgressV1.revision, 'old-saved-progress');
  assert.equal(db.entries.get('new').value.personalProgressRenameLock, undefined);
});
test('a backup saved before the lock invalidates stale rename data', async () => {
  const db = fakeDb(); let once = false;
  db.setHook(({ key, options, insert, entries }) => {
    if (!once && key === 'old' && options.method === 'PUT') {
      once = true; const value = structuredClone(entries.get('old').value);
      value.personalProgressV1.revision = 'newer'; insert('old', value);
    }
  });
  const result = await db.rename(request, {});
  assert.equal(result.status, 409);
  assert.equal(db.entries.get('old').value.personalProgressV1.revision, 'newer');
  assert.equal(db.entries.has('new'), false);
});
test('backup reads and writes are blocked while a rename is frozen', async () => {
  const db = fakeDb(); let ran = false;
  const progress = createProgressHandler({ ...db.dependencies });
  db.setHook(async ({ key, options }) => {
    if (!ran && key === 'new' && options.method === 'PUT') {
      ran = true;
      const result = await progress({ username: 'old', password: 'secret', action: 'read' }, {});
      assert.equal(result.status, 409);
    }
  });
  assert.equal((await db.rename(request, {})).status, 200);
});
test('an in-flight backup cannot write to the old nickname after rename starts', async () => {
  const db = fakeDb();
  db.insert('old', { username: 'old', password: btoa('secret') });
  const env = { PERSONAL_PROGRESS_KEY: Buffer.alloc(32, 7).toString('base64') };
  const progress = createProgressHandler({ ...db.dependencies });
  const original = { version: 1, ayahs: ['1:1'], qada: null };
  const changed = { version: 1, ayahs: ['1:1', '2:2'], qada: null };
  const first = await progress({ ...request, action: 'write', revision: null, snapshot: original }, env);
  assert.equal(first.status, 200);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let signal; const blocked = new Promise(resolve => { signal = resolve; });
  let once = false;
  db.setHook(async ({ key, options }) => {
    if (once || key !== 'old' || options.method !== 'PUT') return;
    const candidate = JSON.parse(options.body);
    if (candidate.personalProgressV1 && !candidate.personalProgressRenameLock) {
      once = true; signal(); await gate;
    }
  });
  const inFlight = progress({ ...request, action: 'write', revision: first.body.revision, snapshot: changed }, env);
  await blocked;
  assert.equal((await db.rename(request, env)).status, 200);
  release();
  assert.equal((await inFlight).status, 409);
  const restored = await progress({ username: 'new', password: 'secret', action: 'read' }, env);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.progress.snapshot, original);
  assert.equal(db.entries.has('old'), false);
});
test('an unrelated late update prevents deletion and both latest data and original name survive', async () => {
  const db = fakeDb(); let once = false;
  db.setHook(({ key, options, insert, entries }) => {
    if (!once && key === 'old' && options.method === 'DELETE') {
      once = true; const value = structuredClone(entries.get('old').value); value.stats.n = 2; insert('old', value);
    }
  });
  const result = await db.rename(request, {});
  assert.equal(result.status, 409);
  assert.equal(db.entries.get('old').value.stats.n, 2);
  assert.equal(db.entries.get('old').value.personalProgressV1.revision, 'old-saved-progress');
  assert.equal(db.entries.has('new'), false);
  assert.equal(db.entries.get('old').value.personalProgressRenameLock, undefined);
});
test('if the new copy changed, neither copy is deleted', async () => {
  const db = fakeDb(); let once = false;
  db.setHook(({ key, options, insert, entries }) => {
    if (!once && key === 'old' && options.method === 'DELETE') {
      once = true; const a = structuredClone(entries.get('old').value); a.stats.n = 2; insert('old', a);
      const b = structuredClone(entries.get('new').value); b.stats.n = 3; insert('new', b);
    }
  });
  const result = await db.rename(request, {});
  assert.equal(result.status, 409);
  assert.equal(db.entries.get('old').value.stats.n, 2);
  assert.equal(db.entries.get('new').value.stats.n, 3);
});
test('resumes after interrupted references without losing the migrated progress', async () => {
  const db = fakeDb(); db.setRefsFail(true);
  assert.equal((await db.rename(request, {})).status, 503);
  assert.equal(db.entries.has('old'), false);
  assert.ok(db.entries.get('new').value.personalProgressRenameLock);
  db.setRefsFail(false);
  assert.equal((await db.rename(request, {})).status, 200);
  assert.equal(db.entries.get('new').value.personalProgressV1.revision, 'old-saved-progress');
  assert.equal(db.entries.get('new').value.personalProgressRenameLock, undefined);
});
test('resumes safely if connection drops just after creating the destination', async () => {
  const db = fakeDb(); let once = false;
  db.setHook(({ key, options, entries }) => {
    if (!once && key === 'new' && options.method === 'GET' && entries.has('new')) {
      once = true; throw new Error('connection lost');
    }
  });
  assert.equal((await db.rename(request, {})).status, 503);
  assert.ok(db.entries.get('old').value.personalProgressRenameLock);
  assert.ok(db.entries.get('new').value.personalProgressRenameLock);
  db.setHook(null);
  assert.equal((await db.rename(request, {})).status, 200);
  assert.equal(db.entries.has('old'), false);
  assert.equal(db.entries.get('new').value.personalProgressV1.revision, 'old-saved-progress');
});
test('a case-only change preserves progress without creating a second account', async () => {
  const db = fakeDb();
  assert.equal((await db.rename({ ...request, newUsername: 'Old' }, {})).status, 200);
  assert.equal(db.entries.get('old').value.username, 'Old');
  assert.equal(db.entries.get('old').value.personalProgressV1.revision, 'old-saved-progress');
  assert.equal(db.entries.has('new'), false);
});
test('existing nickname is never overwritten', async () => {
  const db = fakeDb(); db.insert('new', { username: 'new', password: btoa('other') });
  assert.equal((await db.rename(request, {})).status, 409);
  assert.equal(db.entries.get('new').value.password, btoa('other'));
  assert.equal(db.entries.get('old').value.personalProgressRenameLock, undefined);
});
test('concurrent requests for two different nicknames cannot duplicate or lose progress', async () => {
  const db = fakeDb();
  const results = await Promise.all([
    db.rename({ ...request, newUsername: 'new' }, {}),
    db.rename({ ...request, newUsername: 'other' }, {}),
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const records = [...db.entries.values()].filter(entry => entry.value?.personalProgressV1);
  assert.equal(records.length, 1);
  assert.equal(records[0].value.personalProgressV1.revision, 'old-saved-progress');
});
