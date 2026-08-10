/**
 * 99ism API + push relay — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/register       — Register user
 *   POST /api/login          — Login user
 *   POST /api/sync-progress  — Sync quiz progress
 *   GET /api/profile/:username — Get user profile
 *   GET /api/friends/:username — Get friends list
 *   GET /api/friend-requests/:username — Get incoming pending friend requests
 *   POST /api/add-friend     — Send a friend request
 *   POST /api/accept-friend-request — Accept a pending request (makes both friends)
 *   POST /api/decline-friend-request — Decline/withdraw a pending request
 *   POST /api/remove-friend  — Remove an existing friend (both directions)
 *   POST /api/update-avatar  — Set avatar {emoji, color} from the preset picker
 *   POST /api/track-time     — Add elapsed seconds to stats.totalTimeSeconds
 *   POST /api/track-zikr     — Add taps to stats.totalZikrCount (lifetime, all counters combined)
 *   POST /api/set-reminder   — Save daily reminder time (UTC hour 0-23) for a user
 *   POST /api/cancel-reminder — Remove daily reminder for a user
 *   GET /api/leaderboard     — Get leaderboard
 *   POST /api/admin/user-count — Total registered users (single admin account only)
 *   POST /push                — Send a push notification (used by notifyFriend()
 *                               in index.html for duel invites, challenges,
 *                               friend requests; accepts an optional `link`
 *                               field, defaults to https://99ism.ru/)
 *
 * Required secrets (Cloudflare dashboard -> Worker -> Settings -> Variables
 * and Secrets, all as "Encrypt"):
 *   FCM_CLIENT_EMAIL  service account email — REQUIRED for all endpoints,
 *                     used to mint an OAuth token for RTDB REST calls
 *                     (rules require auth != null) and for FCM push sends
 *   FCM_PRIVATE_KEY   full PEM private key for the same service account
 *   FCM_PROJECT_ID    e.g. "ism-friends" — only needed for push notify
 *   SHARED_SECRET     random string for push auth
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

  // GET /api/leaderboard[?username=x] — scoped to that user + their friends when given
  if (request.method === 'GET' && path === 'leaderboard') {
    return handleLeaderboard(env, url.searchParams.get('username'));
  }

  // POST /api/admin/user-count
  if (request.method === 'POST' && path === 'admin/user-count') {
    return handleAdminUserCount(body, env);
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

  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();
  if (!user || user.password !== b64EncodeUtf8(password)) return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));

  // /users also holds legacy anonymous-Firebase-Auth entries from the duel
  // feature (keyed by Firebase uid, no password/stats) — only count real
  // username/password registrations, same marker handleLeaderboard uses.
  const allRes = await rtdbFetch(`/users.json`, env);
  const all = await allRes.json();
  const count = all ? Object.values(all).filter(u => u && u.password).length : 0;

  return corsResponse(jsonResponse({ count }));
}

async function handleRegister(body, env) {
  const { username, password, securityQuestion, securityAnswer } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing username or password' }, 400));
  }

  if (username.length < 3 || password.length < 3) {
    return corsResponse(jsonResponse({ error: 'username and password must be at least 3 chars' }, 400));
  }

  const key = userKey(username);

  // Check if user exists
  const existingRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const existing = await existingRes.json();

  if (existing && existing.password) {
    return corsResponse(jsonResponse({ error: 'username already taken' }, 409));
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

  return corsResponse(jsonResponse({ ok: true, username: displayUsername }));
}

async function handleLogin(body, env) {
  const { username, password } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing username or password' }, 400));
  }

  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();

  if (!user || !user.password || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid username or password' }, 401));
  }

  return corsResponse(jsonResponse({
    ok: true,
    username: user.username || username,
    stats: user.stats || {}
  }));
}

async function handleSyncProgress(body, env) {
  const { username, password, quizProgress, stats, incrementQuizzesCompleted } = body || {};

  if (!username || !password) {
    return corsResponse(jsonResponse({ error: 'missing auth' }, 401));
  }

  // Verify auth
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Update progress
  const updateData = {};
  if (quizProgress) updateData.quizProgress = quizProgress;
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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  return corsResponse(jsonResponse({
    username: user.username || username,
    avatar: user.avatar || null,
    joinedAt: user.joinedAt || null,
    stats: user.stats || {},
    friendsCount: Object.keys(user.friends || {}).length
  }));
}

async function handleGetFriends(username, env) {
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();

  if (!user) {
    return corsResponse(jsonResponse({ error: 'user not found' }, 404));
  }

  // Friends are stored as {lowercaseKey: displayName}. Look each one up so the
  // list can show avatars/online status without a separate request per friend.
  const friendKeys = Object.keys(user.friends || {});
  const friends = await Promise.all(friendKeys.map(async (fk) => {
    const fRes = await rtdbFetch(`/users/${encodeURIComponent(fk)}.json`, env);
    const fUser = await fRes.json();
    return {
      username: (fUser && fUser.username) || user.friends[fk],
      avatar: (fUser && fUser.avatar) || null
    };
  }));
  return corsResponse(jsonResponse({ friends }));
}

async function handleGetFriendRequests(username, env) {
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(userKey(username))}.json`, env);
  const user = await userRes.json();

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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // Check if friend exists
  const friendRes = await rtdbFetch(`/users/${encodeURIComponent(friendKey)}.json`, env);
  const friend = await friendRes.json();

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

  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }
  if (!user.friendRequestsIn || !user.friendRequestsIn[fromKey]) {
    return corsResponse(jsonResponse({ error: 'no such request' }, 404));
  }

  const fromRes = await rtdbFetch(`/users/${encodeURIComponent(fromKey)}.json`, env);
  const fromUser = await fromRes.json();

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

  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

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

  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  // RTDB rules require auth.uid === $uid for fcmTokens writes, which a
  // username-keyed path can never satisfy from the client (there's no
  // Firebase Auth identity tied to a username/password account) — so this
  // goes through the worker's admin-authenticated rtdbFetch instead.
  await rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens/${encodeURIComponent(token)}.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(true)
  });

  return corsResponse(jsonResponse({ ok: true }));
}

async function handleUpdateAvatar(body, env) {
  const { username, password, emoji, color } = body || {};

  if (!username || !password || !emoji || !color) {
    return corsResponse(jsonResponse({ error: 'missing data' }, 400));
  }
  if (typeof emoji !== 'string' || emoji.length > 8 || typeof color !== 'string' || color.length > 20) {
    return corsResponse(jsonResponse({ error: 'invalid avatar' }, 400));
  }

  const key = userKey(username);
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  await rtdbFetch(`/users/${encodeURIComponent(key)}/avatar.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji, color })
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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const current = (user.stats && user.stats.totalTimeSeconds) || 0;
  await rtdbFetch(`/users/${encodeURIComponent(key)}/stats/totalTimeSeconds.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(current + delta)
  });

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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();

  if (!user || user.password !== b64EncodeUtf8(password)) {
    return corsResponse(jsonResponse({ error: 'invalid auth' }, 401));
  }

  const current = (user.stats && user.stats.totalZikrCount) || 0;
  await rtdbFetch(`/users/${encodeURIComponent(key)}/stats/totalZikrCount.json`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(current + delta)
  });

  return corsResponse(jsonResponse({ ok: true, totalZikrCount: current + delta }));
}

async function handleLeaderboard(env, scopeUsername) {
  // Fetch everyone rather than orderBy+limitToLast: a friends-scoped view needs
  // to find friends regardless of where they rank globally, not just the top slice.
  const leaderRes = await rtdbFetch(`/users.json`, env);
  const users = await leaderRes.json();

  if (!users) {
    return corsResponse(jsonResponse({ leaderboard: [] }));
  }

  let allowed = null;
  if (scopeUsername) {
    const scopeKey = userKey(scopeUsername);
    const scopeUser = users[scopeKey];
    allowed = new Set([scopeKey, ...Object.keys((scopeUser && scopeUser.friends) || {})]);
  }

  const leaderboard = Object.entries(users)
    .filter(([key, user]) => user.stats && (!allowed || allowed.has(key)))
    .map(([key, user]) => ({
      username: user.username || key,
      avatar: user.avatar || null,
      totalZikrCount: user.stats.totalZikrCount || 0,
      totalStudied: user.stats.totalStudied || 0,
      correctAnswers: user.stats.correctAnswers || 0,
      friendsCount: Object.keys(user.friends || {}).length,
      lastActive: user.stats.lastActive
    }))
    .sort((a, b) => b.totalZikrCount - a.totalZikrCount)
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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();
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
  const userRes = await rtdbFetch(`/users/${encodeURIComponent(key)}.json`, env);
  const user = await userRes.json();
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
  const allRes = await rtdbFetch('/users.json', env);
  const users = await allRes.json();
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
    const tokensRes = await rtdbFetch(`/users/${encodeURIComponent(key)}/fcmTokens.json`, env);
    const tokensObj = await tokensRes.json();
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
