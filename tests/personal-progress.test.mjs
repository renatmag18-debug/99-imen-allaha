import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createProgressHandler, validSnapshot } from '../personal-progress.mjs';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const secret = Buffer.alloc(32, 7).toString('base64');
const alice = { username: 'alice', password: 'secret' };
const empty = { version: 1, ayahs: [], qada: null };
const sample = { version: 1, ayahs: ['1:1', '2:20'], qada: { version: 1, hasPlan: true, totals: [10,10,10,10,10], entries: [{ id: 'x', date: '2026-11-01', counts: [1,0,0,0,0] }] } };

function mockDb() {
  const records = new Map([
    ['/users/alice.json', { value: { password: btoa('secret') }, etag: '"0"' }],
    ['/users/bob.json', { value: { password: btoa('other') }, etag: '"0"' }],
  ]); let rev = 0; let forceConflict = false;
  const deps = {
    userKey: s => s.trim().toLowerCase(), b64EncodeUtf8: s => btoa(s),
    reply: (body, status) => ({ status, body }),
    rtdbFetch: async (path, env, options) => {
      const old = records.get(path) || { value: null, etag: '"0"' };
      if (options.method === 'GET') return new Response(JSON.stringify(old.value), { status: 200, headers: { ETag: old.etag } });
      if (forceConflict || options.headers['if-match'] !== old.etag) return new Response(null, { status: 412 });
      const value = JSON.parse(options.body); const etag = '"' + (++rev) + '"'; records.set(path, { value, etag });
      return new Response(JSON.stringify(value), { status: 200 });
    },
  };
  return { handler: createProgressHandler(deps), records, conflict: () => { forceConflict = true; } };
}

test('validates ayahs and qada without accepting impossible records', () => {
  assert.equal(validSnapshot(sample), true);
  assert.equal(validSnapshot({ ...sample, ayahs: ['115:1'] }), false);
  assert.equal(validSnapshot({ ...sample, ayahs: ['1:1', '1:1'] }), false);
  assert.equal(validSnapshot({ ...sample, qada: { ...sample.qada, totals: [0,0,0,0,0] } }), false);
  assert.equal(validSnapshot({ ...sample, qada: { ...sample.qada, entries: [{ ...sample.qada.entries[0], date: '2026-02-30' }] } }), false);
});
test('requires authentication and a valid encryption key', async () => {
  const { handler } = mockDb();
  assert.equal((await handler({ ...alice, password: 'wrong', action: 'read' }, { PERSONAL_PROGRESS_KEY: secret })).status, 401);
  assert.equal((await handler({ ...alice, action: 'write', revision: null, snapshot: sample }, {})).status, 503);
});
test('private encrypted round-trip and no overwrite of newer data', async () => {
  const { handler, records } = mockDb(); const env = { PERSONAL_PROGRESS_KEY: secret };
  const initial = await handler({ ...alice, action: 'read' }, env);
  assert.equal(initial.body.progress, null);
  const written = await handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: null, snapshot: sample }, env);
  assert.equal(written.status, 200);
  const raw = records.get('/users/alice.json').value.personalProgressV1;
  assert.equal(JSON.stringify(raw).includes('1:1'), false);
  const read = await handler({ ...alice, action: 'read' }, env);
  assert.deepEqual(read.body.progress.snapshot, sample);
  const stale = await handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: null, snapshot: empty }, env);
  assert.equal(stale.status, 409);
  assert.deepEqual((await handler({ ...alice, action: 'read' }, env)).body.progress.snapshot, sample);
  const bob = await handler({ username: 'bob', password: 'other', action: 'read' }, env);
  assert.equal(bob.body.progress, null);
});
test('database compare-and-swap conflict preserves the previous record', async () => {
  const db = mockDb(); const env = { PERSONAL_PROGRESS_KEY: secret };
  const initial = await db.handler({ ...alice, action: 'read' }, env);
  const first = await db.handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: null, snapshot: sample }, env);
  db.conflict();
  assert.equal((await db.handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: first.body.revision, snapshot: empty }, env)).status, 409);
  assert.deepEqual((await db.handler({ ...alice, action: 'read' }, env)).body.progress.snapshot, sample);
});
test('corrupt ciphertext or wrong key never causes existing data to be overwritten', async () => {
  const { handler, records } = mockDb(); const env = { PERSONAL_PROGRESS_KEY: secret };
  const initial = await handler({ ...alice, action: 'read' }, env);
  await handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: null, snapshot: sample }, env);
  const before = JSON.stringify(records.get('/users/alice.json'));
  const wrong = { PERSONAL_PROGRESS_KEY: Buffer.alloc(32, 8).toString('base64') };
  assert.equal((await handler({ ...alice, action: 'write', accountId: initial.body.accountId, revision: null, snapshot: empty }, wrong)).status, 503);
  assert.equal(JSON.stringify(records.get('/users/alice.json')), before);
});
test('encrypted progress still decrypts after username change', async () => {
  const { handler, records } = mockDb(); const env = { PERSONAL_PROGRESS_KEY: secret };
  const bound = await handler({ ...alice, action: 'read' }, env);
  const initial = await handler({ ...alice, action: 'write', accountId: bound.body.accountId, revision: null, snapshot: sample }, env);
  const previous = records.get('/users/alice.json');
  records.set('/users/renamed.json', { value: { ...previous.value }, etag: '"renamed"' });
  const after = await handler({ username: 'renamed', password: 'secret', action: 'read' }, env);
  assert.equal(after.status, 200);
  assert.equal(after.body.accountId, initial.body.accountId);
  assert.deepEqual(after.body.progress.snapshot, sample);
});
test('recreating a deleted nickname gets a new personal identity', async () => {
  const { handler, records } = mockDb(); const env = { PERSONAL_PROGRESS_KEY: secret };
  const old = await handler({ ...alice, action: 'read' }, env);
  records.set('/users/alice.json', { value: { password: btoa('secret') }, etag: '"recreated"' });
  const next = await handler({ ...alice, action: 'read' }, env);
  assert.notEqual(old.body.accountId, next.body.accountId);
  assert.equal(next.body.progress, null);
  assert.equal((await handler({ ...alice, action: 'write', accountId: old.body.accountId, revision: null, snapshot: sample }, env)).status, 409);
  assert.equal((await handler({ ...alice, action: 'read' }, env)).body.progress, null);
});
