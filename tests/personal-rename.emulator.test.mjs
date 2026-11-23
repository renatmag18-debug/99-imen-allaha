import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { createProgressHandler } from '../personal-progress.mjs';
import { createSafeRename } from '../personal-rename.mjs';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

// Hard-coded loopback and demo namespace: this test cannot touch live Firebase.
const base = 'http://127.0.0.1:19001';
const namespace = 'demo-ism99';
const secret = Buffer.alloc(32, 7).toString('base64');
const env = { PERSONAL_PROGRESS_KEY: secret };
const prefix = 't' + randomUUID().replaceAll('-', '');
const oldName = prefix + 'old';
const newName = prefix + 'new';
const userPath = name => `/users/${encodeURIComponent(name)}.json`;
const fetchDb = (path, _, options = {}) => fetch(base + path + '?ns=' + namespace, options);
const deps = {
  userKey: value => value.trim().toLowerCase(), b64EncodeUtf8: value => btoa(value),
  hasForbiddenKeyChars: value => /[.#$\[\]]/.test(value), rtdbFetch: fetchDb,
  reply: (body, status) => ({ body, status }), finishReferences: async () => {},
};
const progress = createProgressHandler(deps);
const rename = createSafeRename(deps);
const empty = { version: 1, ayahs: ['1:1'], qada: null };
const changed = { version: 1, ayahs: ['1:1', '2:2'], qada: null };
async function putUser(name, user) {
  const res = await fetchDb(userPath(name), env, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) });
  assert.equal(res.ok, true);
}
async function readUser(name) { const res = await fetchDb(userPath(name), env); assert.equal(res.ok, true); return res.json(); }

test('actual RTDB ETags prevent a stale backup from overwriting a renamed account', async () => {
  await putUser(oldName, { username: oldName, password: btoa('secret') });
  try {
    const credentials = { username: oldName, password: 'secret' };
    const first = await progress({ ...credentials, action: 'write', revision: null, snapshot: empty }, env);
    assert.equal(first.status, 200);
    let release; const gate = new Promise(resolve => { release = resolve; });
    let signal; const blocked = new Promise(resolve => { signal = resolve; });
    let once = false;
    const delayedFetch = async (path, e, options = {}) => {
      if (!once && path === userPath(oldName) && options.method === 'PUT') {
        const body = JSON.parse(options.body);
        if (body.personalProgressV1 && !body.personalProgressRenameLock) { once = true; signal(); await gate; }
      }
      return fetchDb(path, e, options);
    };
    const delayedProgress = createProgressHandler({ ...deps, rtdbFetch: delayedFetch });
    const inFlight = delayedProgress({ ...credentials, action: 'write', revision: first.body.revision, snapshot: changed }, env);
    await blocked;
    const moved = await rename({ ...credentials, newUsername: newName }, env);
    assert.equal(moved.status, 200);
    release();
    assert.equal((await inFlight).status, 409);
    const read = await progress({ username: newName, password: 'secret', action: 'read' }, env);
    assert.deepEqual(read.body.progress.snapshot, empty);
    assert.equal(read.body.accountId, first.body.accountId);
    assert.equal(await readUser(oldName), null);
  } finally {
    await fetchDb(userPath(oldName), env, { method: 'DELETE' });
    await fetchDb(userPath(newName), env, { method: 'DELETE' });
  }
});

test('a simultaneous source update cancels the move and preserves the newer record', async () => {
  await putUser(oldName, { username: oldName, password: btoa('secret'), stats: { count: 1 } });
  let once = false;
  try {
    const racingFetch = async (path, e, options = {}) => {
      if (!once && path === userPath(oldName) && options.method === 'DELETE') {
        once = true;
        const patch = await fetchDb(userPath(oldName), env, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stats: { count: 2 } }) });
        assert.equal(patch.ok, true);
      }
      return fetchDb(path, e, options);
    };
    const racingRename = createSafeRename({ ...deps, rtdbFetch: racingFetch });
    assert.equal((await racingRename({ username: oldName, password: 'secret', newUsername: newName }, env)).status, 409);
    assert.equal((await readUser(oldName)).stats.count, 2);
    assert.equal(await readUser(newName), null);
  } finally {
    await fetchDb(userPath(oldName), env, { method: 'DELETE' });
    await fetchDb(userPath(newName), env, { method: 'DELETE' });
  }
});
