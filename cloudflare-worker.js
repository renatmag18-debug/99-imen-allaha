/**
 * 99ism API + push relay — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/register       — Register user
 *   POST /api/login          — Login user
 *   POST /api/sync-progress  — Sync quiz progress
 *   GET /api/profile/:username — Get user profile
 *   GET /api/friends/:username — Get friends list
 *   POST /api/add-friend     — Add friend
 *   GET /api/leaderboard     — Get leaderboard
 *   POST /api/push-notify    — Send push notification (legacy)
 *
 * Required secrets (Cloudflare dashboard -> Worker -> Settings -> Variables
 * and Secrets, all as "Encrypt"):
 *   FCM_PROJECT_ID    e.g. "ism-friends"
 *   FCM_CLIENT_EMAIL  service account email
 *   FCM_PRIVATE_KEY   full PEM private key
 *   SHARED_SECRET     random string for push auth
 *   FIREBASE_API_KEY  Firebase API key for auth (optional)
 */

const RTDB_BASE = 'https://ism-friends-default-rtdb.firebaseio.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));

    // Route API requests
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }

    // Legacy push notification endpoint
    if (request.method === 'POST' && url.pathname === '/push') {
      return handlePush(request, env);
    }

    return corsResponse(new Response('Not found', { status: 404 }));
  }
};

async function handleAPI(request, env, url) {
  if (request.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));

  const path = url.pathname.replace('/api/', '');
  let body = null;

  if (request.method !== 'GET') {
    try { body = await request.json(); } catch (e) { return corsResponse(jsonResponse({ error: 'bad json' }, 400)); }
  }

  // POST /api/register
  if (request.method === 'POST' && path === 'register') {
    return handleRegister(body, env);
  }

  // POST /api/login
  if (request.method === 'POST' && path === 'login') {
    return handleLogin(body, env);
  }

  // POST /api/sync-progress
  if (request.method === 'POST' && path === 'sync-progress') {
    return handleSyncProgress(body, env);
  }

  // GET /api/profile/:username
  if (request.method === 'GET' && path.startsWith('profile/')) {
    const username = decodeURIComponent(path.split('/')[1]);
    return handleGetProfile(username, env);
  }

  // GET /api/friends/:username
  if (request.method === 'GET' && path.startsWith('friends/')) {
    const username = decodeURIComponent(path.split('/')[1]);
    return handleGetFriends(username, env);
  }

  // POST /api/add-friend
  if (request.method === 'POST' && path === 'add-friend') {
    return handleAddFriend(body, env);
  }

  // GET /api/leaderboard
  if (request.method === 'GET' && path === 'leaderboard') {
    return handleLeaderboard(env);
  }

  return corsResponse(jsonResponse({ error: 'not found' }, 404));
}

async function handleRegister(body, env) {
  const { username, password, securityQuestion, securityAnswer } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing username or password' }, 400));
  }

  if (username.length < 3 || password.length < 3) {
    return corsResponse(jsonResponse({ error: 'username and password must be at least 3 chars' }, 400));
  }

  // Check if user exists
  const existingRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const existing = await existingRes.json();

  if (existing && existing.password) {
    return corsResponse(jsonResponse({ error: 'username already taken' }, 409));
  }

  // Create user
  const userData = {
    username,
    password: btoa(password),
    securityQuestion: securityQuestion || 'default',
    securityAnswer: (securityAnswer || '').toLowerCase(),
    friends: {},
    quizProgress: {},
    stats: {
      totalStudied: 0,
      correctAnswers: 0,
      lastActive: new Date().toISOString()
    }
  };

  const createRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userData)
  });

  if (!createRes.ok) {
    return corsResponse(jsonResponse({ error: 'failed to create user' }, 500));
  }

  return corsResponse(jsonResponse({ ok: true, username }));
}

async function handleLogin(body, env) {
  const { username, password } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing username or password' }, 400));
  }

  const userRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const user = await userRes.json();

  if (!user || !user.password || user.password !== btoa(password)) {
    return corsResponse(jsonResponse({ error: 'invalid username or password' }, 401));
  }

  return corsResponse(jsonResponse({
    ok: true,
    username,
    stats: user.stats || {}
  }));
}

async function handleSyncProgress(body, env) {
  const { username, password, quizProgress, stats } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing auth' }, 401));
  }

  // Verify auth
  const userRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const user = await userRes.json();

  if (!user || user.password !== btoa(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Update progress
  const updateData = {};
  if (quizProgress) updateData.quizProgress = quizProgress;
  if (stats) {
    updateData.stats = { ...user.stats, ...stats, lastActive: new Date().toISOString() };
  }

  await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleGetProfile(username, env) {
  const userRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const user = await userRes.json();

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  return corsResponse(jsonResponse({
    username,
    stats: user.stats || {},
    friendsCount: Object.keys(user.friends || {}).length
  }));
}

async function handleGetFriends(username, env) {
  const userRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const user = await userRes.json();

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  const friends = Object.keys(user.friends || {});
  return corsResponse(jsonResponse({ friends }));
}

async function handleAddFriend(body, env) {
  const { username, password, friendUsername } = body || {};

  if (!username || !password || !friendUsername) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  // Verify auth
  const userRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}.json`);
  const user = await userRes.json();

  if (!user || user.password !== btoa(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Check if friend exists
  const friendRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(friendUsername)}.json`);
  const friend = await friendRes.json();

  if (!friend || !friend.password) {
    return corsResponse(jsonResponse({ error: 'friend not found' }, 404));
  }

  // Add friend
  await fetch(`${RTDB_BASE}/users/${encodeURIComponent(username)}/friends/${encodeURIComponent(friendUsername)}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(true)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleLeaderboard(env) {
  const leaderRes = await fetch(`${RTDB_BASE}/users.json?orderBy="stats/totalStudied"&limitToLast=100`);
  const users = await leaderRes.json();

  if (!users) {
    return corsResponse(jsonResponse({ leaderboard: [] }));
  }

  const leaderboard = Object.entries(users)
    .filter(([_, user]) => user.stats)
    .map(([username, user]) => ({
      username,
      totalStudied: user.stats.totalStudied || 0,
      correctAnswers: user.stats.correctAnswers || 0,
      friendsCount: Object.keys(user.friends || {}).length,
      lastActive: user.stats.lastActive
    }))
    .sort((a, b) => b.totalStudied - a.totalStudied)
    .slice(0, 100);

  return corsResponse(jsonResponse({ leaderboard }));
}

async function handlePush(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return corsResponse(jsonResponse({ error: 'bad json' }, 400)); }

  const { targetUid, title, body: msgBody, tag, secret } = body || {};
  if (secret !== env.SHARED_SECRET) return corsResponse(jsonResponse({ error: 'forbidden' }, 403));
  if (!targetUid || !title) return corsResponse(jsonResponse({ error: 'missing targetUid/title' }, 400));

    const tokensRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(targetUid)}/fcmTokens.json`);
    const tokensObj = await tokensRes.json();
    const tokens = tokensObj ? Object.keys(tokensObj) : [];
    if (!tokens.length) return corsResponse(jsonResponse({ ok: true, sent: 0, reason: 'no tokens' }));

    const accessToken = await getAccessToken(env);
    let sent = 0;
    const deadTokens = [];

    await Promise.all(tokens.map(async (token) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data: { title, body: msgBody || '', tag: tag || 'ism-notify', link: 'https://99ism.ru/' },
            webpush: { headers: { Urgency: 'high' } }
          }
        })
      });
      if (res.ok) { sent++; return; }
      const errText = await res.text();
      if (res.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NOT_FOUND')) {
        deadTokens.push(token);
      }
    }));

    if (deadTokens.length) {
      await Promise.all(deadTokens.map(t =>
        fetch(`${RTDB_BASE}/users/${encodeURIComponent(targetUid)}/fcmTokens/${encodeURIComponent(t)}.json`, { method: 'DELETE' })
      ));
    }

    return corsResponse(jsonResponse({ ok: true, sent, removed: deadTokens.length }));
}

    const tokensRes = await fetch(`${RTDB_BASE}/users/${encodeURIComponent(targetUid)}/fcmTokens.json`);
    const tokensObj = await tokensRes.json();
    const tokens = tokensObj ? Object.keys(tokensObj) : [];
    if (!tokens.length) return corsResponse(jsonResponse({ ok: true, sent: 0, reason: 'no tokens' }));

    const accessToken = await getAccessToken(env);
    let sent = 0;
    const deadTokens = [];

    await Promise.all(tokens.map(async (token) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            // data-only (no top-level "notification") — some browsers show a
            // push automatically for "notification" payloads AND our service
            // worker's onBackgroundMessage shows one too, causing duplicates.
            // With data-only, showNotification() in sw.js is the only path.
            data: { title, body: msgBody || '', tag: tag || 'ism-notify', link: 'https://99ism.ru/' },
            webpush: { headers: { Urgency: 'high' } }
          }
        })
      });
      if (res.ok) { sent++; return; }
      const errText = await res.text();
      if (res.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NOT_FOUND')) {
        deadTokens.push(token);
      }
    }));

    if (deadTokens.length) {
      await Promise.all(deadTokens.map(t =>
        fetch(`${RTDB_BASE}/users/${encodeURIComponent(targetUid)}/fcmTokens/${encodeURIComponent(t)}.json`, { method: 'DELETE' })
      ));
    }

    return corsResponse(jsonResponse({ ok: true, sent, removed: deadTokens.length }));
  }
};

function corsResponse(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

/* ---------------- Google OAuth2 (service account, RS256 JWT) ---------------- */

let cachedToken = null; // { token, exp } — reused across requests hitting the same isolate

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(env.FCM_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBuf(sigBuf)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error('OAuth failed: ' + JSON.stringify(tokenJson));

  cachedToken = { token: tokenJson.access_token, exp: now + (tokenJson.expires_in || 3600) };
  return cachedToken.token;
}

async function importPrivateKey(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function b64url(str) {
  return b64urlBuf(new TextEncoder().encode(str).buffer);
}
function b64urlBuf(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
