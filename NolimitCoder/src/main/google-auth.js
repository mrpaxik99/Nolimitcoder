// Google login for the DESKTOP app (installed-app OAuth flow).
//
// Security notes:
// - The desktop client_id below is PUBLIC by design (installed apps cannot
//   keep secrets). It is safe to ship in the app.
// - The client_secret lives ONLY in src/main/google-secret.json, which is
//   gitignored (never lands on GitHub) but IS packaged inside the .exe —
//   that is normal for desktop apps, Google does not treat it as confidential.
// - NEVER commit any *secret*.json / client_secret*.json file to git.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GOOGLE_CLIENT_ID = '426562479359-voba4pnfdh63vh5kkr510sg74hios155.apps.googleusercontent.com';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = ['openid', 'email', 'profile'];
const AUTH_FILE = 'auth.json';

// client_secret for the token exchange. Loaded from the gitignored
// src/main/google-secret.json (shipped inside the .exe, never in git).
// Newer Google Desktop clients reject the code exchange without it.
let CLIENT_SECRET = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, 'google-secret.json'), 'utf-8');
  CLIENT_SECRET = (JSON.parse(raw) || {}).client_secret || null;
} catch {
  CLIENT_SECRET = null;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthUrl(redirectUri, challenge, state) {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // ask for a refresh_token so login survives restarts
    prompt: 'consent',
    state
  });
  return `${AUTH_URL}?${q.toString()}`;
}

// Localhost callback server. Desktop-type Google clients accept any loopback
// port, so we bind a random free one (port 0).
// Returns { code: Promise<string>, listening: Promise<port> }.
function waitForCode(state, timeoutMs = 180000) {
  let server;
  const code = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const page = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="background:#101010;color:#eee;font-family:sans-serif;padding:40px"><h2>${msg}</h2><p>You can close this tab and return to NolimitCoder.</p></body></html>`);
      };
      const finish = (ok, msg) => {
        page(msg);
        try { server.close(); } catch {}
        ok ? resolve(ok) : reject(new Error(msg));
      };
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        // Wrong state = stray request: answer but keep waiting for the real one.
        if (u.searchParams.get('state') !== state) return page('Invalid state, try again.');
        const err = u.searchParams.get('error');
        if (err) return finish(null, 'Google login failed: ' + err);
        const c = u.searchParams.get('code');
        if (!c) return finish(null, 'No code received, try again.');
        finish(c, 'Logged in');
      } catch (e) {
        try { server.close(); } catch {}
        reject(e);
      }
    });
    const timer = setTimeout(() => { try { server.close(); } catch {} reject(new Error('Login timed out.')); }, timeoutMs);
    server.on('close', () => clearTimeout(timer));
    server.on('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const listening = new Promise((resolve, reject) => {
    const t = setInterval(() => {
      try {
        const a = server.address();
        if (a && a.port) { clearInterval(t); resolve(a.port); }
      } catch (e) { clearInterval(t); reject(e); }
    }, 10);
    setTimeout(() => { clearInterval(t); reject(new Error('Could not bind localhost.')); }, 5000);
  });
  return { code, listening };
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  return data;
}

// Full login: opens the system browser, waits for the localhost callback,
// exchanges the code (PKCE, no secret) and returns { profile, tokens }.
async function startLogin({ openUrl, timeoutMs } = {}) {
  if (typeof openUrl !== 'function') throw new Error('openUrl callback is required');
  const { verifier, challenge } = makePkce();
  const state = base64url(crypto.randomBytes(16));
  const cb = waitForCode(state, timeoutMs);
  const port = await cb.listening; // server is up before the browser opens
  const redirectUri = `http://127.0.0.1:${port}`;
  await openUrl(buildAuthUrl(redirectUri, challenge, state));
  const code = await cb.code;
  const tok = await postForm(TOKEN_URL, {
    client_id: GOOGLE_CLIENT_ID,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const profile = await fetchUserinfo(tok.access_token);
  return {
    profile,
    tokens: {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      expiry_date: Date.now() + (tok.expires_in || 3600) * 1000
    }
  };
}

async function fetchUserinfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`userinfo failed: HTTP ${res.status}`);
  const u = await res.json();
  return { sub: u.sub || null, name: u.name || null, email: u.email || null, picture: u.picture || null };
}

async function refreshAccessToken(refreshToken) {
  const tok = await postForm(TOKEN_URL, {
    client_id: GOOGLE_CLIENT_ID,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  return { access_token: tok.access_token, expiry_date: Date.now() + (tok.expires_in || 3600) * 1000 };
}

// Returns a valid access token, refreshing when expired. Returns null when
// the session cannot be refreshed anymore (user must log in again).
async function getValidAccessToken(session) {
  if (!session || !session.tokens) return null;
  if (session.tokens.access_token && session.tokens.expiry_date - Date.now() > 60000) {
    return session.tokens.access_token;
  }
  if (!session.tokens.refresh_token) return null;
  try {
    const r = await refreshAccessToken(session.tokens.refresh_token);
    session.tokens.access_token = r.access_token;
    session.tokens.expiry_date = r.expiry_date;
    return r.access_token;
  } catch {
    return null;
  }
}

async function revokeToken(token) {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(token),
      signal: AbortSignal.timeout(15000)
    });
  } catch {}
}

function authPath(userDataPath) {
  return path.join(userDataPath, AUTH_FILE);
}

function loadSession(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const s = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!s || !s.profile) return null;
    return s;
  } catch {
    return null;
  }
}

function saveSession(filePath, session) {
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

function clearSession(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function publicProfile(session) {
  if (!session || !session.profile) return null;
  const p = session.profile;
  return { name: p.name || null, email: p.email || null, picture: p.picture || null };
}

module.exports = {
  GOOGLE_CLIENT_ID,
  SCOPES,
  AUTH_FILE,
  makePkce,
  buildAuthUrl,
  waitForCode,
  startLogin,
  fetchUserinfo,
  refreshAccessToken,
  getValidAccessToken,
  revokeToken,
  authPath,
  loadSession,
  saveSession,
  clearSession,
  publicProfile
};
