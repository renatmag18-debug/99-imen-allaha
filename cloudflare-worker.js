/**
 * 99ism API + push relay — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/register       — Register user (email required)
 *   POST /api/login          — Login user (username OR a linked email)
 *   POST /api/sync-progress  — Sync quiz progress
 *   GET /api/profile/:username — Get user profile
 *   GET /api/friends/:username — Get friends list
 *   GET /api/friend-requests/:username — Get incoming pending friend requests
 *   POST /api/add-friend     — Send a friend request
 *   POST /api/accept-friend-request — Accept a pending request (makes both friends)
 *   POST /api/decline-friend-request — Decline/withdraw a pending request
 *   POST /api/remove-friend  — Remove an existing friend (both directions)
 *   POST /api/update-avatar  — Set avatar: either {emoji, color} from the
 *                               preset picker, or {photo} (a client-cropped/
 *                               compressed data: URL, capped at 60000 chars)
 *   POST /api/track-time     — Add elapsed seconds to stats.totalTimeSeconds
 *   POST /api/track-zikr     — Add taps to stats.totalZikrCount (lifetime, all counters combined)
 *   POST /api/set-reminder   — Save daily reminder time (UTC hour 0-23) for a user
 *   POST /api/cancel-reminder — Remove daily reminder for a user
 *   GET /api/leaderboard     — Get leaderboard (optional ?metric=quranPagesRead
 *                               to rank/slice by that stat instead of zikr count)
 *   POST /api/admin/user-count — Total registered users (single admin account only)
 *   POST /push                — Send a push notification (used by notifyFriend()
 *                               in index.html for duel invites, challenges,
 *                               friend requests; accepts an optional `link`
 *                               field, defaults to https://99ism.ru/)
 *
 *   -- Email account-recovery (added alongside the security-question flow,
 *      which stays as a fallback for accounts that never link an email) --
 *   POST /api/link-email               — Attach/replace the recovery email on
 *                                         an already-registered account
 *   POST /api/verify-email             — Confirm a 6-digit code sent to that
 *                                         email, marks it verified
 *   POST /api/resend-verification      — Re-send the verification code
 *                                         (rate-limited to once/minute)
 *   POST /api/account-info             — Get the caller's own email +
 *                                         verified state (never exposed on
 *                                         the public /api/profile endpoint)
 *   POST /api/reset-method             — Given a username or email, tells the
 *                                         client which recovery path applies
 *                                         (verified email, security question,
 *                                         or none) without leaking anything
 *                                         else about the account
 *   POST /api/request-password-reset   — Emails a reset code if the account
 *                                         has a verified email (always
 *                                         responds success either way, so a
 *                                         probe can't tell which emails exist)
 *   POST /api/reset-password-with-code — Apply a new password using that code
 *   POST /api/reset-with-security-answer — Apply a new password by answering
 *                                         the account's security question
 *                                         (verified server-side — this used
 *                                         to only be checked against
 *                                         localStorage client-side, which
 *                                         meant it silently never worked for
 *                                         any account actually registered on
 *                                         the server)
 *   POST /api/change-password          — Change the logged-in account's
 *                                         password (current password required)
 *   POST /api/change-username          — Rename the logged-in account
 *                                         (relocates its RTDB record + fixes
 *                                         up every friend/pending-request
 *                                         cross-reference and the emailIndex
 *                                         entry, since the username IS the
 *                                         record's key)
 *   POST /api/delete-account           — Permanently delete the logged-in
 *                                         account (record + emailIndex entry
 *                                         + every friend/pending-request
 *                                         cross-reference on other accounts)
 *   POST /api/admin/delete-account     — Same, by nickname, for a record too
 *                                         broken/forgotten to delete via its
 *                                         own password (single hardcoded
 *                                         admin account only)
 *
 * Required secrets (Cloudflare dashboard -> Worker -> Settings -> Variables
 * and Secrets, all as "Encrypt"):
 *   FCM_CLIENT_EMAIL  service account email — REQUIRED for all endpoints,
 *                     used to mint an OAuth token for RTDB REST calls
 *                     (rules require auth != null) and for FCM push sends
 *   FCM_PRIVATE_KEY   full PEM private key for the same service account
 *   FCM_PROJECT_ID    e.g. "ism-friends" — only needed for push notify
 *   SHARED_SECRET     random string for push auth
 *   RESEND_API_KEY    API key from resend.com — sends verification/reset
 *                     codes by email. The sending domain (RESEND_FROM below,
 *                     or 99ism.ru by default) must be a verified domain in
 *                     the Resend dashboard, or real sends will fail; until
 *                     it's set, these endpoints degrade gracefully
 *                     (emailSent: false) instead of breaking registration.
 *   RESEND_FROM       optional — "From" header for those emails, e.g.
 *                     "99 имён Аллаха <no-reply@99ism.ru>" (defaults below)
 *
 * Cron Triggers (wrangler.toml):
 *   0 * * * *  — runs every hour; sends daily reminders to all users whose
 *                reminderHourUTC matches the current UTC hour.
 */

const RTDB_BASE = 'https://ism-friends-default-rtdb.firebaseio.com';

// RTDB write/protected-read rules require `auth != null`. RTDB's REST API only
// accepts a service-account OAuth token via the `Authorization: Bearer` header
// (the `?auth=` query param is for Firebase Auth ID tokens / legacy secrets,
// and silently falls back to unauthenticated for OAuth2 tokens) — see getAccessToken().
const RTDB_SCOPE = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

// Usernames are case-insensitive: RTDB keys are always the lowercased form,
// while the originally-typed casing is kept in each user's `.username` field
// for display (so "Abu Yusuf" still shows as "Abu Yusuf" after logging in
// as "abu yusuf").
function userKey(username) {
  return (username || '').trim().toLowerCase();
}

// RTDB forbids ". # $ [ ]" in a key — Firebase rejects ANY request,
// reads included, targeting a path containing one with 400 "Invalid
// path: Invalid token in path". So a nickname containing these (most
// commonly someone typing their email into the nickname field, since
// "." is right there in every address) can never be registered as a
// real record at all: every read of it silently comes back as this
// error response instead, which every rtdbGetJson() call below turns
// into `null` — the caller sees "account doesn't exist", not a crash
// and not (as raw rtdbFetch(...).json() used to do throughout this
// file) the error object itself mistaken for real, if oddly empty,
// user data. Blocking these characters at registration/rename time
// stops anyone from typing such a nickname in the first place.
const FORBIDDEN_KEY_CHARS = /[.#$\[\]]/;
function hasForbiddenKeyChars(username) {
  return FORBIDDEN_KEY_CHARS.test(username || '');
}

// Plain btoa() only handles Latin1 and throws ("Invalid character") on
// anything outside that range — so any password containing Cyrillic (or
// other non-Latin1) characters made register/login throw here, which the
// client saw as a generic network error and silently fell back to a
// broken local-only account. This wraps the standard percent-encoding
// trick to make it UTF-8 safe while staying byte-for-byte identical to
// plain btoa() for ASCII input, so existing accounts' stored passwords
// still compare equal.
function b64EncodeUtf8(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode('0x' + hex)));
}

async function rtdbFetch(path, env, options) {
  const token = await getAccessToken(env, RTDB_SCOPE);
  const opts = { ...options, headers: { ...(options && options.headers), 'Authorization': `Bearer ${token}` } };
  return fetch(`${RTDB_BASE}${path}`, opts);
}

// GET + parse, but treat a failed request (e.g. an invalid-key path) as
// "not found" instead of returning the error body — Firebase's REST API
// error responses are JSON objects like {"error": "..."}, which are just
// as truthy as real user data to a plain `!user` check.
async function rtdbGetJson(path, env) {
  const res = await rtdbFetch(path, env);
  if (!res.ok) return null;
  return await res.json();
}

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
  },

  // Cron trigger: runs every hour (0 * * * * in wrangler.toml).
  // Finds all users with a reminderHourUTC matching the current UTC hour
  // and sends them a push notification to study the Names of Allah.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
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

  // GET /api/friend-requests/:username — incoming pending requests
  if (request.method === 'GET' && path.startsWith('friend-requests/')) {
    const username = decodeURIComponent(path.split('/')[1]);
    return handleGetFriendRequests(username, env);
  }

  // POST /api/add-friend — sends a friend request, doesn't friend immediately
  if (request.method === 'POST' && path === 'add-friend') {
    return handleAddFriend(body, env);
  }

  // POST /api/accept-friend-request
  if (request.method === 'POST' && path === 'accept-friend-request') {
    return handleAcceptFriendRequest(body, env);
  }

  // POST /api/decline-friend-request
  if (request.method === 'POST' && path === 'decline-friend-request') {
    return handleDeclineFriendRequest(body, env);
  }

  // POST /api/remove-friend
  if (request.method === 'POST' && path === 'remove-friend') {
    return handleRemoveFriend(body, env);
  }

  // POST /api/register-push-token
  if (request.method === 'POST' && path === 'register-push-token') {
    return handleRegisterPushToken(body, env);
  }

  // POST /api/update-avatar
  if (request.method === 'POST' && path === 'update-avatar') {
    return handleUpdateAvatar(body, env);
  }

  // POST /api/track-time
  if (request.method === 'POST' && path === 'track-time') {
    return handleTrackTime(body, env);
  }

  // POST /api/track-zikr
  if (request.method === 'POST' && path === 'track-zikr') {
    return handleTrackZikr(body, env);
  }

  // POST /api/set-reminder — save daily reminder time for a user
  if (request.method === 'POST' && path === 'set-reminder') {
    return handleSetReminder(body, env);
  }

  // POST /api/cancel-reminder — remove daily reminder for a user
  if (request.method === 'POST' && path === 'cancel-reminder') {
    return handleCancelReminder(body, env);
  }

  // GET /api/leaderboard[?username=x][&metric=quranPagesRead] — scoped to
  // that user + their friends when username is given; metric picks which
  // stat field to sort/slice-to-100 by (defaults to totalZikrCount).
  if (request.method === 'GET' && path === 'leaderboard') {
    return handleLeaderboard(env, url.searchParams.get('username'), url.searchParams.get('metric'));
  }

  // POST /api/admin/user-count
  if (request.method === 'POST' && path === 'admin/user-count') {
    return handleAdminUserCount(body, env);
  }

  // POST /api/link-email — attach/replace the recovery email on an
  // already-registered account
  if (request.method === 'POST' && path === 'link-email') {
    return handleLinkEmail(body, env);
  }

  // POST /api/verify-email — confirm the 6-digit code sent to that email
  if (request.method === 'POST' && path === 'verify-email') {
    return handleVerifyEmail(body, env);
  }

  // POST /api/resend-verification
  if (request.method === 'POST' && path === 'resend-verification') {
    return handleResendVerification(body, env);
  }

  // POST /api/account-info — caller's own email + verified state
  if (request.method === 'POST' && path === 'account-info') {
    return handleAccountInfo(body, env);
  }

  // POST /api/reset-method — which recovery path applies to this account
  if (request.method === 'POST' && path === 'reset-method') {
    return handleResetMethod(body, env);
  }

  // POST /api/request-password-reset
  if (request.method === 'POST' && path === 'request-password-reset') {
    return handleRequestPasswordReset(body, env);
  }

  // POST /api/reset-password-with-code
  if (request.method === 'POST' && path === 'reset-password-with-code') {
    return handleResetPasswordWithCode(body, env);
  }

  // POST /api/reset-with-security-answer
  if (request.method === 'POST' && path === 'reset-with-security-answer') {
    return handleResetWithSecurityAnswer(body, env);
  }

  // POST /api/change-password
  if (request.method === 'POST' && path === 'change-password') {
    return handleChangePassword(body, env);
  }

  // POST /api/change-username
  if (request.method === 'POST' && path === 'change-username') {
    return handleChangeUsername(body, env);
  }

  // POST /api/delete-account
  if (request.method === 'POST' && path === 'delete-account') {
    return handleDeleteAccount(body, env);
  }

  // POST /api/admin/delete-account
  if (request.method === 'POST' && path === 'admin/delete-account') {
    return handleAdminDeleteAccount(body, env);
  }

  return corsResponse(jsonResponse({ error: 'not found' }, 404));
}

// Single hardcoded admin account — not a secret by itself, the password
// check below is what actually gates this endpoint.
const ADMIN_USERNAME = 'Abu Yusuf';

async function handleAdminUserCount(body, env) {
  const { username, password } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing auth' }, 401));
  if (userKey(username) !== userKey(ADMIN_USERNAME)) return corsResponse(jsonResponse({ error: 'forbidden' }, 403));

  const user = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));

  // /users also holds legacy anonymous-Firebase-Auth entries from the duel
  // feature (keyed by Firebase uid, no password/stats) — only count real
  // username/password registrations, same marker handleLeaderboard uses.
  const all = await rtdbGetJson(`/users.json`, env);
  const count = all ? Object.values(all).filter(u => u && u.password).length : 0;

  return corsResponse(jsonResponse({ count }));
}

async function handleRegister(body, env) {
  const { username, password, securityQuestion, securityAnswer, email } = body || {};

  if (!username || !password || !email) {
    return corsResponse(jsonResponse({ error: 'missing username, password or email' }, 400));
  }

  if (username.length < 3 || password.length < 3) {
    return corsResponse(jsonResponse({ error: 'username and password must be at least 3 chars' }, 400));
  }

  if (hasForbiddenKeyChars(username)) {
    return corsResponse(jsonResponse({ error: 'username contains invalid characters' }, 400));
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return corsResponse(jsonResponse({ error: 'invalid email' }, 400));
  }
  if (isGmailAddress(normalizedEmail)) {
    return corsResponse(jsonResponse({ error: 'gmail not allowed' }, 400));
  }

  const key = userKey(username);

  // Check if user exists
  const existing = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (existing && existing.password) {
    return corsResponse(jsonResponse({ error: 'username already taken' }, 409));
  }

  // Blocks the exact scenario that used to slip through: someone already
  // has an account with this email linked, forgets it, and "registers"
  // again under a fresh nickname — this used to only fail if the *nickname*
  // collided, so a same-email duplicate sailed straight through and the
  // person ended up with two disconnected accounts (their real one, and an
  // empty phantom that could never legitimately use that email itself).
  if (await lookupEmailOwner(normalizedEmail, env)) {
    return corsResponse(jsonResponse({ error: 'email already in use' }, 409));
  }

  // Create user
  const displayUsername = username.trim();
  const userData = {
    username: displayUsername,
    password: b64EncodeUtf8(password),
    securityQuestion: securityQuestion || 'default',
    securityAnswer: (securityAnswer || '').toLowerCase(),
    joinedAt: new Date().toISOString(),
    friends: {},
    quizProgress: {},
    email: normalizedEmail,
    emailVerified: false,
    stats: {
      totalStudied: 0,
      correctAnswers: 0,
      bestPercent: 0,
      quizzesCompleted: 0,
      totalTimeSeconds: 0,
      lastActive: new Date().toISOString()
    }
  };

  const createRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userData)
  });

  if (!createRes.ok) {
    return corsResponse(jsonResponse({ error: 'failed to create user' }, 500));
  }

  await rtdbFetch(`/emailIndex/${emailKey(normalizedEmail)}.json`, env, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(key)
  });
  const emailSent = await sendVerificationCode(key, displayUsername, normalizedEmail, env);

  return corsResponse(jsonResponse({ ok: true, username: displayUsername, emailSent }));
}

async function handleLogin(body, env) {
  const { username, password } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing username or password' }, 400));
  }

  // The login form accepts either a nickname or a linked email in the same
  // field. Try an exact-nickname match FIRST, password and all — even a
  // string that looks like an email might genuinely be someone's literal
  // nickname (e.g. typed into that field by mistake at registration).
  // Only if that doesn't check out do we try it as a linked email instead.
  // Checking straight-to-email whenever the string contains "@" (the
  // previous behavior) meant a nickname/email collision made the
  // nickname-holding account permanently unreachable via login — its own
  // correct password would never even be tried once *any* account had
  // linked that same string as a recovery email.
  const nickKey = userKey(username);
  const nickUser = await rtdbGetJson(`/users/${encodeURIComponent(nickKey)}.json`, env);
  if (nickUser && nickUser.password === b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ ok: true, username: nickUser.username || username, stats: nickUser.stats || {} }));
  }

  if (username.includes('@')) {
    const owner = await lookupEmailOwner(username.trim().toLowerCase(), env);
    if (owner) {
      const ownerUser = await rtdbGetJson(`/users/${encodeURIComponent(owner)}.json`, env);
      if (ownerUser && ownerUser.password === b64EncodeUtf8(password)) {
        return corsResponse(jsonResponse({ ok: true, username: ownerUser.username || owner, stats: ownerUser.stats || {} }));
      }
    }
  }

  return corsResponse(jsonResponse({ error: 'invalid username or password' }, 401));
}

/* =====================================================
   EMAIL ACCOUNT RECOVERY
   Emails are indexed separately at /emailIndex/<emailKey> -> username key,
   since RTDB can't use a raw email as part of a lookup path (it contains
   "." which RTDB keys forbid) and a full users-table scan per lookup would
   be wasteful. emailKey() reuses the same base64url encoding already used
   for JWT parts elsewhere in this file, which happens to produce a key with
   none of RTDB's forbidden characters (. # $ [ ]).
===================================================== */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Gmail addresses are no longer accepted (registration or linking), and an
// already-linked one stops counting as a working recovery path — see
// handleRegister/handleLinkEmail/handleResetMethod/handleRequestPasswordReset.
function isGmailAddress(email) {
  return !!email && /@(gmail\.com|googlemail\.com)$/i.test(email.trim());
}

function emailKey(email) {
  return b64url(email);
}

async function lookupEmailOwner(email, env) {
  return await rtdbGetJson(`/emailIndex/${emailKey(email)}.json`, env); // the owning account's username key, or null
}

function generateCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

// "an***@gmail.com" — enough for a user to recognize their own address
// without a page showing someone else's full email if they mistype a
// username that happens to collide with another account's recovery state.
function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Soft-fails (returns false) rather than throwing — RESEND_API_KEY may not
// be configured yet, or the sending domain may not be verified with Resend,
// and none of that should ever break registration/login themselves, only
// the "we also emailed you a code" side effect.
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    console.error('sendEmail skipped: RESEND_API_KEY not configured');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || '99 имён Аллаха <no-reply@99ism.ru>',
        to: [to],
        subject,
        html
      })
    });
    if (!res.ok) {
      console.error('Resend send failed:', await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Resend send threw:', e);
    return false;
  }
}

async function sendVerificationCode(key, displayUsername, email, env) {
  const code = generateCode();
  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emailVerificationCode: code,
      emailVerificationExpires: Date.now() + 15 * 60 * 1000,
      // Stamped here (not just in handleResendVerification) so the very
      // first send — from registration or from linking an email — also
      // starts the cooldown, instead of leaving a window where the first
      // "resend" right after that initial send bypasses it entirely.
      lastVerificationSentAt: Date.now()
    })
  });
  return sendEmail(env, email, 'Код подтверждения — 99 имён Аллаха',
    `<p>Здравствуйте, ${escapeHtml(displayUsername)}!</p>` +
    `<p>Код подтверждения почты для приложения «99 имён Аллаха»:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
    `<p>Код действителен 15 минут. Если вы не запрашивали это, просто проигнорируйте письмо.</p>`);
}

/**
 * POST /api/link-email
 * Body: { username, password, email }
 * Attaches a recovery email to an existing account (or replaces an
 * unverified one) and sends a verification code to it. This is the "link
 * your account to an email so you don't lose it" prompt shown to already-
 * registered users.
 */
async function handleLinkEmail(body, env) {
  const { username, password, email } = body || {};
  if (!username || !password || !email) return corsResponse(jsonResponse({ error: 'missing data' }, 400));

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) return corsResponse(jsonResponse({ error: 'invalid email' }, 400));
  if (isGmailAddress(normalizedEmail)) return corsResponse(jsonResponse({ error: 'gmail not allowed' }, 400));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const existingOwner = await lookupEmailOwner(normalizedEmail, env);
  if (existingOwner && existingOwner !== key) {
    return corsResponse(jsonResponse({ error: 'email already in use' }, 409));
  }

  // Replacing a previously-linked (typically not-yet-verified — e.g. the
  // person mistyped it) email with a different one — drop the old
  // emailIndex entry so it doesn't sit there forever pointing at this
  // account and blocking anyone (including this same person, later) from
  // ever using that address.
  if (user.email && user.email !== normalizedEmail) {
    await rtdbFetch(`/emailIndex/${emailKey(user.email)}.json`, env, { method: 'DELETE' });
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizedEmail, emailVerified: false })
  });
  await rtdbFetch(`/emailIndex/${emailKey(normalizedEmail)}.json`, env, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(key)
  });

  const emailSent = await sendVerificationCode(key, user.username || username, normalizedEmail, env);
  return corsResponse(jsonResponse({ ok: true, emailSent }));
}

/**
 * POST /api/verify-email
 * Body: { username, code }
 * Knowing the code is itself the proof of ownership here — no password
 * needed, same as clicking a verification link would be passwordless.
 */
async function handleVerifyEmail(body, env) {
  const { username, code } = body || {};
  if (!username || !code) return corsResponse(jsonResponse({ error: 'missing data' }, 400));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || !user.emailVerificationCode) {
    return corsResponse(jsonResponse({ error: 'no pending verification' }, 400));
  }
  if (Date.now() > (user.emailVerificationExpires || 0)) {
    return corsResponse(jsonResponse({ error: 'code expired' }, 410));
  }
  if (user.emailVerificationCode !== code.trim()) {
    return corsResponse(jsonResponse({ error: 'invalid code' }, 401));
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailVerified: true, emailVerificationCode: null, emailVerificationExpires: null })
  });
  return corsResponse(jsonResponse({ ok: true }));
}

/**
 * POST /api/resend-verification
 * Body: { username, password }
 * Rate-limited to once/minute per account so a stray retry loop can't spam
 * Resend (and the user's inbox).
 */
async function handleResendVerification(body, env) {
  const { username, password } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing auth' }, 401));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }
  if (!user.email) return corsResponse(jsonResponse({ error: 'no email linked' }, 400));
  if (user.emailVerified) return corsResponse(jsonResponse({ error: 'already verified' }, 400));

  const lastSent = user.lastVerificationSentAt || 0;
  if (Date.now() - lastSent < 60 * 1000) {
    return corsResponse(jsonResponse({ error: 'please wait before resending' }, 429));
  }

  // sendVerificationCode() itself stamps lastVerificationSentAt, so the
  // cooldown above also covers the initial send from registration/linking,
  // not just repeat calls to this endpoint.
  const emailSent = await sendVerificationCode(key, user.username || username, user.email, env);
  return corsResponse(jsonResponse({ ok: true, emailSent }));
}

/**
 * POST /api/account-info
 * Body: { username, password }
 * The caller's own email + verified state — deliberately NOT exposed on the
 * public GET /api/profile/:username endpoint (that's fetched to view any
 * user's profile, including friends', and would otherwise leak emails to
 * anyone who knows a username).
 */
async function handleAccountInfo(body, env) {
  const { username, password } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing auth' }, 401));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  return corsResponse(jsonResponse({ ok: true, email: user.email || null, emailVerified: !!user.emailVerified }));
}

/**
 * POST /api/reset-method
 * Body: { identifier }  — a username or a linked email
 * Tells the client which recovery path this account supports, without
 * requiring auth (the whole point is recovering a forgotten password) and
 * without leaking anything beyond what's needed to route the UI: a masked
 * email if one's verified, the security question text otherwise, or "none"
 * for both a nonexistent account and one with no recovery method at all
 * (kept indistinguishable on purpose, so this can't be used to probe which
 * usernames exist).
 */
async function handleResetMethod(body, env) {
  const { identifier } = body || {};
  if (!identifier) return corsResponse(jsonResponse({ error: 'missing identifier' }, 400));

  const key = await resolveIdentifierToKey(identifier, env);
  const user = key ? await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env) : null;

  if (user && user.email && user.emailVerified && !isGmailAddress(user.email)) {
    return corsResponse(jsonResponse({ method: 'email', maskedEmail: maskEmail(user.email) }));
  }
  if (user && user.securityQuestion && user.securityQuestion !== 'default') {
    return corsResponse(jsonResponse({ method: 'security_question', question: user.securityQuestion }));
  }
  return corsResponse(jsonResponse({ method: 'none' }));
}

async function resolveIdentifierToKey(identifier, env) {
  if (identifier.includes('@')) {
    return lookupEmailOwner(identifier.trim().toLowerCase(), env);
  }
  const key = userKey(identifier);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  return (user && user.password) ? key : null;
}

/**
 * POST /api/request-password-reset
 * Body: { identifier }  — a username or a linked email
 * Always responds { ok: true } regardless of whether the account exists or
 * has a verified email, so this can't be used to enumerate accounts —  the
 * actual email only goes out when there's somewhere to send it.
 */
async function handleRequestPasswordReset(body, env) {
  const { identifier } = body || {};
  if (!identifier) return corsResponse(jsonResponse({ error: 'missing identifier' }, 400));

  const key = await resolveIdentifierToKey(identifier, env);
  if (key) {
    const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
    if (user && user.email && user.emailVerified && !isGmailAddress(user.email)) {
      const code = generateCode();
      await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passwordResetCode: code, passwordResetExpires: Date.now() + 15 * 60 * 1000 })
      });
      await sendEmail(env, user.email, 'Восстановление пароля — 99 имён Аллаха',
        `<p>Код для сброса пароля в приложении «99 имён Аллаха»:</p>` +
        `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
        `<p>Код действителен 15 минут. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>`);
    }
  }
  return corsResponse(jsonResponse({ ok: true }));
}

/**
 * POST /api/reset-password-with-code
 * Body: { identifier, code, newPassword }
 */
async function handleResetPasswordWithCode(body, env) {
  const { identifier, code, newPassword } = body || {};
  if (!identifier || !code || !newPassword) return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  if (newPassword.length < 3) return corsResponse(jsonResponse({ error: 'password must be at least 3 chars' }, 400));

  const key = await resolveIdentifierToKey(identifier, env);
  if (!key) return corsResponse(jsonResponse({ error: 'invalid code' }, 401));

  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || !user.passwordResetCode) return corsResponse(jsonResponse({ error: 'invalid code' }, 401));
  if (Date.now() > (user.passwordResetExpires || 0)) return corsResponse(jsonResponse({ error: 'code expired' }, 410));
  if (user.passwordResetCode !== code.trim()) return corsResponse(jsonResponse({ error: 'invalid code' }, 401));

  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: b64EncodeUtf8(newPassword), passwordResetCode: null, passwordResetExpires: null })
  });
  return corsResponse(jsonResponse({ ok: true, username: user.username || key }));
}

/**
 * POST /api/reset-with-security-answer
 * Body: { identifier, answer, newPassword }
 * Verifies the security-question answer server-side. Fixes an existing bug:
 * the old client-side reset flow only ever checked a locally-cached copy in
 * localStorage, which meant it silently never worked for any account that
 * had actually registered on the server (the common case) — only for
 * accounts created while briefly offline.
 */
async function handleResetWithSecurityAnswer(body, env) {
  const { identifier, answer, newPassword } = body || {};
  if (!identifier || !answer || !newPassword) return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  if (newPassword.length < 3) return corsResponse(jsonResponse({ error: 'password must be at least 3 chars' }, 400));

  const key = await resolveIdentifierToKey(identifier, env);
  if (!key) return corsResponse(jsonResponse({ error: 'account not found' }, 404));

  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || !user.securityAnswer) return corsResponse(jsonResponse({ error: 'no security question set' }, 400));
  if (user.securityAnswer !== answer.trim().toLowerCase()) {
    return corsResponse(jsonResponse({ error: 'wrong answer' }, 401));
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: b64EncodeUtf8(newPassword) })
  });
  return corsResponse(jsonResponse({ ok: true, username: user.username || key }));
}

/* =====================================================
   ACCOUNT SETTINGS (change nickname / password)
   The client only offers these once the account has a verified email —
   not enforced here server-side (the current password is still the real
   gate on both), but the client's reasoning is: without a working recovery
   path, changing your own login details is one typo away from locking
   yourself out for good.
===================================================== */

/**
 * POST /api/change-password
 * Body: { username, password, newPassword }
 */
async function handleChangePassword(body, env) {
  const { username, password, newPassword } = body || {};
  if (!username || !password || !newPassword) return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  if (newPassword.length < 3) return corsResponse(jsonResponse({ error: 'password must be at least 3 chars' }, 400));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: b64EncodeUtf8(newPassword) })
  });
  return corsResponse(jsonResponse({ ok: true }));
}

// Moves one cross-reference entry (a friend's copy of this account's old
// key, under e.g. "friends" or "friendRequestsIn") to the new key, with the
// corrected display name — used by handleChangeUsername for every friend/
// pending-request relationship, since those are stored on the OTHER
// party's own record and won't move just because this account's record did.
async function renameCrossRef(otherKey, subPath, oldKey, newKey, newDisplayName, env) {
  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(otherKey)}/${subPath}/${encodeURIComponent(oldKey)}.json`, env, { method: 'DELETE' }),
    rtdbFetch(`/users/${encodeURIComponent(otherKey)}/${subPath}/${encodeURIComponent(newKey)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newDisplayName)
    })
  ]);
}

/**
 * POST /api/change-username
 * Body: { username, password, newUsername }
 * The username IS the RTDB record key (lowercased), so renaming it means
 * relocating the whole record to a new key and fixing up every place that
 * references the OLD key: the emailIndex entry (if any), and every
 * friend's/pending-request's own record (their side of a friendship or
 * request is stored under THEIR key, not this account's, so it doesn't
 * move automatically). A same-key rename (casing only, e.g. "Abu"->"abu")
 * skips all of that and just updates the display field in place.
 */
async function handleChangeUsername(body, env) {
  const { username, password, newUsername } = body || {};
  if (!username || !password || !newUsername) return corsResponse(jsonResponse({ error: 'missing data' }, 400));

  const trimmedNew = newUsername.trim();
  if (trimmedNew.length < 3) return corsResponse(jsonResponse({ error: 'username must be at least 3 chars' }, 400));
  if (hasForbiddenKeyChars(trimmedNew)) return corsResponse(jsonResponse({ error: 'username contains invalid characters' }, 400));

  const oldKey = userKey(username);
  const newKey = userKey(trimmedNew);

  const user = await rtdbGetJson(`/users/${encodeURIComponent(oldKey)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  if (newKey === oldKey) {
    await rtdbFetch(`/users/${encodeURIComponent(oldKey)}/username.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trimmedNew)
    });
    return corsResponse(jsonResponse({ ok: true, username: trimmedNew }));
  }

  const existing = await rtdbGetJson(`/users/${encodeURIComponent(newKey)}.json`, env);
  if (existing && existing.password) {
    return corsResponse(jsonResponse({ error: 'username already taken' }, 409));
  }

  const movedUser = { ...user, username: trimmedNew };
  await rtdbFetch(`/users/${encodeURIComponent(newKey)}.json`, env, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(movedUser)
  });

  const followUps = [];
  if (user.email) {
    followUps.push(rtdbFetch(`/emailIndex/${emailKey(user.email)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newKey)
    }));
  }
  for (const friendKey of Object.keys(user.friends || {})) {
    followUps.push(renameCrossRef(friendKey, 'friends', oldKey, newKey, trimmedNew, env));
  }
  for (const fromKey of Object.keys(user.friendRequestsIn || {})) {
    followUps.push(renameCrossRef(fromKey, 'friendRequestsOut', oldKey, newKey, trimmedNew, env));
  }
  for (const toKey of Object.keys(user.friendRequestsOut || {})) {
    followUps.push(renameCrossRef(toKey, 'friendRequestsIn', oldKey, newKey, trimmedNew, env));
  }
  await Promise.all(followUps);

  await rtdbFetch(`/users/${encodeURIComponent(oldKey)}.json`, env, { method: 'DELETE' });

  return corsResponse(jsonResponse({ ok: true, username: trimmedNew }));
}

/**
 * POST /api/delete-account
 * Body: { username, password }
 * Permanently deletes the account: the record itself, its emailIndex entry
 * (if any), and every friend/pending-request cross-reference on OTHER
 * accounts that point back at this one — those live on the other party's
 * own record (same reasoning as handleChangeUsername), so they'd otherwise
 * be left dangling, pointing at a key that no longer exists.
 */
// Shared by handleDeleteAccount (self-service) and handleAdminDeleteAccount
// (the admin-only fallback for a record too broken/forgotten to delete via
// its own password) — removes the account record, its emailIndex entry,
// and every friend/pending-request cross-reference on OTHER accounts that
// point back at it (those live on the other party's own record, so they
// don't disappear on their own).
async function deleteAccountRecord(key, user, env) {
  const cleanup = [];
  if (user.email) {
    cleanup.push(rtdbFetch(`/emailIndex/${emailKey(user.email)}.json`, env, { method: 'DELETE' }));
  }
  for (const friendKey of Object.keys(user.friends || {})) {
    cleanup.push(rtdbFetch(`/users/${encodeURIComponent(friendKey)}/friends/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' }));
  }
  for (const fromKey of Object.keys(user.friendRequestsIn || {})) {
    cleanup.push(rtdbFetch(`/users/${encodeURIComponent(fromKey)}/friendRequestsOut/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' }));
  }
  for (const toKey of Object.keys(user.friendRequestsOut || {})) {
    cleanup.push(rtdbFetch(`/users/${encodeURIComponent(toKey)}/friendRequestsIn/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' }));
  }
  await Promise.all(cleanup);

  const delRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' });
  if (!delRes.ok) {
    const body = await delRes.text().catch(() => '');
    throw new Error(`rtdb delete failed (${delRes.status}): ${body.slice(0, 300)}`);
  }
  // Firebase RTDB's REST DELETE returns 200 with body `null` even when the
  // path never actually changes (e.g. a key containing characters the
  // Realtime Database rejects, like "." from an email typed into the
  // nickname field) — verify the record is actually gone rather than
  // trusting the DELETE response status alone.
  const stillThere = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env).catch(() => null);
  if (stillThere) {
    throw new Error(`rtdb delete did not persist: record still present at key "${key}"`);
  }
}

async function handleDeleteAccount(body, env) {
  const { username, password } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing data' }, 400));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  try {
    await deleteAccountRecord(key, user, env);
  } catch (e) {
    return corsResponse(jsonResponse({ error: e.message || 'delete failed' }, 502));
  }

  return corsResponse(jsonResponse({ ok: true }));
}

/**
 * POST /api/admin/delete-account
 * Body: { username, password, targetUsername }
 * Gated to the single hardcoded admin account (same gate as
 * handleAdminUserCount) — a fallback for a record too broken or forgotten
 * to delete via its own password (e.g. one left over from an old, buggy
 * client-side fallback path that never had a normal password set on it).
 */
async function handleAdminDeleteAccount(body, env) {
  const { username, password, targetUsername } = body || {};
  if (!username || !password || !targetUsername) return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  if (userKey(username) !== userKey(ADMIN_USERNAME)) return corsResponse(jsonResponse({ error: 'forbidden' }, 403));

  const admin = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  if (!admin || admin.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const targetKey = userKey(targetUsername);
  const target = await rtdbGetJson(`/users/${encodeURIComponent(targetKey)}.json`, env);
  if (!target) return corsResponse(jsonResponse({ error: 'account not found' }, 404));

  try {
    await deleteAccountRecord(targetKey, target, env);
  } catch (e) {
    // The target resolves fine via a direct keyed GET (we're here because
    // it does), yet a shallow listing of /users doesn't show a matching
    // key at all when browsed manually — suggesting the real stored key
    // differs from targetKey by something invisible (whitespace, a
    // lookalike Unicode character, casing). Surface the exact expected
    // key's char codes and scan for anything similar so the real key is
    // visible without more manual Firebase-console spelunking.
    let detail = e.message || 'delete failed';
    try {
      const all = await rtdbGetJson(`/users.json?shallow=true`, env);
      const keys = Object.keys(all || {});
      const fragment = (targetKey.match(/[a-z0-9]+/i) || [targetKey])[0];
      const matches = keys.filter(k => k.toLowerCase().includes(fragment.toLowerCase()));
      const codes = Array.from(targetKey).map(c => c.charCodeAt(0)).join(',');
      detail += ` | expected key "${targetKey}" (len ${targetKey.length}, codes [${codes}]) | ${keys.length} total user keys | keys containing "${fragment}": ${JSON.stringify(matches)}`;
    } catch (e2) {
      detail += ` | diagnostic scan also failed: ${e2.message}`;
    }
    return corsResponse(jsonResponse({ error: detail }, 502));
  }

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleSyncProgress(body, env) {
  const { username, password, quizProgress, stats, incrementQuizzesCompleted, learnedNames } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing auth' }, 401));
  }

  // Verify auth
  const user = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Update progress
  const updateData = {};
  if (quizProgress) updateData.quizProgress = quizProgress;
  // Which specific names are marked "learned" (not just the count, which
  // already lived in stats.totalStudied) — this is what used to live only
  // in a local export/import backup file; syncing it here is what lets
  // logging into the same account on a different device/reinstall actually
  // restore those checkmarks instead of just the aggregate stats.
  if (Array.isArray(learnedNames)) updateData.learnedNames = learnedNames;
  if (stats || incrementQuizzesCompleted) {
    const mergedStats = { ...user.stats, ...stats, lastActive: new Date().toISOString() };
    // bestPercent is a high-water mark, not a plain overwrite — a worse
    // score this round shouldn't erase a better one from before.
    if (stats && typeof stats.bestPercent === 'number') {
      mergedStats.bestPercent = Math.max((user.stats && user.stats.bestPercent) || 0, stats.bestPercent);
    }
    if (incrementQuizzesCompleted) {
      mergedStats.quizzesCompleted = ((user.stats && user.stats.quizzesCompleted) || 0) + 1;
    }
    updateData.stats = mergedStats;
  }

  await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleGetProfile(username, env) {
  const user = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  return corsResponse(jsonResponse({
    username: user.username || username,
    avatar: user.avatar || null,
    joinedAt: user.joinedAt || null,
    stats: user.stats || {},
    friendsCount: Object.keys(user.friends || {}).length,
    learnedNames: user.learnedNames || []
  }));
}

async function handleGetFriends(username, env) {
  const user = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  // Friends are stored as {lowercaseKey: displayName}. Look each one up so the
  // list can show avatars/online status without a separate request per friend.
  const friendKeys = Object.keys(user.friends || {});
  const friends = await Promise.all(friendKeys.map(async (fk) => {
    const fUser = await rtdbGetJson(`/users/${encodeURIComponent(fk)}.json`, env);
    return {
      username: (fUser && fUser.username) || user.friends[fk],
      avatar: (fUser && fUser.avatar) || null
    };
  }));
  return corsResponse(jsonResponse({ friends }));
}

async function handleGetFriendRequests(username, env) {
  const user = await rtdbGetJson(`/users/${encodeURIComponent(userKey(username))}.json`, env);

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  const requests = Object.values(user.friendRequestsIn || {});
  return corsResponse(jsonResponse({ requests }));
}

async function handleAddFriend(body, env) {
  const { username, password, friendUsername } = body || {};

  if (!username || !password || !friendUsername) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  const key = userKey(username);
  const friendKey = userKey(friendUsername);

  if (key === friendKey) {
    return corsResponse(jsonResponse({ error: 'cannot add yourself' }, 400));
  }

  // Verify auth
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Check if friend exists
  const friend = await rtdbGetJson(`/users/${encodeURIComponent(friendKey)}.json`, env);

  if (!friend || !friend.password) {
    return corsResponse(jsonResponse({ error: 'friend not found' }, 404));
  }

  if (user.friends && user.friends[friendKey]) {
    return corsResponse(jsonResponse({ error: 'already friends' }, 409));
  }
  if (user.friendRequestsOut && user.friendRequestsOut[friendKey]) {
    return corsResponse(jsonResponse({ error: 'request already sent' }, 409));
  }

  // Send a request, not an immediate friendship — stored on both sides so
  // each can look their half up without a join: mine under "out", theirs
  // under "in", both keyed by the other party and valued with their
  // display-cased username.
  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/friendRequestsOut/${encodeURIComponent(friendKey)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(friend.username || friendUsername)
    }),
    rtdbFetch(`/users/${encodeURIComponent(friendKey)}/friendRequestsIn/${encodeURIComponent(key)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user.username || username)
    })
  ]);

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleAcceptFriendRequest(body, env) {
  const { username, password, fromUsername } = body || {};

  if (!username || !password || !fromUsername) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  const key = userKey(username);
  const fromKey = userKey(fromUsername);

  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }
  if (!user.friendRequestsIn || !user.friendRequestsIn[fromKey]) {
    return corsResponse(jsonResponse({ error: 'no such request' }, 404));
  }

  const fromUser = await rtdbGetJson(`/users/${encodeURIComponent(fromKey)}.json`, env);

  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/friends/${encodeURIComponent(fromKey)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify((fromUser && fromUser.username) || fromUsername)
    }),
    rtdbFetch(`/users/${encodeURIComponent(fromKey)}/friends/${encodeURIComponent(key)}.json`, env, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user.username || username)
    }),
    rtdbFetch(`/users/${encodeURIComponent(key)}/friendRequestsIn/${encodeURIComponent(fromKey)}.json`, env, { method: 'DELETE' }),
    rtdbFetch(`/users/${encodeURIComponent(fromKey)}/friendRequestsOut/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' })
  ]);

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleDeclineFriendRequest(body, env) {
  const { username, password, fromUsername } = body || {};

  if (!username || !password || !fromUsername) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  const key = userKey(username);
  const fromKey = userKey(fromUsername);

  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/friendRequestsIn/${encodeURIComponent(fromKey)}.json`, env, { method: 'DELETE' }),
    rtdbFetch(`/users/${encodeURIComponent(fromKey)}/friendRequestsOut/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' })
  ]);

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleRemoveFriend(body, env) {
  const { username, password, friendUsername } = body || {};

  if (!username || !password || !friendUsername) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  const key = userKey(username);
  const friendKey = userKey(friendUsername);

  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/friends/${encodeURIComponent(friendKey)}.json`, env, { method: 'DELETE' }),
    rtdbFetch(`/users/${encodeURIComponent(friendKey)}/friends/${encodeURIComponent(key)}.json`, env, { method: 'DELETE' })
  ]);

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleRegisterPushToken(body, env) {
  const { username, password, token } = body || {};

  if (!username || !password || !token) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  const key = userKey(username);

  // Verify auth
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // RTDB rules require auth.uid === $uid for fcmTokens writes, which a
  // username-keyed path can never satisfy from the client (there's no
  // Firebase Auth identity tied to a username/password account) — so this
  // goes through the worker's admin-authenticated rtdbFetch instead.
  //
  // This used to just PUT the new token alongside whatever was already
  // there — every app reinstall/update (and FCM's own occasional token
  // rotation) adds a token here, but nothing ever removed the OLD one
  // except a push actually failing against it with UNREGISTERED/404. FCM
  // keeps accepting sends to a stale, superseded token (HTTP 200) for a
  // while before it starts erroring, so a user who'd reinstalled/updated
  // several times ended up with a pile of tokens, most no longer actually
  // delivering — pushes only reached them whenever the send happened to
  // hit the one live token in the list. Replacing instead of accumulating
  // means there's only ever one (the current, real) token per account.
  const existing = await rtdbGetJson(`/users/${encodeURIComponent(key)}/fcmTokens.json`, env);
  const staleTokens = existing ? Object.keys(existing).filter(t => t !== token) : [];
  await Promise.all(staleTokens.map(t =>
    rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens/${encodeURIComponent(t)}.json`, env, { method: 'DELETE' })
  ));
  await rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens/${encodeURIComponent(token)}.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(true)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleUpdateAvatar(body, env) {
  const { username, password, emoji, color, photo } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }

  let avatarValue;
  if (photo) {
    // A data: URL the client already cropped/compressed client-side. Capped
    // well under RTDB's own per-value limits — the real reason for the cap
    // is that /api/leaderboard fetches every user's FULL record wholesale
    // (see handleLeaderboard), so an uncompressed photo per account would
    // make that payload balloon for everyone, not just its owner.
    if (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > 60000) {
      return corsResponse(jsonResponse({ error: 'invalid avatar' }, 400));
    }
    avatarValue = { photo };
  } else {
    if (!emoji || !color || typeof emoji !== 'string' || emoji.length > 8 || typeof color !== 'string' || color.length > 20) {
      return corsResponse(jsonResponse({ error: 'invalid avatar' }, 400));
    }
    avatarValue = { emoji, color };
  }

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}/avatar.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // PUT replaces the whole avatar node, so switching between a photo and
    // an emoji+color combo (either direction) cleanly drops the other one's
    // fields — no leftover `photo` sitting alongside a chosen emoji or vice
    // versa.
    body: JSON.stringify(avatarValue)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleTrackTime(body, env) {
  const { username, password, seconds } = body || {};

  if (!username || !password || !(seconds > 0)) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }
  // Client sends small periodic heartbeats (a couple minutes at a time) —
  // cap a single call so a stray/replayed request can't inflate the total.
  const delta = Math.min(seconds, 600);

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const current = (user.stats && user.stats.totalTimeSeconds) || 0;
  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/stats/totalTimeSeconds.json`, env, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current + delta)
    }),
    rtdbFetch(`/users/${encodeURIComponent(key)}/stats/lastActive.json`, env, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(new Date().toISOString())
    })
  ]);

  return corsResponse(jsonResponse({ ok: true, totalTimeSeconds: current + delta }));
}

async function handleTrackZikr(body, env) {
  const { username, password, count } = body || {};

  if (!username || !password || !(count > 0)) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }
  // Client batches taps and flushes periodically (see bumpZikrLifetimeTotal in
  // index.html) rather than one request per tap — cap a single call so a
  // stray/replayed request can't inflate the total.
  const delta = Math.min(Math.round(count), 20000);

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const current = (user.stats && user.stats.totalZikrCount) || 0;
  await Promise.all([
    rtdbFetch(`/users/${encodeURIComponent(key)}/stats/totalZikrCount.json`, env, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current + delta)
    }),
    rtdbFetch(`/users/${encodeURIComponent(key)}/stats/lastActive.json`, env, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(new Date().toISOString())
    })
  ]);

  return corsResponse(jsonResponse({ ok: true, totalZikrCount: current + delta }));
}

async function handleLeaderboard(env, scopeUsername, metric) {
  // Fetch everyone rather than orderBy+limitToLast: a friends-scoped view needs
  // to find friends regardless of where they rank globally, not just the top slice.
  const users = await rtdbGetJson(`/users.json`, env);

  if (!users) {
    return corsResponse(jsonResponse({ leaderboard: [] }));
  }

  let allowed = null;
  if (scopeUsername) {
    const scopeKey = userKey(scopeUsername);
    const scopeUser = users[scopeKey];
    allowed = new Set([scopeKey, ...Object.keys((scopeUser && scopeUser.friends) || {})]);
  }

  // Sorting (and the slice-to-100 below) happens on whichever stat the
  // caller asked to rank by, not always totalZikrCount — otherwise a
  // global Quran-pages leaderboard would silently exclude anyone who reads
  // a lot of Qur'an but doesn't rank in the top 100 by zikr count.
  const sortKey = metric === 'quranPagesRead' ? 'quranPagesRead' : 'totalZikrCount';

  const leaderboard = Object.entries(users)
    .filter(([key, user]) => user.stats && (!allowed || allowed.has(key)))
    .map(([key, user]) => ({
      username: user.username || key,
      avatar: user.avatar || null,
      totalZikrCount: user.stats.totalZikrCount || 0,
      totalStudied: user.stats.totalStudied || 0,
      correctAnswers: user.stats.correctAnswers || 0,
      quranPagesRead: user.stats.quranPagesRead || 0,
      friendsCount: Object.keys(user.friends || {}).length,
      lastActive: user.stats.lastActive
    }))
    .sort((a, b) => b[sortKey] - a[sortKey])
    .slice(0, 100);

  return corsResponse(jsonResponse({ leaderboard }));
}

/* =====================================================
   DAILY REMINDERS
===================================================== */

/**
 * POST /api/set-reminder
 * Body: { username, password, reminderHourUTC: 0-23, reminderMinuteUTC: 0-59 }
 * Saves reminder time for the user in RTDB at /users/<key>/reminder.
 */
async function handleSetReminder(body, env) {
  const { username, password, frequency } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing auth' }, 401));
  const freq = parseInt(frequency, 10);
  if (isNaN(freq) || freq < 1 || freq > 3) return corsResponse(jsonResponse({ error: 'frequency must be 1, 2 or 3' }, 400));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));

  await rtdbFetch(`/users/${encodeURIComponent(key)}/reminder.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frequency: freq })
  });

  return corsResponse(jsonResponse({ ok: true }));
}

/**
 * POST /api/cancel-reminder
 * Body: { username, password }
 * Deletes the reminder record for the user.
 */
async function handleCancelReminder(body, env) {
  const { username, password } = body || {};
  if (!username || !password) return corsResponse(jsonResponse({ error: 'missing auth' }, 401));

  const key = userKey(username);
  const user = await rtdbGetJson(`/users/${encodeURIComponent(key)}.json`, env);
  if (!user || user.password !== b64EncodeUtf8(password)) return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));

  await rtdbFetch(`/users/${encodeURIComponent(key)}/reminder.json`, env, { method: 'DELETE' });

  return corsResponse(jsonResponse({ ok: true }));
}

/**
 * Called by the Cron scheduled handler every hour.
 * Frequency → UTC send hours:
 *   1× per day  → [9]          (12:00 Moscow / 9:00 UTC)
 *   2× per day  → [7, 17]      (10:00 + 20:00 Moscow)
 *   3× per day  → [7, 12, 17]  (10:00 + 15:00 + 20:00 Moscow)
 */
async function sendDailyReminders(env) {
  const nowUtc = new Date();
  const currentHour = nowUtc.getUTCHours();
  const currentMinute = nowUtc.getUTCMinutes();

  // Only fire in the first 10 minutes of each hour (Cron may drift slightly)
  if (currentMinute > 10) return;

  // Load all users
  const users = await rtdbGetJson('/users.json', env);
  if (!users) return;

  const accessToken = await getAccessToken(env, 'https://www.googleapis.com/auth/firebase.messaging');

  // Reminder messages — rotated daily so they don't feel repetitive
  const dayIndex = nowUtc.getUTCDay(); // 0=Sun..6=Sat
  const REMINDER_MESSAGES = [
    { title: '📿 Время учить Имена Аллаха!', body: 'Уделите несколько минут изучению одного из прекрасных имён Аллаха сегодня.' },
    { title: '✨ Асма-уль-Хусна ждёт вас', body: 'Каждое имя — это путь к познанию Аллаха. Начните прямо сейчас!' },
    { title: '🌙 Ваше ежедневное напоминание', body: 'Изучите имя Аллаха сегодня — знание, которое останется с вами навсегда.' },
    { title: '📖 Время для изучения', body: 'Пророк ﷺ сказал: «Аллах имеет 99 имён...» — выучите ещё одно сегодня!' },
    { title: '⭐ Учите 99 Имён Аллаха', body: 'Ваш ежедневный урок готов. Несколько минут — и новое знание навсегда!' },
    { title: '🤲 Не забудьте об учёбе', body: 'Сегодня прекрасный день, чтобы узнать больше об именах Аллаха.' },
    { title: '💎 99 Имён Аллаха', body: 'Каждый день — одно имя, одно значение, одна близость к Аллаху.' }
  ];
  const msg = REMINDER_MESSAGES[dayIndex];

  // Frequency → which UTC hours to send
  const FREQ_HOURS = {
    1: [9],
    2: [7, 17],
    3: [7, 12, 17]
  };

  const sendPromises = [];

  for (const [key, user] of Object.entries(users)) {
    if (!user || !user.reminder || !user.fcmTokens) continue;
    const freq = user.reminder.frequency;
    const sendHours = FREQ_HOURS[freq];
    if (!sendHours || !sendHours.includes(currentHour)) continue;

    const tokens = Object.keys(user.fcmTokens);
    if (!tokens.length) continue;

    const deadTokens = [];
    for (const token of tokens) {
      const fcmRes = await fetch(
        `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              token,
              data: {
                title: msg.title,
                body: msg.body,
                tag: 'daily-reminder',
                link: 'https://99ism.ru/'
              },
              webpush: { headers: { Urgency: 'normal' } }
            }
          })
        }
      );
      if (!fcmRes.ok) {
        const errText = await fcmRes.text();
        if (fcmRes.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NOT_FOUND')) {
          deadTokens.push(token);
        }
      }
    }

    // Clean up dead tokens
    if (deadTokens.length) {
      sendPromises.push(
        Promise.all(deadTokens.map(t =>
          rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens/${encodeURIComponent(t)}.json`, env, { method: 'DELETE' })
        ))
      );
    }
  }

  await Promise.all(sendPromises);
}

async function handlePush(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return corsResponse(jsonResponse({ error: 'bad json' }, 400)); }

  const { targetUid, title, body: msgBody, tag, link, secret } = body || {};
  if (secret !== env.SHARED_SECRET) return corsResponse(jsonResponse({ error: 'forbidden' }, 403));
  if (!targetUid || !title) return corsResponse(jsonResponse({ error: 'missing targetUid/title' }, 400));

    const key = userKey(targetUid);
    const tokensObj = await rtdbGetJson(`/users/${encodeURIComponent(key)}/fcmTokens.json`, env);
    const tokens = tokensObj ? Object.keys(tokensObj) : [];
    if (!tokens.length) return corsResponse(jsonResponse({ ok: true, sent: 0, reason: 'no tokens' }));

    const accessToken = await getAccessToken(env, 'https://www.googleapis.com/auth/firebase.messaging');
    let sent = 0;
    const deadTokens = [];

    await Promise.all(tokens.map(async (token) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data: { title, body: msgBody || '', tag: tag || 'ism-notify', link: link || 'https://99ism.ru/' },
            // webpush.headers.Urgency only affects delivery to an actual web
            // push subscription — it's meaningless to the native Android FCM
            // SDK this app actually uses. Without android.priority explicitly
            // set, a data-only message defaults to normal priority, which
            // Doze/App Standby can delay by minutes on an idle phone on
            // mobile data — fine for most notifications, but this endpoint
            // also carries incoming-call pushes with a 30s ring timeout on
            // the caller's side, where a delayed push means a call that
            // "rings but nobody answers" even though the callee's phone
            // never actually showed anything in time.
            android: { priority: 'high' },
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
        rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens/${encodeURIComponent(t)}.json`, env, { method: 'DELETE' })
      ));
    }

    return corsResponse(jsonResponse({ ok: true, sent, removed: deadTokens.length }));
}

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

const cachedTokens = {}; // scope -> { token, exp } — reused across requests hitting the same isolate

async function getAccessToken(env, scope) {
  const now = Math.floor(Date.now() / 1000);
  const cached = cachedTokens[scope];
  if (cached && cached.exp - 60 > now) return cached.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope,
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

  cachedTokens[scope] = { token: tokenJson.access_token, exp: now + (tokenJson.expires_in || 3600) };
  return cachedTokens[scope].token;
}

async function importPrivateKey(pem) {
  const clean = pem
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
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
