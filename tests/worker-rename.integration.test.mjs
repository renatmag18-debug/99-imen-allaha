import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const source = await readFile(new URL('../cloudflare-worker.js', import.meta.url), 'utf8');
const original = `async function rtdbFetch(path, env, options) {
  const token = await getAccessToken(env, RTDB_SCOPE);
  const opts = { ...options, headers: { ...(options && options.headers), 'Authorization': \`Bearer \${token}\` } };
  return fetch(\`\${RTDB_BASE}\${path}\`, opts);
}`;
assert.ok(source.includes(original), 'fixture must replace the exact database transport');
const fixture = new URL('../worker-fixture.mjs', import.meta.url);
await writeFile(fixture, source.replace(original, 'async function rtdbFetch(path, env, options) { return globalThis.__testRtdb(path, env, options); }'));
after(async () => { await unlink(fixture).catch(() => {}); });
const worker = (await import(fixture.href)).default;

function database() {
  const entries = new Map(); let counter = 0; let before = null;
  const set = (path, value) => entries.set(path, { value: structuredClone(value), etag: '"' + (++counter) + '"' });
  const request = async (path, env, options = {}) => {
    const method = options.method || 'GET';
    if (before) await before({ path, method, options, set, entries });
    const current = entries.get(path) || { value: null, etag: '"0"' };
    if (method === 'GET') return new Response(JSON.stringify(current.value), { status: 200, headers: { ETag: current.etag } });
    const expected = options.headers?.['if-match'];
    if (expected && expected !== current.etag) return new Response(null, { status: 412 });
    if (method === 'DELETE') { entries.delete(path); return new Response('null', { status: 200 }); }
    if (method === 'PUT') { set(path, JSON.parse(options.body)); return new Response('null', { status: 200 }); }
    throw new Error('unexpected method ' + method);
  };
  return { entries, set, request, hook: value => { before = value; } };
}
const post = (route, body) => worker.fetch(new Request('https://example.test/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {});

test('the actual change-username route preserves progress', async () => {
  const db = database(); globalThis.__testRtdb = db.request;
  db.set('/users/old.json', { username: 'old', password: btoa('secret'), personalProgressV1: { revision: 'keep-me' } });
  const res = await post('change-username', { username: 'old', password: 'secret', newUsername: 'new' });
  assert.equal(res.status, 200);
  assert.equal(db.entries.has('/users/old.json'), false);
  assert.equal(db.entries.get('/users/new.json').value.personalProgressV1.revision, 'keep-me');
});
test('the actual rename updates email and references before unlocking the destination', async () => {
  const db = database(); globalThis.__testRtdb = db.request;
  db.set('/users/old.json', { username: 'old', password: btoa('secret'), email: 'person@example.org', friends: { buddy: true }, personalProgressV1: { revision: 'preserve' } });
  const mailPath = '/emailIndex/' + Buffer.from('person@example.org').toString('base64url') + '.json';
  db.set(mailPath, 'old');
  db.set('/users/buddy/friends/old.json', 'old');
  const res = await post('change-username', { username: 'old', password: 'secret', newUsername: 'new' });
  assert.equal(res.status, 200);
  assert.equal(db.entries.get(mailPath).value, 'new');
  assert.equal(db.entries.get('/users/buddy/friends/new.json').value, 'new');
  assert.equal(db.entries.has('/users/buddy/friends/old.json'), false);
  assert.equal(db.entries.get('/users/new.json').value.personalProgressRenameLock, undefined);
});
test('an interrupted email update keeps data frozen and the same request can resume', async () => {
  const db = database(); globalThis.__testRtdb = db.request; let failed = false;
  db.set('/users/old.json', { username: 'old', password: btoa('secret'), email: 'person@example.org', personalProgressV1: { revision: 'preserve' } });
  db.hook(({ path, method }) => {
    if (!failed && path.startsWith('/emailIndex/') && method === 'PUT') { failed = true; throw new Error('offline'); }
  });
  const request = { username: 'old', password: 'secret', newUsername: 'new' };
  assert.equal((await post('change-username', request)).status, 503);
  assert.ok(db.entries.get('/users/new.json').value.personalProgressRenameLock);
  db.hook(null);
  assert.equal((await post('change-username', request)).status, 200);
  assert.equal(db.entries.get('/users/new.json').value.personalProgressV1.revision, 'preserve');
  assert.equal(db.entries.get('/users/new.json').value.personalProgressRenameLock, undefined);
});
test('registration cannot overwrite a nickname concurrently reserved for a rename', async () => {
  const db = database(); globalThis.__testRtdb = db.request; let once = false;
  db.hook(({ path, method, set }) => {
    if (!once && path === '/users/new.json' && method === 'PUT') {
      once = true; set(path, { username: 'new', password: btoa('other'), personalProgressV1: { revision: 'preserve' }, personalProgressRenameLock: { id: 'lock' } });
    }
  });
  const res = await post('register', { username: 'new', password: 'secret', email: 'person@example.org' });
  assert.equal(res.status, 409);
  assert.equal(db.entries.get('/users/new.json').value.personalProgressV1.revision, 'preserve');
});
test('account deletion cannot delete a concurrently frozen rename', async () => {
  const db = database(); globalThis.__testRtdb = db.request; let once = false;
  db.set('/users/old.json', { username: 'old', password: btoa('secret'), personalProgressV1: { revision: 'preserve' } });
  db.hook(({ path, method, set, entries }) => {
    if (!once && path === '/users/old.json' && method === 'DELETE') {
      once = true; set(path, { ...entries.get(path).value, personalProgressRenameLock: { id: 'rename' } });
    }
  });
  const res = await post('delete-account', { username: 'old', password: 'secret' });
  assert.equal(res.status, 502);
  assert.equal(db.entries.get('/users/old.json').value.personalProgressV1.revision, 'preserve');
});
