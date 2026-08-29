/**
 * 99ism API Client
 * Handles communication with Cloudflare Worker backend
 * 99ism.ru's DNS isn't on Cloudflare (site is on GitHub Pages), so the
 * Worker can't be routed at 99ism.ru/api/* — it's served from its
 * workers.dev subdomain instead.
 */

const API_BASE = 'https://99ism-api.99ism-worker.workers.dev';

// Cache current auth credentials
let currentAuth = null;

// Plain btoa()/atob() only handle Latin1 and throw ("Invalid character") on
// anything outside that range, so a password with Cyrillic (or other
// non-Latin1) characters couldn't even be cached locally. These wrap the
// standard percent-encoding trick to make them UTF-8 safe while staying
// byte-for-byte identical to plain btoa()/atob() for ASCII input.
function b64EncodeUtf8(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode('0x' + hex)));
}
function b64DecodeUtf8(str) {
  return decodeURIComponent(atob(str).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}

function setAuthCredentials(username, password) {
  currentAuth = { username, password };
  localStorage.setItem('_auth_user', username);
  localStorage.setItem('_auth_pass', b64EncodeUtf8(password)); // Store encoded
}

function getAuthCredentials() {
  return currentAuth;
}

function clearAuthCredentials() {
  currentAuth = null;
  localStorage.removeItem('_auth_user');
  localStorage.removeItem('_auth_pass');
}

function loadAuthCredentials() {
  try {
    const user = localStorage.getItem('_auth_user');
    const pass = localStorage.getItem('_auth_pass');
    if (user && pass) {
      currentAuth = { username: user, password: b64DecodeUtf8(pass) };
      return currentAuth;
    }
  } catch (e) {}
  return null;
}

// Register new user. email is optional — when given, the server sends a
// verification code to it (see apiVerifyEmail) but the account works
// immediately either way.
async function apiRegister(username, password, securityQuestion, securityAnswer, email) {
  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        securityQuestion,
        securityAnswer,
        email: email || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Registration failed' };

    setAuthCredentials(username, password);
    return { ok: true, username, emailSent: data.emailSent };
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }
}

// Login user
async function apiLogin(username, password) {
  try {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Login failed' };

    setAuthCredentials(username, password);
    return { ok: true, username, stats: data.stats };
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }
}

// Sync progress to backend
async function apiSyncProgress(quizProgress, stats, incrementQuizzesCompleted, learnedNames) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/sync-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: auth.username,
        password: auth.password,
        quizProgress,
        stats,
        incrementQuizzesCompleted,
        learnedNames
      })
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Sync failed' };

    return { ok: true };
  } catch (e) {
    // Fallback to localStorage if network fails
    return { ok: false, cached: true };
  }
}

// Get user profile
async function apiGetProfile(username) {
  try {
    const res = await fetch(`${API_BASE}/api/profile/${encodeURIComponent(username)}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Profile not found' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Get friends list
async function apiGetFriends(username) {
  try {
    const res = await fetch(`${API_BASE}/api/friends/${encodeURIComponent(username)}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get friends' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Send a friend request (not an immediate friendship — the recipient has to accept)
async function apiAddFriend(friendUsername) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/add-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: auth.username,
        password: auth.password,
        friendUsername
      })
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to add friend' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Get incoming pending friend requests for the logged-in user
async function apiGetFriendRequests(username) {
  try {
    const res = await fetch(`${API_BASE}/api/friend-requests/${encodeURIComponent(username)}`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get friend requests' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiAcceptFriendRequest(fromUsername) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/accept-friend-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, fromUsername })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to accept request' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiDeclineFriendRequest(fromUsername) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/decline-friend-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, fromUsername })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to decline request' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiRemoveFriend(friendUsername) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/remove-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, friendUsername })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to remove friend' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiUpdateAvatar(emoji, color) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/update-avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, emoji, color })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to update avatar' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiTrackTime(seconds) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/track-time`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, seconds })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to track time' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiTrackZikr(count) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/track-zikr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, count })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to track zikr' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Register an FCM push token for the logged-in user. Goes through the worker
// (admin-authenticated) rather than a direct client-side RTDB write, since
// the fcmTokens security rule requires auth.uid === $uid and there's no
// Firebase Auth identity tied to a username/password account.
async function apiRegisterPushToken(username, password, token) {
  try {
    const res = await fetch(`${API_BASE}/api/register-push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, token })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to register push token' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Set daily reminder frequency for the logged-in user.
// frequency: 1, 2, or 3 (times per day).
async function apiSetReminder(frequency) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/set-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: auth.username,
        password: auth.password,
        frequency
      })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to set reminder' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Cancel daily reminder for the logged-in user.
async function apiCancelReminder() {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/cancel-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to cancel reminder' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Get total registered user count. Server-gated to a single admin account —
// returns an error for everyone else, so the caller just hides the stat then.

async function apiGetUserCount(username, password) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/user-count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get user count' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Get leaderboard. Pass a username to scope it to that user + their friends,
// and/or a metric ('totalZikrCount' default, or 'quranPagesRead') to rank by.
async function apiGetLeaderboard(username, metric) {
  try {
    const params = new URLSearchParams();
    if (username) params.set('username', username);
    if (metric) params.set('metric', metric);
    const qs = params.toString();
    const url = `${API_BASE}/api/leaderboard${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get leaderboard' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

/* =====================================================
   EMAIL ACCOUNT RECOVERY
===================================================== */

// Attach/replace the recovery email on the logged-in account. Sends a
// verification code to it (see apiVerifyEmail).
async function apiLinkEmail(email) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/link-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password, email })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to link email' };
    return { ok: true, emailSent: data.emailSent };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Confirm the 6-digit code sent to the linked email.
async function apiVerifyEmail(code) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, code })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Invalid code' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Re-send the verification code (server rate-limits to once/minute).
async function apiResendVerification() {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to resend code' };
    return { ok: true, emailSent: data.emailSent };
  } catch (e) {
    return { error: 'Network error' };
  }
}

// The logged-in account's own email + verified state (not exposed on the
// public profile endpoint).
async function apiGetAccountInfo() {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/account-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password: auth.password })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get account info' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Which "forgot password" path applies to this username/email — no auth
// needed, that's the whole point of a recovery flow.
async function apiResetMethod(identifier) {
  try {
    const res = await fetch(`${API_BASE}/api/reset-method`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to check recovery method' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}

// Sends a reset code to the account's verified email, if it has one. Always
// resolves to { ok: true } so the UI can't be used to probe which
// usernames/emails exist.
async function apiRequestPasswordReset(identifier) {
  try {
    const res = await fetch(`${API_BASE}/api/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to request reset' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiResetPasswordWithCode(identifier, code, newPassword) {
  try {
    const res = await fetch(`${API_BASE}/api/reset-password-with-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, code, newPassword })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to reset password' };
    return { ok: true, username: data.username };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiResetWithSecurityAnswer(identifier, answer, newPassword) {
  try {
    const res = await fetch(`${API_BASE}/api/reset-with-security-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, answer, newPassword })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to reset password' };
    return { ok: true, username: data.username };
  } catch (e) {
    return { error: 'Network error' };
  }
}

/* =====================================================
   ACCOUNT SETTINGS (change nickname / password)
===================================================== */

// password is the CURRENT password, re-typed by the user rather than read
// from the cache — this is a sensitive action, so it's worth confirming
// even though the cached credentials would technically also work.
async function apiChangePassword(password, newPassword) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password, newPassword })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to change password' };
    return { ok: true };
  } catch (e) {
    return { error: 'Network error' };
  }
}

async function apiChangeUsername(newUsername, password) {
  const auth = getAuthCredentials();
  if (!auth) return { error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_BASE}/api/change-username`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: auth.username, password, newUsername })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to change username' };
    return { ok: true, username: data.username };
  } catch (e) {
    return { error: 'Network error' };
  }
}
