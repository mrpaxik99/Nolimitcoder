const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
// Elevated helper: this instance serves ONLY as an executor behind the pipe,
// no window, no lock, just a pipe client (launched elevated by the main app).
if (process.argv.includes('--elevated-helper')) {
  const idx = process.argv.indexOf('--elevated-helper');
  require('./elevated-helper').run(process.argv[idx + 1]);
  return;
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const T = require('./tools');
const PX = require('./proxy');
const VX = require('./video-export');
const ERR = require('./errlog');

// ===== Error Log (Logs/errors-AAAA-MM-DD.txt) =====
// Všechny chyby sem. Zapíná se Settings → Permissions → Log errors, default zapnutý.
let LOG_ERRORS = true;
process.on('uncaughtException', (e) => { try { ERR.logError('main/uncaught', e); } catch {} });
process.on('unhandledRejection', (e) => { try { ERR.logError('main/unhandledRejection', e); } catch {} });

// Download/install progress (download widget at bottom left) — tools.js calls the hook, we forward it to the window.
if (T.setProgressHook) T.setProgressHook((p) => {
  try { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('nlc-download', p); } catch {} } } catch {}
});

let mainWindow;
let abortFlag = false;

// Najde odinstalátor staré verze (pokud je aplikace nainstalovaná přes NSIS)
function findOldUninstaller() {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const files = fs.readdirSync(exeDir);
    const hit = files.find((f) => /^uninstall.*\.exe$/i.test(f));
    if (hit) {
      const full = path.join(exeDir, hit);
      if (fs.existsSync(full)) return full;
    }
  } catch {}
  try {
    const probe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'NolimitCoder V3', 'Uninstall NolimitCoder V3.exe');
    if (fs.existsSync(probe)) return probe;
  } catch {}
  return null;
}
function downloadFile(url, dest, onProg) {
  return new Promise((resolve, reject) => {
    const go = (u, depth) => {
      if (depth > 3) return reject(new Error('Too many redirects'));
      const mod = String(u).startsWith('https:') ? https : http;
      const req = mod.get(u, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let recvd = 0;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => { recvd += c.length; try { onProg && onProg(recvd, total); } catch {} });
        res.on('error', (e) => { try { ws.destroy(); } catch {} reject(e); });
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        res.pipe(ws);
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('timeout')); });
    };
    go(url, 0);
  });
}

// ===== Kontrola povolené verze (LIVE) =====
// Aplikace se pri startu a pak kazdou minutu zepta /api/app-status?version=X.
// Server cte live repo mrpaxik99/NolimitCoder-Download (60s cache + ETag):
//  - moje verze je nejvyssi v repu -> jede, pripadna stara blokace se schova
//  - v repu nic neni / moje verze tam neni -> zablokuje se + duvod + live warning
//  - warning se snima z WARNING.md v repu a ukazuje se v okne spolu s duvodem
// Vypadek site = nikdo se neblokuje (fail-open).
const APP_STATUS_URL = process.env.NLC_STATUS_URL || 'https://nolimitcoder.vercel.app/api/app-status';
const APP_STATUS_EVERY_MS = 60 * 1000;
async function checkAppBlocked() {
  try {
    const u = new URL(APP_STATUS_URL);
    u.searchParams.set('version', app.getVersion());
    const mod = u.protocol === 'https:' ? https : http;
    const data = await new Promise((resolve) => {
      const req = mod.get(u.toString(), { timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    });
    if (!data) return; // bez odpovedi se nic nemeni (ani se neodhlašuje blokace)
    const payload = {
      reason: data.reason || 'A newer version is required. Please download the latest version.',
      unavailable: data.unavailable === true,
      warning: String(data.warning || '').slice(0, 500),
      latest: data.latest || null
    };
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(data.blocked ? 'app:blocked' : 'app:unblocked', payload); } catch {}
    }
  } catch {}
}

try { app.setPath('userData', path.join(app.getPath('appData'), 'NolimitCoder V2')); } catch {} // data stays in the old folder even after renaming the exe
const STORE_PATH = path.join(app.getPath('userData'), 'config.json');

try { fs.mkdirSync(path.join(os.tmpdir(), 'nolimitcoder'), { recursive: true }); } catch {}
function getStore() {
  const defaults = {
    logErrors: true,          // zapisovat chyby do Logs/errors-AAAA-MM-DD.txt
    activeProject: null,      // full path to the project folder
    sound: true,              // sound after generation finishes
    terminal: 'auto',         // terminal always auto
    ollamaUrl: 'http://127.0.0.1:11434',
    lmstudioUrl: 'http://127.0.0.1:1234',

  };
  // Staré klíče (agent systém / pravidla oprávnění) se ze savefile mažou.
  // geminiCookie/geminiTemporary se taky uklízí — zbyly by v configu jen jako
  // mrtvý balast po odstraněném Gemini Web backendu.
  const LEGACY_KEYS = ['permissions', 'fullAccess', 'allowShell', 'allowInstall', 'allowNetwork', 'allowDelete', 'allowHeavy',
    'mode', 'defaultAgent', 'aiPermissions', 'aiAgents', 'aiCommands', 'aiCompaction',
    'geminiCookie', 'geminiTemporary'];
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      let dirty = false;
      for (const k of LEGACY_KEYS) if (k in raw) { delete raw[k]; dirty = true; }
      const merged = { ...defaults, ...raw };
      if (dirty) saveStore(merged);
      return merged;
    }
  } catch {}
  return { ...defaults };
}
function saveStore(data) {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2)); } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    fullscreenable: false,
    backgroundColor: '#101010',
    icon: path.join(__dirname, '../renderer/assets/logo.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#101010', symbolColor: '#ffffff9e', height: 44 } : undefined,
    frame: true,
    show: false,
    vibrancy: process.platform === 'darwin' ? 'ultra-dark' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    try { checkAppBlocked(); } catch {}
    setInterval(() => { try { checkAppBlocked(); } catch {} }, APP_STATUS_EVERY_MS);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // When the renderer crashes (OOM etc.), the whole app doesn't go down — it just reloads
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    try {
      const logPath = path.join(app.getPath('userData'), 'crash.log');
      fs.appendFileSync(logPath, `${new Date().toISOString()} render-process-gone: ${details?.reason || 'unknown'}\n`);
    } catch {}
    try { mainWindow.reload(); } catch {}
  });
}

process.on('uncaughtException', (e) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} uncaught: ${e && e.stack || e}\n`);
  } catch {}
});

// Single instance. On restart as administrator the new (elevated) instance announces
// itself with the --elevated-child flag and the old one quits on its own. A normal double-click
// just focuses the window (if you deny UAC, everything keeps running unchanged).
// DŮLEŽITÉ: elevovaný potomek zámek nedostane (drží ho rodič), ale nesmí se ukončit —
// to ON je nová hlavní instance, rodič skončí až po potvrzení v second-instance.
const isElevatedChild = process.argv.includes('--elevated-child');
let elevatedChildSeen = false; // rodič: potomek se opravdu rozběhl (pak se rodič ukončí)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isElevatedChild) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    try {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    } catch {}
    if ((argv || []).join(' ').includes('--elevated-child')) {
      elevatedChildSeen = true;
      setTimeout(() => { try { app.quit(); } catch {} }, 1500);
    }
  });
}

ipcMain.handle('sys:helperState', () => {
  try { return T.helperState(); } catch { return false; }
});

ipcMain.handle('sys:isAdmin', async () => {
  // net session only passes with elevated rights
  try {
    const { execFile } = require('child_process');
    const ok = await new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', 'net session'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
    });
    return !!ok;
  } catch { return false; }
});

ipcMain.handle('app:relaunchAdmin', async () => {
  // Relaunches THIS application as administrator (1x UAC prompt). The old instance
  // quits on its own via second-instance — if you deny UAC, nothing happens and it keeps running.
  try {
    try { saveNetMaps(); } catch {}
    const { execFile } = require('child_process');
    const exe = app.getPath('exe');
    const args = [...process.argv.slice(1).filter(a => !/^--squirrel/.test(a) && a !== '--elevated-child'), '--elevated-child'];
    const argStr = [exe, ...args].map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Start-Process -FilePath ${argStr.split(',')[0]} -ArgumentList ${argStr.split(',').slice(1).join(',') || '$null'} -Verb RunAs -WindowStyle Normal`
    ], { windowsHide: true });
    return true;
  } catch { return false; }
});

app.whenReady().then(async () => {
  // ===== Síťové disky po zvýšení oprávnění =====
  // Elevovaný proces běží s jiným tokenem a mapované síťové disky (Z: WebDAV)
  // v něm nejsou — v dialogu bys je neviděl. Potomek si je proto hned připojí zpět.
  if (process.platform === 'win32' && process.argv.includes('--elevated-child')) {
    try { restoreNetMaps(); } catch {}
  }
  // ===== Plná administrace: aplikace se sama spustí jako Administrator =====
  // Jediný UAC prompt je při startu (Windows ho nepřeskakuje). Po něm běží vše
  // jako admin a už se nikdy nic neptá.
  if (process.platform === 'win32' && !process.argv.includes('--elevated-child')) {
    try {
      const admin = await new Promise((res) => {
        const { execFile } = require('child_process');
        execFile('cmd.exe', ['/d', '/c', 'net session'], { timeout: 10000, windowsHide: true }, (err) => res(!err));
      });
      if (!admin) {
        let spawned = false;
        // Mapované síťové disky (Z: WebDAV) neadmin proces vidí, elevovaný ne.
        // Uložíme je, než se zvýšíme oprávnění, a potomek je připojí zpět.
        try { saveNetMaps(); } catch {}
        try {
          const exe = app.getPath('exe');
          const args = [...process.argv.slice(1).filter(a => !/^--squirrel/.test(a) && a !== '--elevated-child'), '--elevated-child'];
          const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
          await new Promise((res) => {
            require('child_process').execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
              `Start-Process -FilePath ${q(exe)} -ArgumentList ${args.length ? args.map(q).join(',') : '$null'} -Verb RunAs`
            ], { windowsHide: true }, () => res());
          });
          spawned = true;
        } catch {}
        if (spawned) {
          // Čekej na potvrzení, že potomek běží (second-instance). Když UAC odmítneš,
          // nic se neozve → jeď dál normálně jako ne-admin, okno se otevře.
          const seen = await new Promise((res) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
              if (elevatedChildSeen || (Date.now() - t0) > 20000) { clearInterval(iv); res(elevatedChildSeen); }
            }, 250);
          });
          if (seen) { try { app.quit(); } catch {} return; }
        }
      }
    } catch {}
  }
  createWindow();
  // Proxy pool (ProxyScrape free list): load bundled + cache, download fresh ones in the background.
  try {
    const cacheDir = path.join(app.getPath('userData'), 'proxies');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    try { PX.loadProxies(cacheDir); } catch {}
    try { T.dbgLog('proxy', { act: 'init', counts: PX.counts() }); } catch {}
    // silent refresh after startup (doesn't block the window), then every 30 min
    setTimeout(async () => { try { await PX.refreshProxies(cacheDir); } catch {} }, 8000);
    setInterval(async () => { try { await PX.refreshProxies(cacheDir); } catch {} }, 30 * 60 * 1000);
  } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ===== IPC =====

ipcMain.handle('store:get', () => getStore());
ipcMain.handle('store:set', (_, data) => {
  const cur = getStore();
  const next = { ...cur, ...data };
  // Hodnota null = klíč smazat (očista starých klíčů)
  if (data) for (const k of Object.keys(data)) if (data[k] === null) delete next[k];
  saveStore(next);
  // přepínač "Log errors" má platit hned, ne až při dalším tool callu
  if (data && 'logErrors' in data) { try { LOG_ERRORS = next.logErrors !== false; } catch {} }
  return next;
});

// ===== Google account (desktop OAuth, PKCE — no secret in the app) =====
const GA = require('./google-auth');
const authFile = () => GA.authPath(app.getPath('userData'));
let loginBusy = false;
function broadcastAuth(session) {
  const pub = GA.publicProfile(session);
  try { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('auth:changed', pub); } catch {} } } catch {}
}
ipcMain.handle('auth:status', async () => {
  const s = GA.loadSession(authFile());
  if (!s) return { loggedIn: false };
  const token = await GA.getValidAccessToken(s);
  if (!token) { GA.clearSession(authFile()); return { loggedIn: false }; }
  GA.saveSession(authFile(), s); // persist refreshed expiry
  return { loggedIn: true, profile: GA.publicProfile(s) };
});
ipcMain.handle('auth:login', async () => {
  if (loginBusy) return { loggedIn: false, error: 'Login already in progress.' };
  loginBusy = true;
  try {
    const res = await GA.startLogin({ openUrl: (url) => shell.openExternal(url) });
    const session = { profile: res.profile, tokens: res.tokens, at: Date.now() };
    GA.saveSession(authFile(), session);
    broadcastAuth(session);
    return { loggedIn: true, profile: GA.publicProfile(session) };
  } catch (e) {
    return { loggedIn: false, error: (e && e.message) || 'Login failed.' };
  } finally {
    loginBusy = false;
  }
});
ipcMain.handle('auth:logout', async () => {
  const s = GA.loadSession(authFile());
  if (s && s.tokens && s.tokens.access_token) await GA.revokeToken(s.tokens.access_token);
  GA.clearSession(authFile());
  broadcastAuth(null);
  return { loggedIn: false };
});

ipcMain.handle('app:version', () => app.getVersion());
// ===== Samo-aktualizace: stáhne nový instalátor a tiše přeinstaluje =====
ipcMain.handle('app:update', async (event, url) => {
  const sender = event.sender;
  const send = (d) => { try { sender.send('app:update-progress', d); } catch {} };
  try {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Bad URL' };
    const dir = path.join(os.tmpdir(), 'nolimitcoder');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const dest = path.join(dir, 'NolimitCoder-Update.exe');
    try { fs.unlinkSync(dest); } catch {}
    await downloadFile(u, dest, (recvd, total) => send({
      pct: total > 0 ? Math.round((recvd / total) * 100) : -1,
      mb: Math.round(recvd / 1048576),
      totalMb: total > 0 ? Math.round(total / 1048576) : 0
    }));
    send({ done: true, replacing: true });
    // Nejprv TIŠE odinstalovat starou verzi, pak nainstalovat novou.
    // Běží v odděleném cmd (s 3s zpožděním, aby se aplikace stihla ukončit a nezamkla soubory).
    try {
      const { spawn } = require('child_process');
      const oldUn = findOldUninstaller();
      let chain = 'timeout /t 3 /nobreak >nul';
      if (oldUn) chain += ' & "' + oldUn + '" /S';
      chain += ' & "' + dest + '" /S';
      spawn('cmd.exe', ['/d', '/s', '/c', chain],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
    setTimeout(() => { try { app.quit(); } catch {} }, 500);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    send({ error: msg });
    return { ok: false, error: msg };
  }
});
ipcMain.handle('app:paths', () => ({
  userData: app.getPath('userData'),
  storePath: STORE_PATH
}));

// 429 = free quota exhausted. Retry-After (s) from the header, max 300.
function parseRetryAfterMs(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(n, 300) * 1000;
}
// 403 RegionError = the country is blocked for the model (geo-ban).
function isGeoBlockedBody(s) {
  return /RegionError|not available in your country/i.test(String(s || ''));
}

// Model list: direct first, on quota/429 automatically via a random proxy from the pool.
ipcMain.handle('net:fetch-zen-models', async (_, apiKey) => {
  const url = 'https://opencode.ai/zen/v1/models';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const direct = await new Promise((resolve) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429 || PX.isQuotaStatus(res.statusCode, data)) {
          PX.onQuotaHit(parseRetryAfterMs(res.headers && res.headers['retry-after']));
          resolve({ quota: true, status: res.statusCode, body: data.slice(0, 500) });
        } else {
          try { resolve({ ok: true, data: JSON.parse(data), via: 'direct' }); } catch { resolve({ ok: false, error: data.slice(0,500), via: 'direct' }); }
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message, via: 'direct' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: 'timeout', via: 'direct' }); });
  });
  if (!direct.quota) return direct;
  // quota → try 3 random proxies quickly in a row
  for (let i = 0; i < 3; i++) {
    const proxy = PX.getRandomProxy();
    if (!proxy) break;
    PX.onProxySwitch(proxy);
    broadcastProxyStatus();
    const r = await PX.fetchViaProxy(url, { method: 'GET', headers, proxy, timeout: 12000 });
    if (r.ok) {
      try { PX.markGood(); return { ok: true, data: JSON.parse(r.body), via: proxy.str }; }
      catch { return { ok: false, error: String(r.body).slice(0, 500), via: proxy.str }; }
    }
    PX.markBad(proxy);
  }
  return { ok: false, error: `quota 429 even via proxy (tried 3x) — ${direct.body || ''}`.slice(0, 500), via: 'direct+proxy', isRateLimit: true };
});

// ===== PROXY pool (ProxyScrape) — status / refresh / list for the UI =====
function broadcastProxyStatus() {
  try {
    const st = PX.status();
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('proxy:status', st); } catch {} }
  } catch {}
}
ipcMain.handle('proxy:status', () => { try { return PX.status(); } catch { return { counts: { total: 0 } }; } });
ipcMain.handle('proxy:refresh', async () => {
  try {
    const cacheDir = path.join(app.getPath('userData'), 'proxies');
    const r = await PX.refreshProxies(cacheDir);
    broadcastProxyStatus();
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

function fetchLocalModels(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(urlStr, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data) }); } catch { resolve({ ok: false, error: data.slice(0,500), status: res.statusCode }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

ipcMain.handle('net:discover-local', async () => {
  const store = getStore();
  const results = {};
  // Ollama tags
  const ollamaTags = await fetchLocalModels(`${store.ollamaUrl}/api/tags`);
  results.ollamaTags = ollamaTags;
  // Ollama OpenAI compat
  const ollamaModels = await fetchLocalModels(`${store.ollamaUrl}/v1/models`);
  results.ollamaModels = ollamaModels;
  // LM Studio
  const lm = await fetchLocalModels(`${store.lmstudioUrl}/v1/models`);
  results.lmstudio = lm;
  // vLLM
  const vllm = await fetchLocalModels(`http://127.0.0.1:8000/v1/models`);
  results.vllm = vllm;
  // local AI server
  const localai = await fetchLocalModels(`http://127.0.0.1:4096/config`);
  results.localai = localai;
  return results;
});

// ===== PROJECTS — projects folder (create / rename / delete / pick) =====
function projectsDir() {
  const d = path.join(app.getPath('userData'), 'projects');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function safeName(n) {
  return String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80);
}

ipcMain.handle('projects:dir', () => projectsDir());

ipcMain.handle('projects:list', () => {
  try {
    return fs.readdirSync(projectsDir(), { withFileTypes: true })
      .filter(e => { try { return e.isDirectory(); } catch { return false; } })
      .map(e => e.name).sort((a, b) => a.localeCompare(b, 'cs'));
  } catch { return []; }
});

ipcMain.handle('projects:create', (_, name) => {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'Empty name' };
  const p = path.join(projectsDir(), n);
  if (fs.existsSync(p)) return { ok: false, error: 'Folder already exists' };
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, name: n, path: p };
});

ipcMain.handle('projects:rename', (_, oldName, newName) => {
  const o = safeName(oldName), n = safeName(newName);
  if (!o || !n) return { ok: false, error: 'Invalid name' };
  const op = path.join(projectsDir(), o), np = path.join(projectsDir(), n);
  if (!fs.existsSync(op)) return { ok: false, error: 'Project does not exist' };
  if (fs.existsSync(np)) return { ok: false, error: 'Target already exists' };
  try { fs.renameSync(op, np); } catch (e) { return { ok: false, error: e.message }; }
  const st = getStore();
  if (st.activeProject === op) { st.activeProject = np; saveStore(st); }
  return { ok: true, name: n, path: np };
});

ipcMain.handle('projects:delete', (_, name) => {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'Invalid name' };
  const p = path.join(projectsDir(), n);
  if (!fs.existsSync(p)) return { ok: false, error: 'Project does not exist' };
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
  const st = getStore();
  if (st.activeProject === p) { st.activeProject = null; saveStore(st); }
  return { ok: true };
});

ipcMain.handle('projects:renamePath', (_, oldPath, newName) => {
  const n = safeName(newName);
  if (!n) return { ok: false, error: 'Invalid name' };
  const op = path.resolve(String(oldPath || ''));
  if (!op || !fs.existsSync(op)) return { ok: false, error: 'Folder does not exist' };
  const np = path.join(path.dirname(op), n);
  if (fs.existsSync(np)) return { ok: false, error: 'Target already exists' };
  try { fs.renameSync(op, np); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, path: np, name: n };
});

ipcMain.handle('projects:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
const TEXT_EXT = new Set(['.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.json', '.py', '.html', '.css', '.c', '.cpp', '.h', '.java', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.ps1', '.vue', '.svelte']);

// ===== Sken složky: ASYNCHRONNÍ, BEZ ČASOVÉHO STROPU =====
// Dřív šlo o readdirSync v hlavním procesu. Na síťovém disku (Z: WebDAV) trval
// jeden readdir 3,2 s a sken celé složky desítky sekund — hlavní proces v tu dobu
// nezpracoval žádné události, Windows prohlíčič ukázal "neodpovídá" a UI zamrzlo.
// Teď je vše fs.promises: event loop žije, okno je živé a sken běží na pozadí.
// BEZ limitu na čas — jen mírná pojistka na počet položek, aby prompt nezasypl.
const TREE_ITEM_CAP = 5000;
const projTreeCache = new Map(); // root -> { tree, at, scanning, promise, partial }

// Sken na Z: (WebDAV) trvá MINUTY. Proto se výsledky zveřejňují UŽ BĚHEM skenu:
// cache roste po částech a AI ho v každé zprávě vidí tolik, kolik je zatím známo.
// Žádný časový limit, žádný freeze — jen postupné naplňování.
// Yield control to event loop every N items — na síťovém disku (Z: WebDAV)
// jinak blokujeme event loop a celá aplikace se zpomaluje během AI generování.
const YIELD_EVERY = 200;
let yieldCounter = 0;
function yieldToEventLoop() {
  if (++yieldCounter >= YIELD_EVERY) {
    yieldCounter = 0;
    return new Promise(r => setImmediate(r));
  }
  return Promise.resolve();
}
async function scanProjectTree(root, onProgress) {
  const tree = [];
  let truncated = false;
  let lastPub = 0;
  const publish = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastPub < 400) return;   // nepublikovat příliš často
    lastPub = now;
    onProgress(tree);
  };
  const walk = async (dir, rel) => {
    if (tree.length >= TREE_ITEM_CAP) { truncated = true; return; }
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    publish();
    for (const e of entries) {
      if (tree.length >= TREE_ITEM_CAP) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        tree.push({ path: rp + '/', dir: true });
        await walk(path.join(dir, e.name), rp);   // await = node diky, ale event loop nezamrzne
      } else if (e.isFile()) {
        tree.push({ path: rp, dir: false });
        publish();
      }
      // Yield to event loop — na síťovém disku jinak blokujeme celou aplikaci
      await yieldToEventLoop();
    }
  };
  await walk(root, '');
  return { tree, truncated };
}

// Vrati hotovy strom HNED (z cache). Pokud prave bezi sken, vrati stary/nic — nikdy neceka.
async function getTreeCached(root, { awaitScan } = {}) {
  const hit = projTreeCache.get(root);
  // cache existuje (i když sken ještě běží) → vrať co máme HNED
  if (hit && hit.tree && hit.tree.length) return { tree: hit.tree, truncated: hit.truncated, scanning: !!hit.scanning, partial: !!hit.partial };
  if (awaitScan) { const r = await scanAndStore(root); return { tree: r.tree, truncated: r.truncated }; }
  // studená cache: rozbehneme sken na pozadí, nečekáme
  scanAndStore(root).catch(() => {});
  return { tree: [], truncated: false, scanning: true };
}
function scanAndStore(root) {
  const prev = projTreeCache.get(root);
  if (prev && prev.promise) return prev.promise;
  // Cache roste během skenu — každá zpráva vidí to, co už AI systém objevil.
  projTreeCache.set(root, { tree: (prev && prev.tree) || [], truncated: false, at: prev ? prev.at : 0, scanning: true, partial: true });
  const promise = scanProjectTree(root, (partial) => {
    const c = projTreeCache.get(root);
    if (c) { c.tree = partial; }   // průběžná aktualizace, bez čekání na dočtení
  })
    .then((r) => {
      projTreeCache.set(root, { tree: r.tree, truncated: r.truncated, at: Date.now(), scanning: false });
      try { T.dbgLog('projscan', { root, items: r.tree.length, truncated: r.truncated }); } catch {}
      return r;
    })
    .catch(() => { projTreeCache.set(root, { tree: [], truncated: false, at: Date.now(), scanning: false }); return { tree: [], truncated: false }; });
  projTreeCache.get(root).promise = promise;
  return promise;
}
// Vynutit novy sken (po zmene slozky) — stale pri spusteni, at se to neopakuje donekonecna.
setInterval(() => {
  for (const [root, v] of projTreeCache) if (v.at && Date.now() - v.at > 300000) projTreeCache.delete(root);
}, 60000);

// Rozbehne sken složky na pozadí a VRÁTÍ SE HNED (bez čekání na Z:).
// Renderer to volá při odeslání, aby AI dostal soubory od druhé zprávy, ale UI nikdy nečeká.
ipcMain.handle('projects:scanAsync', async (_, dirPath) => {
  try {
    const root = path.resolve(String(dirPath || ''));
    if (!root || !fs.existsSync(root)) return { ok: false };
    scanAndStore(root).catch(() => {});
    return { ok: true, started: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('projects:files', async (_, dirPath, includeContents, nonBlocking) => {
  const root = path.resolve(String(dirPath || ''));
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  // nonBlocking = true (cesta pri odeslani): vrat HNED to, co je v cache, a spusť sken
  // na pozadí. Na Z: by cekání trvalo desítky sekund a okno by vypadalo mrtve.
  const res = await getTreeCached(root, { awaitScan: !nonBlocking });
  const tree = res.tree || [];
  const contents = {};
  if (includeContents) {
    let budget = 60000;
    for (const t of tree) {
      if (t.dir || budget <= 0) continue;
      if (!TEXT_EXT.has(path.extname(t.path).toLowerCase())) continue;
      try {
        const abs = path.join(root, t.path);
        const st = await fs.promises.stat(abs);          // async — na Z: to trvá stovky ms
        if (st.size > 40000) continue;
        const txt = await fs.promises.readFile(abs, 'utf-8');
        const slice = txt.slice(0, Math.min(txt.length, budget));
        contents[t.path] = slice;
        budget -= slice.length;
      } catch {}
    }
  }
  return { ok: true, root, tree, contents, truncated: res.truncated, scanning: !!res.scanning };
});

ipcMain.handle('projects:openPath', (_, p) => {
  // Bez validace Windows ukáže systémový dialog "nemůže nalézt" — ten nikdy nechceme.
  try {
    const s = String(p || '').trim();
    if (!s || /^[\\/]+$/.test(s)) return false;
    const abs = path.normalize(s);
    if (!fs.existsSync(abs)) return false;
    try {
      const r = shell.openPath(abs);
      Promise.resolve(r).then((e) => { if (e) { try { ERR.logError('openPath', e, { path: abs }); } catch {} } }).catch(() => {});
    } catch {}
    return true;
  } catch { return false; }
});

ipcMain.handle('sys:knownFolders', () => {
  const home = os.homedir();
  return {
    documents: path.join(home, 'Documents'),
    desktop: path.join(home, 'Desktop'),
    downloads: path.join(home, 'Downloads'),
    home
  };
});

// ===== NOLIMIT FREE TIER via the gateway (no user API key) =====
// Generation source: the NolimitCoder gateway (client fingerprint in the headers below).
// Auth: Bearer public + official client fingerprint.
// Gatekeeper (since 19.9.2026) requires: stream:true + tools [shell, read] + fingerprint.
// Verified 24.9.2026: 7x /chat/completions + 2x /responses works without a key.

const API_BASE = 'https://opencode.ai/zen/v1';

function genSessionId() {
  const hex = '0123456789abcdef';
  const b62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = 'ses_';
  for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
  for (let i = 0; i < 14; i++) s += b62[Math.floor(Math.random() * 62)];
  return s;
}
// Stable session per conversation (better cache + routing), per-request id unique
const sessionCache = new Map();
function getSessionId(convoId) {
  if (!convoId) return genSessionId();
  if (!sessionCache.has(convoId)) sessionCache.set(convoId, genSessionId());
  return sessionCache.get(convoId);
}

// ===== FILE TOOLS — complete tool set (executed in tools.js) =====
// Gatekeeper requires a tool named shell (+read) — that's why shell is always in the list.
// agent=true only when there are real tools to reach.
const P = (properties, required) => ({ type: 'object', properties, required: required || Object.keys(properties) });
const STR = (d) => ({ type: 'string', description: d || '' });
const SHELL_REAL = { type: 'function', name: 'shell', description: `Execute a shell command (Windows cmd.exe on win32).

Use %TEMP%/nolimitcoder for temporary work outside the workspace. This directory already exists and is pre-approved.

NEVER write file content through this tool. Writing code with shell one-liners (echo > file, PowerShell here-strings @'...'@, Set-Content, cat <<EOF, redirecting a long string) always fails: cmd.exe truncates the command line at 8191 characters and PowerShell here-strings need the '@ terminator on its own line. To create or change a file, use write_file (new content), append_file (add to the end) or edit_file (precise change) — they have no length limit and no quoting problems.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`if exist\` to verify the parent directory exists and is the correct location.
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - Optional timeout in milliseconds (default 120000, max 900000 — use 600000 for npm install/build). Output over ~20KB is truncated.
  - Independent commands: make multiple shell calls in a single message to run them in parallel.
  - Dependent commands: chain with && in a single call (e.g. \`mkdir out && dir out\`). Use ';' only when you don't care if earlier commands fail.
  - AVOID \`cd <directory> && <command>\`. Use the workdir parameter instead.
  -   Verify compilers via env_scan first; install missing ones via env_prepare (it auto-installs from the internet). Explain non-critical commands in one sentence.

Terminals: cmd (default), powershell, pwsh. The backend parameter selects one (default auto = try in order, on incompatibility auto-switch to the next).

# Git and GitHub
- Only commit, amend or push when explicitly requested. Before committing, inspect \`git status\`, \`git diff\`, \`git log --oneline -10\`; stage only intended files, never commit secrets. Write a concise commit message.
- Use \`gh\` for GitHub tasks and return the PR URL when done.`, parameters: P({ command: STR('The command to execute'), timeout: { type: 'number', description: 'Optional timeout in milliseconds (default 120000, max 900000)' }, workdir: STR('The working directory to run the command in. Defaults to the project folder. Use this instead of cd commands.'), backend: STR('cmd | powershell | pwsh | auto (default auto)') }, ['command']) };
// The gateway gatekeeper requires the list to contain a tool named "shell" and "read".
// In hidden runs (no agent) these are intentionally dead plugs so the model calls nothing.
// In build mode ONLY real tools are sent (no duplicate names!).
const READ_GATE = { type: 'function', name: 'read', description: 'Read a text file (alias of read_file).', parameters: P({ path: STR('Path to the file') }) };
const SHELL_GATE = { type: 'function', name: 'shell', description: 'INTERNAL ONLY — never call this tool in chat mode.', parameters: P({ command: STR('ignored, do not use') }) };
const DUMMY_TOOLS_RESP = [ SHELL_GATE, READ_GATE ];
const AGENT_TOOLS_RESP = [
  SHELL_REAL,
  READ_GATE,
  { type: 'function', name: 'write_file', description: 'Writes a text file (creates subfolders too). Instead of printing code into the chat, ALWAYS write it with this tool. This is also the ONLY safe way to create a file with long content — writing it through shell (echo >, PowerShell here-string @\'…\'@, Set-Content, cat <<EOF) fails on anything over ~8 KB, because cmd.exe truncates the command line at 8191 characters.', parameters: P({ path: STR('Relative path to the project or absolute path'), content: STR('Entire file content') }, ['path', 'content']) },
  { type: 'function', name: 'append_file', description: 'Appends text to the end of a file (creates the file if needed).', parameters: P({ path: STR('Path to the file'), content: STR('Text to append') }, ['path', 'content']) },
  { type: 'function', name: 'edit_file', description: 'Precise file edit: oldString must match exactly 1x in the file, otherwise send a larger context or replaceAll: true.', parameters: P({ path: STR('Path to the file'), oldString: STR('Exact original text'), newString: STR('New text') }, ['path', 'oldString', 'newString']) },
  { type: 'function', name: 'read_file', description: 'Reads a text file (max 40 KB).', parameters: P({ path: STR('Path to the file') }) },
  { type: 'function', name: 'list_dir', description: 'Lists files and subfolders in a folder. USE THIS INSTEAD of shell probes like "dir /b", "ls", "if exist" or "test -f" — one call, no exit codes, no error when the folder is missing.', parameters: P({ path: STR('Path to the folder, "." = project') }) },
  { type: 'function', name: 'glob_file', description: 'Finds files by pattern (e.g. **/*.js, src/*.py).', parameters: P({ pattern: STR('Glob pattern'), dir: STR('Where to search, default "."') }, ['pattern']) },
  { type: 'function', name: 'create_dir', description: 'Creates a folder including subfolders.', parameters: P({ path: STR('Path to the folder') }) },
  { type: 'function', name: 'move_file', description: 'Moves or renames a file (images too) between folders.', parameters: P({ from: STR('Source path'), to: STR('Target path') }, ['from', 'to']) },
  { type: 'function', name: 'copy_file', description: 'Copies a file (image too) to another folder.', parameters: P({ from: STR('Source path'), to: STR('Target path') }, ['from', 'to']) },
  { type: 'function', name: 'delete_file', description: 'Deletes a file.', parameters: P({ path: STR('Path to the file') }) },
  { type: 'function', name: 'file_info', description: 'Info about a file/folder: size, date, type, whether it exists. USE THIS INSTEAD of shell existence checks ("if exist", "test -f", "dir", "type") — it never fails and never needs quoting.', parameters: P({ path: STR('Path') }) },
  { type: 'function', name: 'search_files', description: 'Searches text in project files (grep).', parameters: P({ pattern: STR('Text to search'), dir: STR('Where to search, default "."'), ext: STR('Extension without a dot, e.g. js (optional)') }, ['pattern']) },
  { type: 'function', name: 'open_path', description: 'Opens a file/folder in the system (Explorer).', parameters: P({ path: STR('Path') }) },
  { type: 'function', name: 'close_app', description: 'Closes an app YOU opened (exe by name or path, or the preview server by its http://127.0.0.1:port URL). Do NOT use this to "verify" a built exe by opening it in front of the user and closing it after half a second — that looks like a crash. EXE verification is done by the build_exe tool (it launch-tests itself) — whatever you opened for testing, you close. Never leave test windows running for the user.', parameters: P({ target: STR('exe name (app.exe), full exe path, or http://127.0.0.1:port preview URL') }, ['target']) },
  { type: 'function', name: 'show_panel', description: 'Opens a file in a NEW TAB of the app side panel (slides from the right) so the user sees it immediately: HTML preview, image, text, or an exe run card with Start/Stop buttons. Multiple calls = multiple tabs. ALWAYS call this when you finish something viewable/runnable instead of only describing it.', parameters: P({ path: STR('file to show (relative to project or absolute)'), mode: STR('optional: "run" = also launch exe right away') }, ['path']) },
  { type: 'function', name: 'web_fetch', description: 'Downloads the text of a web page (https URL).', parameters: P({ url: STR('https://…') }, ['url']) },
  { type: 'function', name: 'web_search', description: 'Searches anything on the internet (full web access).', parameters: P({ query: STR('Search query') }, ['query']) },
  { type: 'function', name: 'download_file', description: 'Downloads a file from the internet to disk (https URL → path). Handles large files too.', parameters: P({ url: STR('https://…/file.zip'), to: STR('Where to save (relative to the project or absolute)') }, ['url', 'to']) },
  { type: 'function', name: 'env_scan', description: 'Scans the computer and finds what is already installed (node, npm, python, pip, git, gcc/g++, MSVC, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, 7-Zip) and what the active project and the user request need. Installs nothing. Call AT THE START when you are going to build, compile or run something.', parameters: P({ request: STR('Optional: exactly what the user wants, e.g. "make a C++ program and compile an exe"') }) },
  { type: 'function', name: 'env_prepare', description: 'Finds what is needed (project + user request + planned commands) and installs ALL missing pieces ITSELF: winget → Chocolatey → Scoop → downloading from the internet into the app, then keeps working right away. Before telling the user to install something, call this. Large toolchains (Visual Studio Build Tools, Docker, Android Studio) are not installed without asking — ask first with the question tool and then call again with heavy: true.', parameters: P({ request: STR('What the user wants, in their own words'), ids: { type: 'array', items: STR('toolchain id'), description: 'Optional: specific toolchains instead of auto selection' }, heavy: { type: 'boolean', description: 'Allow large installs (GB) — only when the user agreed' } }) },
  { type: 'function', name: 'env_install', description: 'Installs specific toolchains via winget/Chocolatey/Scoop, otherwise downloads them from the internet (node, python, git, gcc, msvc, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, sevenzip, android). Call only when env_scan showed something is missing.', parameters: P({ id: STR('one id, or more separated by comma'), ids: { type: 'array', items: STR('toolchain id'), description: 'use instead of id when you want more toolchains' }, heavy: { type: 'boolean', description: 'Allow large installs (GB)' } }) },
  { type: 'function', name: 'scaffold_electron', description: 'Creates a working Electron project skeleton (package.json + main.js + index.html) for an EXE app. ALWAYS call as the first step when the user wants an Electron/desktop exe app. Scaffold DIRECTLY into the already-selected project folder (dir: ".") — create a NEW subfolder ONLY if the user explicitly asked for one. Files belong STRAIGHT in the selected folder. Then write the code, run shell npm install (timeout 600000) and npm run dist (timeout 600000).', parameters: P({ dir: STR('Project folder: "." = the already-selected folder (default), or a NEW subfolder only when the user asked for one'), name: STR('App name') }, ['dir']) },
  { type: 'function', name: 'question', description: 'Ask the user when you need a decision or clarification (e.g. which technology to pick). Show them options to choose from.', parameters: P({ questions: { type: 'array', description: 'Questions (1-3)', items: { type: 'object', properties: { header: STR('Short heading'), question: STR('Question'), options: { type: 'array', items: { type: 'object', properties: { label: STR('Option name'), description: STR('Option description') } } }, multiple: { type: 'boolean', description: 'Multiple choices at once' } } } } }, ['questions']) },
  // ---- build_exe: kompletni pipeline EXE (inventura -> oprava package.json -> npm install -> plny rebuild -> verifikace -> launch-test) ----
  { type: 'function', name: 'build_exe', description: 'Builds the project into a working Windows .exe — ALWAYS call this as the LAST step of every EXE/desktop app, instead of running npm/dist commands yourself. Call it ONCE per task — if it returns HOTOVO - 100%, the exe is done, never call it again just to "verify". It does everything: checks that every file index.html points to exists, auto-fixes package.json (scripts.dist, devDependencies, complete build.files, output back to dist), runs npm install when needed, performs a FULL rebuild (any changed file triggers a real rebuild, dist/ is created automatically when missing), verifies the exe is fresh and the asar contains all files, and launch-tests the exe (starts it, must run 4 s, then kills it). It builds in the SELECTED project folder itself — if package.json is only in a subfolder, move the files up first. Only when literally zero files changed since the last successful build does it instantly return the existing exe (it also recognizes an exe you built manually via shell — no double build). Returns a step-by-step report ending with HOTOVO - 100% and the exe path. NEVER "test" by opening the exe yourself in front of the user and closing it after half a second — this tool does the launch-test itself.', parameters: P({ target: STR('Optional: nsis (installer, default), portable (single exe) or dir (unpacked folder)') }) }
];
const DUMMY_TOOLS_CHAT = DUMMY_TOOLS_RESP.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
const AGENT_TOOLS_CHAT = AGENT_TOOLS_RESP.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

function helperLaunch() {
  try {
    return {
      exe: app.getPath('exe'),
      args: app.isPackaged ? [] : [app.getAppPath()]
    };
  } catch { return { exe: '', args: [] }; }
}
ipcMain.handle('tools:cancel-download', async (_, id) => {
  try { return { ok: true, cancelled: !!T.cancelDownload(id || null) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Stop tlacitko: okamzite zabije bezici shell prikazy projektu + nastavi
// kooperativni stop pro build_exe (faze bez child procesu). Agent smycka se
// zastavi sama pres chatState.stopRequested + ukonceny stream.
ipcMain.handle('tools:cancel', async (_, data) => {
  try {
    const root = String((data && (data.root || data.dir)) || '');
    const r = T.cancelToolsFor(root);
    return { ok: true, killed: (r && r.killed) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('tools:exec', async (_, data) => {

  const d = data || {};
  const h = helperLaunch();
  const t0 = Date.now();
  const store = getStore();
  LOG_ERRORS = store.logErrors !== false;
  const tool = String(d.tool || '');
  // PLNÝ PŘÍSTUP, NIC NENÍ OMEZENO. Žádný DENY seznam, žádné ptání, žádný sandbox.
  const effFull = true;
  const args = { ...(d.args || {}) };
  // těžké toolchainy (MSVC, Docker, Android Studio) se instalují bez dotazu
  if ((tool === 'env_install' || tool === 'env_prepare') && args.heavy === undefined) args.heavy = true;
  // close_app běží tady (má přístup k preview serverům), ne v tools.js
  if (tool === 'close_app') {
    let r2;
    try { r2 = await closeAppTarget(args.target); }
    catch (e) { r2 = { ok: false, output: 'Error: ' + (e && e.message) }; }
    if (LOG_ERRORS && !r2.ok) { try { ERR.logError('tool:close_app', String(r2.output || '').slice(0, 2000), { args }); } catch {} }
    return r2;
  }
  let r;
  try {
    r = await T.execTool({
      tool, args, root: d.root, fullAccess: effFull,
      fallbackDir: projectsDir(), openPathFn: (p) => shell.openPath(p),
      userDataDir: app.getPath('userData'),
      helperExe: h.exe, helperArgs: h.args
    });
  } catch (e) { r = { ok: false, output: 'Error: ' + (e.message || e) }; }
  try {
    let argsHead = '';
    for (const k of ['command', 'path', 'dir', 'to', 'id', 'pattern', 'query', 'url', 'request']) {
      const v = (d.args || {})[k];
      if (typeof v === 'string' && v) { argsHead = k + '=' + v.slice(0, 150); break; }
      if (Array.isArray(v) && v.length) { argsHead = k + '=' + v.join(',').slice(0, 150); break; }
    }
    T.dbgLog('tool', {
      tool: d.tool, argsHead, argKeys: Object.keys(d.args || {}),
      argLens: Object.fromEntries(Object.entries(d.args || {}).map(([k, v]) => [k, typeof v === 'string' ? v.length : typeof v])),
      root: d.root, ok: !!(r && r.ok), outLen: String((r && r.output) || '').length, ms: Date.now() - t0
    });
  } catch {}
  // Selhaný nástroj (timeout, exit code, chybný příkaz…) do Logs/errors-AAAA-MM-DD.txt
  if (LOG_ERRORS && r && r.ok === false) {
    try {
      const cmd = String((d.args || {}).command || '');
      const out = String(r.error || r.output || 'tool failed');
      // Náš vlastní zamítnutí (guard, GUI cíl, …) a "neexistuje" nejsou chyba aplikace —
      // do logu by se jen hromadily a přehlušily skutečné problémy.
      // ZAM[ÍI]TNUTO: guardy píšou ZAMITNUTO bez diakritiky, musí to sedět obojí.
      const intentional = /^\s*ZAM[ÍI]TNUTO|not launching \(no system dialog\)|does not exist/i.test(out);
      // Sonda ("dir /b x 2>nul", "tasklist | findstr ...") končí exit 1 záměrně, když nic
      // nenajde — to není chyba, jen odpověď "nebeží / neexistuje".
      const probe = d.tool === 'shell' && /\b2>nul\b|\/dev\/null|\bif exist\b|\bwhere\b|\bwhich\b|\bfindstr\b/i.test(cmd);
      // `git rev-parse` mimo repo končí exit 128 ("not a git repository") — běžný
      // stav u projektu bez gitu, ne chyba aplikace (v logu to dělalo jen šum).
      const notRepo = d.tool === 'shell' && /(^|\s)git\s+rev-parse/i.test(cmd) && /\[exit 128\]/i.test(out);
      const notFound = ['file_info', 'read_file', 'list_dir', 'glob_file'].includes(d.tool) &&
        /ENOENT|no such file|does not exist/i.test(out);
      if (!intentional && !notRepo && !notFound && !(probe && /\[exit 1\]\s*$/i.test(out.trim()) && !/\[stderr\]/i.test(out))) {
        ERR.logError('tool:' + String(d.tool || '?'), out.slice(0, 2000),
          { args: d.args || {}, root: d.root || '', ms: Date.now() - t0 });
      }
    } catch {}
  }
  return r;
});
ipcMain.on('log:debug', (_, e) => { try { if (e && e.tag) T.dbgLog('UI:' + e.tag, e.data); } catch {} });

// Chyby běžící v rendereru (nevyznaná výjimka v chatu, UI…) — sem z preloadu.
ipcMain.on('log:error', (_, e) => {
  try { if (e && LOG_ERRORS) ERR.logError(e.tag || 'renderer', e.error || e.message || e, e.detail); } catch {}
});

// ===== Prohlížeč souborů: všechny disky + celý filesystem =====
// showOpenDialog na Windows ukáže jen pár složek; tady si vybereme všechno ručně.
function listDrives() {
  const out = [];
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  // Písmena A:–Z: existující = disk (partition, USB, síťová mapa)
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      if (!fs.existsSync(root)) continue;     // neexistující písmena přeskočíme (jinak to hloučí chyby)
      out.push({ name: String.fromCharCode(c) + ':', path: root });
    } catch {}
  }
  if (!out.length) out.push({ name: 'C:\\', path: 'C:\\' });
  return out;
}
// ===== Síťové disky (Z: WebDAV apod.) =====
// Elevovaný proces na Windows NEVIDÍ mapované síťové disky (jiný token než původní
// session). Než zvýšíme oprávnění, uložíme mapování do temp souboru a po startu
// elevated potomka ho připojíme znovu — jinak by uživatel v dialogu neviděl Z:.
function netUseMappings() {
  const out = [];
  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('cmd.exe', ['/d', '/c', 'net use'], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
    for (const line of String(raw).split(/\r?\n/)) {
      // Format:  Z:  \\server\share   Web Client Network
      const m = line.match(/^\s*([A-Za-z]:)\s+(\\\\[^\s]+)/);
      if (m) out.push({ drive: m[1], unc: m[2] });
    }
  } catch {}
  return out;
}
const NETMAP_FILE = () => path.join(os.tmpdir(), 'nolimitcoder', 'netdrives.json');
function saveNetMaps() {
  const maps = netUseMappings();
  try {
    if (!maps.length) return;
    const f = NETMAP_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(maps), 'utf8');
  } catch {}
  try { T.dbgLog('netdrv', { act: 'save', maps }); } catch {}
}
function restoreNetMaps() {
  const res = [];
  try {
    const f = NETMAP_FILE();
    if (!fs.existsSync(f)) return;
    const maps = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const m of (maps || [])) {
      if (!m || !m.drive || !m.unc) continue;
      let done = false;
      try { if (fs.existsSync(m.drive + '\\')) done = true; } catch {}   // už existuje
      if (!done) {
        try {
          require('child_process').execFileSync('net.exe', ['use', m.drive, m.unc, '/persistent:no'],
            { timeout: 8000, windowsHide: true, stdio: 'ignore' });
          try { done = fs.existsSync(m.drive + '\\'); } catch {}
        } catch {}
      }
      res.push({ drive: m.drive, unc: m.unc, ok: done });
    }
    try { fs.rmSync(f, { force: true }); } catch {}
  } catch {}
  try { T.dbgLog('netdrv', { act: 'restore', res }); } catch {}
}

ipcMain.handle('fs:browse', async (_, data) => {
  try {
    const d = data || {};
    const target = String(d.path || '').trim();
    if (!target) return { ok: true, path: null, drives: listDrives(), folders: [] };
    const abs = path.resolve(target);
    let items = [];
    try {
      items = (await fs.promises.readdir(abs, { withFileTypes: true }))
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => {
          const full = path.join(abs, e.name);
          return { name: e.name, path: full };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'cs', { numeric: true }));
    } catch (e) {
      return { ok: false, error: 'Složku nelze otevřít: ' + (e && e.message) };
    }
    return {
      ok: true,
      path: abs,
      parent: path.dirname(abs) === abs ? null : path.dirname(abs),
      folders: items,
      drives: listDrives(),
      shortcuts: [
        { name: '🏠 Uživatelská složka', path: os.homedir() },
        { name: '🖥️ Plocha', path: path.join(os.homedir(), 'Desktop') },
        { name: '📄 Dokumenty', path: path.join(os.homedir(), 'Documents') },
        { name: '⬇️ Stažené', path: path.join(os.homedir(), 'Downloads') },
        { name: '🖼️ Obrázky', path: path.join(os.homedir(), 'Pictures') },
        { name: '⚙️ Program Files', path: process.env.ProgramFiles || 'C:\\Program Files' },
        { name: '🖥️ Windows', path: process.env.SystemRoot || 'C:\\Windows' }
      ].filter(s => { try { return fs.existsSync(s.path); } catch { return false; } })
    };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:mkdir', async (_, data) => {
  try {
    const d = data || {};
    const abs = path.resolve(String(d.path || ''));
    const name = String(d.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
    if (!name) return { ok: false, error: 'Prázdný název' };
    fs.mkdirSync(path.join(abs, name), { recursive: true });
    return { ok: true, path: path.join(abs, name) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ===== Obrázky z chatu (Ctrl+V / výběr souboru) =====
// Uloží base64 do <projekt>/uploads/ a vrátí relativní cestu, kterou AI dostane.
// Žádný dialog, žádné čtení cizích cest — data jdou přímo z rendereru.
ipcMain.handle('img:save', async (_, data) => {
  try {
    const d = data || {};
    const b64 = String(d.data || '').replace(/^data:[^;]+;base64,/, '');
    if (!b64 || b64.length < 16) return { ok: false, error: 'Prázdný obrázek' };
    let ext = String(d.ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) ext = 'png';
    const root = String(d.root || '').trim() || projectsDir();
    const dir = path.join(root, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    const st = fs.statSync(abs);
    return { ok: true, abs, rel: 'uploads/' + name, bytes: st.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ===== Error Log — čtení / otevření / smazání (Settings → Permissions) =====
ipcMain.handle('errlog:read', () => ERR.readLog(200 * 1024));
ipcMain.handle('errlog:path', () => ({ path: ERR.currentLogFile() || '' }));
ipcMain.handle('errlog:open', () => {
  try {
    const p = ERR.currentLogFile();
    if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return { ok: true, path: p }; }
    return { ok: false, error: 'Log zatím neexistuje — zatím nic selhalo.' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('errlog:clear', () => { try { ERR.clearLog(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// Streaming the request - renderer will call this and we stream back via event
// Zastavení generování. S {streamId} se zruší JEN ten jeden stream (jiný chat
// běží dál); bez ID se zruší všechny (bezpečnostní fallback).
const streamAborts = new Map();
ipcMain.on('chat:stream-abort', (ev, payload) => {
  const p = payload || {};
  if (p.streamId) {
    const f = streamAborts.get(p.streamId);
    if (f) { try { f.abort(); } catch {} }
    return;
  }
  if (p.convoId) {
    for (const [, f] of streamAborts) { if (f.convoId === p.convoId) { try { f.abort(); } catch {} } }
    return;
  }
  abortFlag = true;
  for (const [, f] of streamAborts) { try { f.abort(); } catch {} }
});
ipcMain.on('chat:stream-start', async (event, payload) => {
  const { messages, model, convoId, agent, projectRoot, fullAccess, inputItems, maxTokens, websearch, allowedTools, noTools } = payload || {};
  // max_tokens: strop změřený proti bráně = 524 288 (2^19). Nad to (530 000, 1M) vrací
  // HTTP 400 a zahazuje celý požadavek. Proto tady držíme tvrdý strop a pošleme přesně
  // maximum, co model snese. Hodnota 0/nezadaná = parametr se vůbec nepošle (pak model
  // použije vlastní výchozí).
  const MAX_TOKENS_CEIL = 524288;
  const wantMaxT = parseInt(maxTokens);
  const maxT = (wantMaxT > 0)
    ? Math.min(Math.max(wantMaxT, 256), MAX_TOKENS_CEIL)
    : 0; // 0 = parametr se v požadavku vůbec neobjeví
  const omitMaxTokens = maxT === 0;
  const sender = event.sender;
  abortFlag = false;
  try {
    const rawId = String(model || '');
    let mId = rawId.includes('/') ? rawId.split('/').pop() : rawId;
    // Uložené staré volby modelu brána už neobsluhuje (403/500). Kdyz renderer posle
    // ulozenej starej hodnotu, presmerujeme ji na aktualni free model (MiMo V2.6 Flash), jinak by
    // uzivatel dostal jen chybu bez sance ji respit. Lokalni modely se nedotykame.
    if (!/^(local|ollama|lmstudio|vllm)[:/]/i.test(rawId) && !/^(mimo-v2\.6-flash-free)$/i.test(mId)) {
      mId = 'mimo-v2.6-flash-free';
    }
    const sid = getSessionId(convoId || mId);
    const reqId = 'req_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    // Identifikátor tohoto konkrétního streamu. Renderer po něm routuje chunky,
    // takže dvě chaty mohou generovat současně bez míchání odpovědí.
    const streamId = 'st_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);

    // EVERYTHING goes via the NolimitCoder gateway - no user key, always Bearer public
    const zenHeaders = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer public',
      'User-Agent': 'opencode/1.18.31',
      'x-opencode-client': 'cli',
      'x-opencode-session': sid,
      'x-opencode-request': reqId,
      'x-opencode-project': 'nolimit',
      'x-session-id': sid
    };

    // The real model name must never leak out — only NolimitCoder Pro.
    // Tahle funkce je jediné místo, kde se jméno směňuje, takže se v chybě,
    // logu i ve streamu jmenuje VŽDY stejně.
    const scrubModels = (s) => String(s || '')
      // Řazení od nejspecifičtějšího. POZOR: nepatternuj holé /mimo/ — český text
      // v UI obsahuje "mimo" ("pracovat mimo tuto složku") a pokaždé by se to
      // přepsalo na název modelu. Jen řetězce, kde je "mimo" součástí názvu.
      .replace(/mimo[-\s]*v?2\.6[-\s]*flash(?:[-\s]*free)?/gi, 'NolimitCoder Pro')
      .replace(/\bmimo[-\s]+(?:v?2\.6[-\s]*)?(?:flash|pro|mini|turbo)\b/gi, 'NolimitCoder Pro')
      .replace(/longcat-2\.5-preview-free/gi, 'NolimitCoder Free');
    const agentOn = agent === true; // renderer sends tools only for the working (non-hidden) run
    // LOCAL models (Ollama / LM Studio / vLLM, OpenAI-compatible)
    const LOCAL_PREFIX = /^(local|ollama|lmstudio|vllm)[:/]/i;
    let localBase = null;
    let localModel = mId;
    if (LOCAL_PREFIX.test(rawId) || LOCAL_PREFIX.test(mId)) {
      const store = getStore();
      const kind = rawId.split(/[:/]/)[0].toLowerCase();
      localModel = rawId.replace(LOCAL_PREFIX, '');
      localBase = kind === 'lmstudio' ? (store.lmstudioUrl || 'http://127.0.0.1:1234')
        : kind === 'vllm' ? 'http://127.0.0.1:8000'
        : (store.ollamaUrl || 'http://127.0.0.1:11434');
    }
    // Google search switch from Settings: web_search is not offered at all.
    const noWeb = websearch === false;
    const dropWeb = (arr, get) => noWeb ? arr.filter(t => get(t) !== 'web_search') : arr;
    const gR = (t) => t.name, gC = (t) => t.function.name;
    // ---- renderer posílá povolený seznam nástrojů ----
    // shell + read musí v listě zůstat vždy (gatekeeper), i když je v seznamu nemá.
    const allowed = Array.isArray(allowedTools) ? new Set(allowedTools.map(x => String(x))) : null;
    const filterByAgent = (arr, getName) => {
      if (!allowed) return arr;
      return arr.filter(t => {
        const n = getName(t);
        return n === 'shell' || n === 'read' || allowed.has(n);
      });
    };
    const noToolsOn = noTools === true;
    let url, body, headers;
    if (localBase) {
      // local OpenAI-compatible endpoint, no auth, no tools gatekeeper
      url = localBase.replace(/\/$/, '') + '/v1/chat/completions';
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify(Object.assign({ model: localModel, messages, stream: true },
        omitMaxTokens ? {} : { max_tokens: maxT }));
    } else {
      headers = zenHeaders;
      // Free modely -> /chat/completions (stream:true + chat-tools + prompt_cache_key = required)
      // Without agent: tool_choice:none = the model MUST NOT call tools (gatekeeper only checks the presence of the tools field),
      // otherwise weak FREE models sometimes emit "undefined" / phantom tool-call gibberish
      url = `${API_BASE}/chat/completions`;
      // Skrytý běh (summary…) jede bez tools a s tool_choice:none.
      const noToolsMode = noToolsOn || !agentOn;
      let baseTools = agentOn ? AGENT_TOOLS_CHAT : DUMMY_TOOLS_CHAT;
      const chatTools = dropWeb(filterByAgent(baseTools, gC), gC);
      body = JSON.stringify({
        model: mId,
        messages,
        stream: true,
        ...(omitMaxTokens ? {} : { max_tokens: maxT }),
        tools: chatTools,
        ...(noToolsMode ? { tool_choice: 'none' } : {}),
        prompt_cache_key: sid
      });
    }
    // Záložní plán pro HTTP 400: schodni max_tokens dolů a zkus to znovu.
    // body se přepisuje přes tuto funkci a streamDirect/proxy čtou bodyNow.
    // Když se max_tokens původně neposílal, 400 znamená spíš moc dlouhý kontext —
    // vložíme tedy konzervativní hodnotu a když to nepomůže, latka dojde a chyba se
    // ukáže normálně (žádná smyčka naprázdno).
    let bodyNow = body;
    const MAXT_LADDER = [65536, 16384, 8192, 4096];
    let maxTLadderIdx = -1;
    const nextMaxT = () => {
      maxTLadderIdx++;
      if (maxTLadderIdx >= MAXT_LADDER.length) return 0;
      const v = MAXT_LADDER[maxTLadderIdx];
      try {
        const o = JSON.parse(bodyNow);
        o.max_tokens = v;
        bodyNow = JSON.stringify(o);
        try { T.dbgLog('aistream', { end: 'max-tokens-fallback', from: omitMaxTokens ? 'omit' : maxT, to: v }); } catch {}
        return v;
      } catch { return 0; }
    };

    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqT0 = Date.now();
    // Everything (gateway and local models) always goes direct. No proxy, no VPN.
    try {
      const parsed = JSON.parse(body);
      const tls = parsed.tools || [];
      T.dbgLog('aireq', {
        model: parsed.model, api: url.includes('/responses') ? 'responses' : 'chat',
        mode: agentOn ? 'build' : 'chat',
        tools: tls.map(t => (t.function || t).name),
        inputChars: String(parsed.input || JSON.stringify(parsed.messages || '')).length,
        maxT: omitMaxTokens ? 'omit' : maxT, websearch: websearch !== false
      });
    } catch {}

    // --- Gateway request: direct, on quota/429 automatically via random proxies, infinitely ---
    let finished = false;
    let currentAbort = null;
    // chat:stream-* vždy s ID streamu, aby renderer věděl, komu chunk patří
    const safeSend = (ch, data) => {
      try {
        if (ch === 'chat:stream-chunk') sender.send(ch, { s: streamId, d: data });
        else if (ch === 'chat:stream-end') sender.send(ch, { s: streamId });
        else if (ch === 'chat:stream-error') sender.send(ch, { s: streamId, e: Object.assign({}, data || {}, { error: String((data && data.error) || 'stream error').slice(0, 300) }) });
        else sender.send(ch, data);
      } catch {}
    };
    const notifyProxy = (proxy, reason) => {
      try {
        PX.onProxySwitch(proxy);
        const st = PX.status();
        safeSend('proxy:status', { ...st, reason: reason || 'quota', via: proxy ? proxy.str : 'direct' });
        broadcastProxyStatus();
      } catch {}
    };
    const finishOnce = (ch, data, chunks, bytes) => {
      if (finished) return;
      finished = true;
      streamAborts.delete(streamId);
      try { currentAbort && currentAbort(); } catch {}
      try {
        T.dbgLog('aistream', {
          end: ch === 'chat:stream-end' ? 'ok' : 'error',
          err: ch === 'chat:stream-end' ? '' : String((data && data.error) || '').slice(0, 300),
          chunks: chunks || 0, bytes: bytes || 0, ms: Date.now() - reqT0,
          via: PX.status().current || 'direct'
        });
      } catch {}
      // Každá chyba streamu do Error Logu (aby se dala poslat vývojáři)
      if (ch === 'chat:stream-error' && LOG_ERRORS) {
        try { ERR.logError('aistream', (data && data.error) || 'stream error', { url: (data && data.url) || '', via: (data && data.via) || 'direct', chunks: chunks || 0, bytes: bytes || 0, ms: Date.now() - reqT0 }); } catch {}
      }
      safeSend(ch, data);
    };

    // Shared response streamer (direct and proxy) — chunks go straight to the renderer.
    const streamDirect = () => new Promise((resolve) => {
      if (localBase) {
        // local models always direct, proxy makes no sense
        const req = mod.request(url, { method: 'POST', headers: { ...headers, 'Accept': 'text/event-stream' } }, (res) => {
          hookStream(res, null, resolve);
        });
        currentAbort = () => { try { req.destroy(); } catch {} };
        req.on('error', (e) => { finishOnce('chat:stream-error', { error: e.message, url }); resolve({ fatal: true }); });
        req.setTimeout(60000);
        req.on('timeout', () => { try { req.destroy(); } catch {} finishOnce('chat:stream-error', { error: 'timeout 60s' }); resolve({ fatal: true }); });
        req.write(bodyNow); req.end();
        return;
      }
      const req = mod.request(url, {
        method: 'POST',
        headers: { ...headers, 'Accept': 'text/event-stream' }
      }, (res) => hookStream(res, null, resolve));
      currentAbort = () => { try { req.destroy(); } catch {} };
      req.on('error', (e) => {
        try { T.dbgLog('aistream', { end: 'req-error', err: String(e.message || e).slice(0, 300), ms: Date.now() - reqT0 }); } catch {}
        // network error on direct → try proxy right away (the IP may be the problem)
        if (!localBase && !finished) resolve({ netError: true, error: e.message });
        else { finishOnce('chat:stream-error', { error: e.message, url }); resolve({ fatal: true }); }
      });
      req.setTimeout(60000);
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        if (!localBase && !finished) resolve({ netError: true, error: 'timeout 60s' });
        else { finishOnce('chat:stream-error', { error: 'timeout 60s' }); resolve({ fatal: true }); }
      });
      req.write(bodyNow);
      req.end();
    });

    const hookStream = (res, viaProxy, resolve) => {
      let ended = false;
      let idleTimer = null;
      let chunks = 0, bytes = 0;
      const hardTimer = setTimeout(() => done('chat:stream-end'), 360000);
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done('chat:stream-end'), 25000);
      };
      const onAbort = () => { try { currentAbort && currentAbort(); } catch {} done('chat:stream-end'); };
      const done = (ch, data) => {
        if (ended) return;
        ended = true;
        clearTimeout(idleTimer); clearTimeout(hardTimer);
        streamAborts.delete(streamId);
        if (ch === 'chat:stream-end' && !viaProxy) { try { PX.onDirectOk(); PX.markGood(); } catch {} }
        if (ch === 'chat:stream-end' && viaProxy) { try { PX.markGood(); } catch {} }
        if (resolve && ch && ch !== '__streaming__') {
          // the caller handles the terminal state (resolve with the result), we don't want a double-finish
          if (ch === 'chat:stream-end' || ch === 'chat:stream-error') { finishOnce(ch, data, chunks, bytes); resolve({ fatal: true }); return; }
        }
        // interim done call without resolve → just cleanup (unused)
      };
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const rl = res.statusCode === 429;
        const raMs = rl ? parseRetryAfterMs(res.headers && res.headers['retry-after']) : 0;
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => {
          clearTimeout(idleTimer); clearTimeout(hardTimer);
          streamAborts.delete(streamId);
          const quota = rl || PX.isQuotaStatus(res.statusCode, errData);
          const geoBlocked = res.statusCode === 403 && isGeoBlockedBody(errData);
          // 400 invalid_request = brana odmítila parametr (nejčastěji max_tokens).
          // Není to chyba sítě ani kvóty — zkusíme menší max_tokens a jedeme dál.
          const badParam = res.statusCode === 400 && !quota && !localBase
            && /invalid[_ ]request|invalid request|max_tokens|context[_ ]length/i.test(errData);
          if (badParam) {
            const retryMt = nextMaxT();
            if (retryMt) { resolve({ badParam: true, retryMt }); return; }
          }
          if (quota && !geoBlocked && !localBase) {
            PX.onQuotaHit(raMs);
            resolve({ quota: true, status: res.statusCode, body: errData.slice(0, 1200), retryAfterMs: raMs });
          } else {
            finishOnce('chat:stream-error', { error: scrubModels(`HTTP ${res.statusCode}: ${errData.slice(0, 1200)}`), url, isRateLimit: rl, retryAfterMs: raMs, isRegionBlocked: geoBlocked, via: viaProxy ? viaProxy.str : 'direct' });
            resolve({ fatal: true });
          }
        });
        return;
      }
      bumpIdle();
      // successful stream start — let the caller know it is running (so it doesn't try another proxy)
      if (resolve) resolve({ streaming: true });
      // switch resolve to a no-op, further events only forward chunks
      const fwdEnd = (ch, data) => {
        if (ended) return;
        ended = true;
        clearTimeout(idleTimer); clearTimeout(hardTimer);
        streamAborts.delete(streamId);
        if (ch === 'chat:stream-end' && !viaProxy) { try { PX.onDirectOk(); PX.markGood(); } catch {} }
        if (ch === 'chat:stream-end' && viaProxy) { try { PX.markGood(); } catch {} }
        finishOnce(ch, data, chunks, bytes);
      };
      res.on('data', (chunk) => {
        bumpIdle();
        chunks++;
        try { bytes += Buffer.byteLength(String(chunk)); } catch { bytes += String(chunk).length; }
        safeSend('chat:stream-chunk', chunk.toString());
      });
      res.on('end', () => fwdEnd('chat:stream-end'));
      res.on('close', () => fwdEnd('chat:stream-end'));
      res.on('error', (e) => fwdEnd('chat:stream-error', { error: scrubModels(e.message), url, via: viaProxy ? viaProxy.str : 'direct' }));
      streamAborts.set(streamId, { abort: onAbort, convoId: convoId || '' });
      currentAbort = () => { try { res.destroy(); } catch {} };
    };

    const streamViaProxy = (proxy) => new Promise((resolve) => {
      let chunks = 0, bytes = 0;
      let gotHead = false;
      let idleTimer = null, hardTimer = null;
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { try { api.abort(); } catch {} finishProxyFail('timeout 25s idle (proxy)'); }, 25000);
      };
      const finishProxyFail = (msg) => {
        clearTimeout(idleTimer); clearTimeout(hardTimer);
        resolve({ proxyFail: true, error: msg });
      };
      hardTimer = setTimeout(() => { try { api.abort(); } catch {} finishProxyFail('timeout 360s (proxy)'); }, 360000);
      const onAbort = () => { try { api.abort(); } catch {} clearTimeout(idleTimer); clearTimeout(hardTimer); finishOnce('chat:stream-end', undefined, chunks, bytes); resolve({ fatal: true }); };
      streamAborts.set(streamId, { abort: onAbort, convoId: convoId || '' });
      const api = PX.postStreamViaProxy(url, {
        method: 'POST',
        headers: { ...headers, 'Accept': 'text/event-stream' },
        body: bodyNow, proxy, connectTimeout: 8000, timeout: 60000,
      }, {
        onHead: (status, headers) => {
          gotHead = true;
          if (status < 200 || status >= 300) {
            // an error header is handled in onChunk/onEnd by collecting the body
            api._errStatus = status;
            api._errHeaders = headers;
            api._errBody = '';
          }
        },
        onChunk: (ch) => {
          bumpIdle();
          if (api._errStatus) { api._errBody = (api._errBody || '') + ch; return; }
          chunks++;
          try { bytes += Buffer.byteLength(String(ch)); } catch { bytes += String(ch).length; }
          safeSend('chat:stream-chunk', String(ch));
        },
        onEnd: () => {
          clearTimeout(idleTimer); clearTimeout(hardTimer);
          streamAborts.delete(streamId);
          if (api._errStatus) {
            const st = api._errStatus;
            const bd = String(api._errBody || '');
            const quota = st === 429 || PX.isQuotaStatus(st, bd);
            const geoBlocked = st === 403 && isGeoBlockedBody(bd);
            const badParam = st === 400 && !quota && /invalid[_ ]request|invalid request|max_tokens|context[_ ]length/i.test(bd);
            if (badParam) {
              const retryMt = nextMaxT();
              if (retryMt) { resolve({ badParam: true, retryMt }); return; }
            }
            if (quota && !geoBlocked) {
              PX.onQuotaHit(parseRetryAfterMs(api._errHeaders && api._errHeaders['retry-after']));
              resolve({ quota: true, status: st, body: bd.slice(0, 1200) });
            } else {
              finishOnce('chat:stream-error', { error: scrubModels(`HTTP ${st} (proxy ${proxy.str}): ${bd.slice(0, 1200)}`), url, isRateLimit: st === 429, isRegionBlocked: geoBlocked, via: proxy.str });
              resolve({ fatal: true });
            }
            return;
          }
          // empty stream via proxy (dead tunnel with no data) → treat as proxy fail, try the next one
          if (!gotHead || (chunks === 0 && bytes === 0)) {
            resolve({ proxyFail: true, error: 'empty via proxy' });
            return;
          }
          try { PX.markGood(); } catch {}
          finishOnce('chat:stream-end', undefined, chunks, bytes);
          resolve({ fatal: true, okStream: true });
        },
        onError: (e) => {
          clearTimeout(idleTimer); clearTimeout(hardTimer);
          streamAborts.delete(streamId);
          resolve({ proxyFail: true, error: String((e && e.message) || e) });
        },
      });
      currentAbort = () => { try { api.abort(); } catch {} };
      bumpIdle();
    });

    // Main loop: INFINITE — keep trying to connect somewhere until it goes through or the user stops it.
    // Cycle: direct → proxies → direct → … with a growing pause + random jitter between attempts,
    // so multiple users hitting the limit at once spread out instead of hammering at the same moment.
    // Retry-After from the gateway is honored (capped at 120 s).
    (async () => {
      if (localBase) { await streamDirect(); return; }
      // The Stop button must also work while waiting between attempts (no attempt is listening then).
      const onLoopAbort = () => { try { currentAbort && currentAbort(); } catch {} finishOnce('chat:stream-end', undefined, 0, 0); };
      streamAborts.set(streamId, { abort: onLoopAbort, convoId: convoId || '' });
      let n = 0; // failed attempts in this request (drives backoff growth)
      let waitCap = 0; // Retry-After from the last quota hit (ms, capped)
      const sleep = (ms) => new Promise((res) => {
        const t0 = Date.now();
        const check = () => {
          if (finished || (Date.now() - t0) >= ms) res();
          else setTimeout(check, 250);
        };
        setTimeout(check, 250);
      });
      const backoffMs = () => {
        const base = Math.min(1000 * Math.pow(2, Math.min(n, 5)), 30000); // 1,2,4,8,16,30,30… s
        const jitter = Math.floor(Math.random() * 2000); // random spread so users don't fire at once
        return Math.min(Math.max(base + jitter, waitCap), 120000);
      };
      try {
        while (!finished) {
          // After a fresh quota hit, go via proxy right away — faster than another direct 429.
          if (PX.shouldUseProxyFirst()) {
            const proxy = PX.getRandomProxy();
            if (proxy) {
              notifyProxy(proxy, n === 0 ? 'preemptive-quota' : 'retry');
              const r = await streamViaProxy(proxy);
              if (!r || r.fatal) return;
              if (r.badParam) { try { T.dbgLog('aistream', { end: 'max-tokens-retry-proxy', to: r.retryMt }); } catch {} continue; }
              if (r.quota || r.proxyFail) {
                if (r.quota && r.retryAfterMs) waitCap = Math.min(r.retryAfterMs, 120000);
                PX.markBad(proxy);
                n++;
                await sleep(backoffMs());
                continue;
              }
              return; // streaming — the rest is handled by forwarding
            }
          }
          const d = await streamDirect();
          if (!d || d.fatal || d.streaming) return; // done / running / fatal error
          if (d.badParam) {
            // brana odmítila max_tokens — sníženo v nextMaxT(), hned to zkus znovu (bez čekání)
            try { T.dbgLog('aistream', { end: 'max-tokens-retry', to: d.retryMt }); } catch {}
            continue;
          }
          if (d.quota || d.netError) {
            if (d.retryAfterMs) waitCap = Math.min(d.retryAfterMs, 120000);
            n++;
            await sleep(backoffMs());
            continue;
          }
          return;
        }
      } finally {
        streamAborts.delete(streamId);
      }
    })();

  } catch (e) {
    try {
      sender.send('chat:stream-error', { s: 'st_err_' + Date.now().toString(36), e: { error: e && e.message ? e.message : String(e) } });
    } catch {}
  }
});

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r;
});

ipcMain.handle('app:openExternal', (_, url) => {
  try {
    const s = String(url || '').trim();
    if (!/^https?:\/\//i.test(s)) return false;
    shell.openExternal(s);
    return true;
  } catch { return false; }
});

// ===== BUILT-IN TERMINAL (the user's — normal rights, no prompting, no windows) =====
ipcMain.handle('term:run', async (_, data) => {
  const d = data || {};
  const cmd = T.normalizeShell(String(d.command || '').trim());
  if (!cmd) return { ok: false, output: '', code: null };
  let cwd = String(d.cwd || '');
  try {
    if (!cwd || !fs.existsSync(cwd)) cwd = app.getPath('home');
  } catch { cwd = app.getPath('home'); }
  const r = await T.runCmd(cmd, cwd, Math.min(Math.max(parseInt(d.timeout) || 120000, 1000), 600000));
  return { ok: r.ok, output: r.output, cwd };
});

// ===== LIVE PREVIEW for Website projects (localhost server for 127.0.0.1 only) =====
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm'
};
const previewServers = new Map(); // rootPath -> { server, port }
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function ensurePreview(root) {
  const cur = previewServers.get(root);
  if (cur) return { ok: true, port: cur.port, url: `http://127.0.0.1:${cur.port}/` };
  const port = await freePort();
  const server = http.createServer((req, res) => {
    // Async handler — na síťových discích (Z: WebDAV) synchronní fs operace
    // blokují event loop a zpomalují celou aplikaci během AI generování.
    (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method not allowed');
          return;
        }
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        let rel = decodeURIComponent(u.pathname).replace(/\\/g, '/');
        let abs = path.normalize(path.join(root, rel));
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        // React/Vue build into dist/ takes precedence over the root
        const distIndex = path.join(root, 'dist', 'index.html');
        let effRoot = root;
        try {
          if (fs.existsSync(distIndex)) {
            effRoot = path.join(root, 'dist');
            abs = path.normalize(path.join(effRoot, rel));
            if (abs !== effRoot && !abs.startsWith(effRoot + path.sep)) {
              res.writeHead(403, { 'Content-Type': 'text/plain' });
              res.end('Forbidden');
              return;
            }
          }
        } catch {}
        try {
          const st = await fs.promises.stat(abs);
          if (st.isDirectory()) abs = path.join(abs, 'index.html');
        } catch {}
        // SPA fallback: extensionless paths fall back to index (client routing), otherwise a 404 hint
        let st2;
        try { st2 = await fs.promises.stat(abs); } catch {}
        if ((!st2 || st2.isDirectory()) && path.extname(abs) === '') {
          const idx = path.join(effRoot, 'index.html');
          try { if (fs.existsSync(idx)) abs = idx; } catch {}
        }
        let st3;
        try { st3 = await fs.promises.stat(abs); } catch {}
        if (!st3 || st3.isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<body style="background:#101010;color:#888;font-family:sans-serif"><h3>404 — nothing in the project yet. Let the AI generate something (index.html).</h3></body>');
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(abs).pipe(res);
      } catch (e) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Error'); } catch {}
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(e => ({ err: e }));
  if (server.listening) {
    previewServers.set(root, { server, port });
    return { ok: true, port, url: `http://127.0.0.1:${port}/` };
  }
  return { ok: false, error: 'Failed to start the server' };
}
ipcMain.handle('preview:start', async (_, dirPath) => {
  const root = path.resolve(String(dirPath || ''));
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  return ensurePreview(root);
});
ipcMain.handle('preview:stop', async (_, dirPath) => {
  const root = path.resolve(String(dirPath || ''));
  const cur = previewServers.get(root);
  if (cur) {
    try { cur.server.close(); } catch {}
    previewServers.delete(root);
  }
  return true;
});
// ===== close_app: co AI otevřelo k ověření, to po ověření zavře =====
// exe (jméno/cesta) → taskkill; preview server (localhost URL) → stop serveru.
async function closeAppTarget(target) {
  const t = String(target || '').trim().replace(/^["']|["']$/g, '');
  if (!t) return { ok: false, output: 'Error: close_app needs a target (exe name, exe path, or preview URL).' };
  const m = t.match(/^https?:\/\/127\.0\.0\.1:(\d+)/i);
  if (m) {
    const port = parseInt(m[1], 10);
    for (const [root, s] of previewServers) {
      if (s && s.port === port) {
        try { s.server.close(); } catch {}
        previewServers.delete(root);
        return { ok: true, output: `OK: preview server na portu ${port} zastaven.` };
      }
    }
    return { ok: true, output: `OK: na portu ${port} už nic neběží.` };
  }
  let base = t.split(/[\\/]/).filter(Boolean).pop() || t;
  if (!/\.exe$/i.test(base)) base += '.exe';
  if (!/^[\w.\- +()]+$/i.test(base)) return { ok: false, output: 'Error: divné jméno procesu: ' + base };
  try {
    const out = await new Promise((res) => {
      require('child_process').execFile('taskkill.exe', ['/F', '/IM', base], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, so, se) => res(String(so || '') + String(se || '') + (err ? `\n[${err.code}]` : '\n[exit 0]')));
    });
    const dead = /SUCCESS|ukončeno|ukoncen/i.test(out);
    // "process not found" není chyba — cíl už neběží, což je přesně to, co chceme.
    const gone = /not found|nenalezen|no running instance/i.test(out);
    if (dead || gone) return { ok: true, output: `OK: ${base} neběží (ukončeno / už neběželo).` };
    return { ok: false, output: 'Pozn.: taskkill ' + base + '\n' + out.trim().slice(0, 500) };
  } catch (e) { return { ok: false, output: 'Error: ' + (e && e.message) }; }
}
// ===== FILE WATCHER: jakmile do složky přistane jakýkoliv soubor, renderer hned přenačte náhled =====
// Na síťových discích (Z: WebDAV) způsobuje fs.watch s recursive:true obrovské
// množství síťového provozu (každý adresář = samostatný SMB request). Proto
// používáme polling s exponenciálním backoffem — je to mnohem šetrnější k síti.
const previewWatchers = new Map(); // rootPath -> { timer, interval, mtimes: Map }
function broadcastPreviewChanged(root) {
  try {
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('preview:file-changed', { root }); } catch {} }
  } catch {}
}
// Zjistí, jestli jde o síťový disk (Z:, Y:, ... nebo UNC cesta)
function isNetworkPath(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) && !/^[cC]:[\\/]/i.test(s) || /^\\\\/.test(s);
}
// Rekurzivní seznam souborů s časovým razítkem (pro polling)
function listFilesRecursive(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listFilesRecursive(full, rel, out);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ path: rel, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
}
// Porovná dva seznamy souborů a vrátí true, když se něco změnilo
function filesChanged(prev, cur) {
  if (prev.length !== cur.length) return true;
  for (let i = 0; i < cur.length; i++) {
    if (prev[i].path !== cur[i].path) return true;
    if (prev[i].mtime !== cur[i].mtime) return true;
    if (prev[i].size !== cur[i].size) return true;
  }
  return false;
}
ipcMain.handle('preview:watch', (_, dirPath) => {
  try {
    const root = path.resolve(String(dirPath || ''));
    if (!root || !fs.existsSync(root)) return false;
    if (previewWatchers.has(root)) return true;
    // Na síťových discích používáme polling s delším intervalem
    const net = isNetworkPath(root);
    const interval = net ? 3000 : 500; // 3s pro síť, 500ms pro lokální
    let files = [];
    try { listFilesRecursive(root, '', files); } catch {}
    const timer = setInterval(() => {
      const cur = previewWatchers.get(root);
      if (!cur) { clearInterval(timer); return; }
      let newFiles = [];
      try { listFilesRecursive(root, '', newFiles); } catch {}
      if (filesChanged(cur.mtimes, newFiles)) {
        cur.mtimes = newFiles;
        clearTimeout(cur.debounce);
        cur.debounce = setTimeout(() => broadcastPreviewChanged(root), 400);
      }
    }, interval);
    previewWatchers.set(root, { timer, interval, mtimes: files, debounce: null });
    return true;
  } catch { return false; }
});
ipcMain.handle('preview:unwatch', (_, dirPath) => {
  try {
    const root = path.resolve(String(dirPath || ''));
    const cur = previewWatchers.get(root);
    if (cur) { clearInterval(cur.timer); clearTimeout(cur.debounce); previewWatchers.delete(root); }
    return true;
  } catch { return false; }
});

// ===== AI COMMERCIAL VIDEO → MP4 (local machine power) =====
// Records the ad HTML in a hidden window at the exact resolution (capturePage
// frames) and encodes with a portable ffmpeg (downloaded once into userData).
function safeBase(s) {
  return String(s || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || 'video';
}
ipcMain.handle('video:export', async (event, p) => {
  const sender = event.sender;
  const prog = (d) => { try { sender.send('video:progress', d || {}); } catch {} };
  try {
    const d = p || {};
    const root = path.resolve(String(d.root || ''));
    if (!root || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
    const width = Math.min(Math.max(parseInt(d.width) || 1920, 160), 3840);
    const height = Math.min(Math.max(parseInt(d.height) || 1080, 160), 2160);
    const durationSec = Math.min(Math.max(parseInt(d.durationSec) || 30, 1), 300);
    const fps = 30;
    const prev = await ensurePreview(root);
    if (!prev.ok) return { ok: false, error: 'Preview server failed' };
    const ff = await VX.ensureFfmpeg(app.getPath('userData'), prog);
    if (!ff.ok) return { ok: false, error: ff.error };
    const file = `${safeBase(path.basename(root))}-${width}x${height}-${durationSec}s.mp4`;
    const outPath = path.join(root, file);
    const r = await VX.exportVideo({
      url: prev.url, width, height, durationSec, fps, outPath,
      userDataDir: app.getPath('userData'), onProg: prog
    });
    if (!r.ok) return r;
    let mb = '';
    try { mb = (fs.statSync(outPath).size / 1048576).toFixed(1) + ' MB'; } catch {}
    try { T.dbgLog('video', { act: 'export-ok', file, mb, width, height, durationSec }); } catch {}
    return { ok: true, path: outPath, file, mb };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('video:reveal', (_, fp) => {
  try { shell.showItemInFolder(String(fp)); return true; } catch { return false; }
});
ipcMain.handle('video:abort', () => {
  try { VX.requestAbort(); return true; } catch { return false; }
});
app.on('before-quit', () => {
  for (const [, s] of previewServers) { try { s.server.close(); } catch {} }
  previewServers.clear();
  for (const [, w] of previewWatchers) { try { clearInterval(w.timer); } catch {} try { clearTimeout(w.debounce); } catch {} }
  previewWatchers.clear();
});
