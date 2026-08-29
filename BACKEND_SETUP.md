# 99ism Backend Setup Guide

## Prerequisites

- Cloudflare Workers account (free tier available)
- Firebase project with Realtime Database
- Node.js + npm (for Wrangler CLI)

## Installation

### 1. Setup Cloudflare Workers

```bash
npm install -g wrangler
wrangler login
```

### 2. Create wrangler.toml

Create file `wrangler.toml` in project root:

```toml
name = "99ism-api"
type = "javascript"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"
workers_dev = true
route = "99ism.ru/api/*"
zone_id = "YOUR_ZONE_ID"

[env.production]
vars = { ENVIRONMENT = "production" }

[[env.production.kv_namespaces]]
binding = "CACHE"
id = "YOUR_KV_NAMESPACE_ID"
```

### 3. Set Environment Secrets

```bash
wrangler secret put FCM_PROJECT_ID
wrangler secret put FCM_CLIENT_EMAIL
wrangler secret put FCM_PRIVATE_KEY
wrangler secret put SHARED_SECRET
wrangler secret put RESEND_API_KEY
```

**Note:** this repo actually deploys via `.github/workflows/deploy-worker.yml` on
every push to `main` that touches `cloudflare-worker.js`, not by running
`wrangler` locally — so in practice, secrets are set once as **GitHub Actions
secrets** (repo Settings → Secrets and variables → Actions) with the same
names, and the workflow's `secrets:`/`env:` block forwards them to
`wrangler secret put` on deploy. `RESEND_API_KEY` needs a Resend account
(resend.com) with a **verified sending domain** (e.g. 99ism.ru, via the DNS
records Resend provides) — without a verified domain, Resend can only
deliver to the account owner's own address, not to real end users.

**Where to get these:**
- Firebase: Settings → Service Account → Generate new private key
- `FCM_PROJECT_ID`: Your Firebase project ID
- `FCM_PRIVATE_KEY`: Full PEM key (keep newlines)
- `SHARED_SECRET`: Random string you create (e.g., `openssl rand -base64 32`)

### 4. Setup Firebase RTDB

1. Go to Firebase Console
2. Create Realtime Database (choose location closest to users)
3. Security Rules (in Firebase Console → Database → Rules):

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth.uid === $uid || root.child('users').child($uid).child('stats').exists()",
        ".write": "auth.uid === $uid",
        "password": { ".read": false, ".write": false },
        "securityAnswer": { ".read": false, ".write": false },
        "stats": {
          ".read": true,
          ".write": false
        },
        "friends": { ".read": true }
      },
      ".indexOn": ["stats/totalStudied"]
    },
    "leaderboard": {
      ".read": true,
      ".write": false
    }
  }
}
```

### 5. Deploy Worker

```bash
wrangler publish
```

### 6. Configure Route

In Cloudflare Dashboard:
- Workers → Routes → Add route
- Route: `99ism.ru/api/*`
- Worker: `99ism-api`

## API Endpoints

### POST /api/register
Register new user
```json
{
  "username": "user123",
  "password": "password",
  "securityQuestion": "What is your pet name?",
  "securityAnswer": "fluffy"
}
```

### POST /api/login
Login user
```json
{
  "username": "user123",
  "password": "password"
}
```

### POST /api/sync-progress
Sync quiz progress
```json
{
  "username": "user123",
  "password": "password",
  "quizProgress": { "sequential": 42 },
  "stats": { "totalStudied": 50, "correctAnswers": 45 }
}
```

### GET /api/profile/:username
Get user profile (public)

### GET /api/friends/:username
Get friends list

### POST /api/add-friend
Add friend
```json
{
  "username": "user123",
  "password": "password",
  "friendUsername": "friend456"
}
```

### GET /api/leaderboard
Get top 100 users by totalStudied

### Email account recovery
`POST /api/register` also accepts an optional `email` field. See the doc
comment at the top of `cloudflare-worker.js` for the full set of
email-linking/verification/password-reset endpoints
(`/api/link-email`, `/api/verify-email`, `/api/resend-verification`,
`/api/account-info`, `/api/reset-method`, `/api/request-password-reset`,
`/api/reset-password-with-code`, `/api/reset-with-security-answer`).

## Local Development

### 1. Install Wrangler locally

```bash
npm install wrangler --save-dev
```

### 2. Run local worker

```bash
npx wrangler dev cloudflare-worker.js
```

Worker will run on `http://localhost:8787`

### 3. Update api.js

Change in `api.js`:
```javascript
const API_BASE = 'http://localhost:8787';
```

## Monitoring

### View logs
```bash
wrangler tail
```

### Firebase RTDB monitoring
Go to Firebase Console → Realtime Database → Data tab

## Testing

Use the app to test:
1. Register a new account
2. Login from same device
3. Login from different device (should show same data)
4. Add friends
5. Check leaderboard
6. Complete quiz and check progress sync

## Troubleshooting

**401 Unauthorized**: Check password encoding (must match `btoa()`)
**404 Not Found**: Verify route is correctly configured in Cloudflare
**Firebase error**: Check security rules and database location
**Offline**: App falls back to localStorage - all data syncs when online

## Production Checklist

- [ ] Environment secrets configured in Wrangler
- [ ] Firebase security rules reviewed
- [ ] CORS headers properly set
- [ ] Database indexed on stats/totalStudied
- [ ] Monitoring/logging setup
- [ ] Rate limiting configured (optional)
- [ ] API documentation updated
- [ ] Backup strategy for Firebase (automatic)

## Security Notes

- Passwords are base64 encoded in transit (NOT encrypted - use HTTPS only)
- For production, consider implementing JWT tokens
- Never expose FCM private key in client code
- Use HTTPS-only APIs
- Implement rate limiting to prevent abuse
- Regular security audits recommended
