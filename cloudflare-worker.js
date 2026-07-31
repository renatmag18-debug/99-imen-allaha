/**
 * 99ism push relay — Cloudflare Worker
 *
 * The site (99ism.ru) is 100% static (GitHub Pages) and can't hold a secret,
 * so it can't call the FCM v1 API directly (that requires a Google service
 * account private key). This worker is the only piece that holds that key.
 *
 * Flow: client writes an invite/challenge/request to Firebase RTDB (as
 * before), then POSTs here so the target's devices get an actual OS push
 * even if they don't have the site open.
 *
 * Required secrets (Cloudflare dashboard -> Worker -> Settings -> Variables
 * and Secrets, all as "Encrypt"):
 *   FCM_PROJECT_ID    e.g. "ism-friends"
 *   FCM_CLIENT_EMAIL  service account email, e.g. "firebase-adminsdk-...@ism-friends.iam.gserviceaccount.com"
 *   FCM_PRIVATE_KEY   the full "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" PEM, newlines kept
 *   SHARED_SECRET     random string the client must send back — not real auth,
 *                      just keeps randoms off the internet from spamming users
 */

const RTDB_BASE = 'https://ism-friends-default-rtdb.firebaseio.com';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));
    if (request.method !== 'POST') return corsResponse(new Response('Method not allowed', { status: 405 }));

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
