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

function setAuthCredentials(username, password) {
  currentAuth = { username, password };
  localStorage.setItem('_auth_user', username);
  localStorage.setItem('_auth_pass', btoa(password)); // Store encoded
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
      currentAuth = { username: user, password: atob(pass) };
      return currentAuth;
    }
  } catch (e) {}
  return null;
}

// Register new user
async function apiRegister(username, password, securityQuestion, securityAnswer) {
  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        securityQuestion,
        securityAnswer
      })
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Registration failed' };

    setAuthCredentials(username, password);
    return { ok: true, username };
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
async function apiSyncProgress(quizProgress, stats, incrementQuizzesCompleted) {
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
        incrementQuizzesCompleted
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

// Get leaderboard. Pass a username to scope it to that user + their friends.
async function apiGetLeaderboard(username) {
  try {
    const url = username
      ? `${API_BASE}/api/leaderboard?username=${encodeURIComponent(username)}`
      : `${API_BASE}/api/leaderboard`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get leaderboard' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}
