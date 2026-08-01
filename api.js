/**
 * 99ism API Client
 * Handles communication with Cloudflare Worker backend
 * Uses Cloudflare Worker routes deployed to the same domain
 */

// Detect API base URL based on environment
const API_BASE = (function(){
  // If running on 99ism.ru, use the root domain (Cloudflare Worker)
  if (typeof window !== 'undefined' && window.location.hostname.includes('99ism.ru')) {
    return 'https://99ism.ru';
  }
  // For local development, use localhost
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  // Fallback
  return 'https://99ism.ru';
})();

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
async function apiSyncProgress(quizProgress, stats) {
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
        stats
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

// Add friend
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

// Get leaderboard
async function apiGetLeaderboard() {
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard`);
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Failed to get leaderboard' };
    return data;
  } catch (e) {
    return { error: 'Network error' };
  }
}
