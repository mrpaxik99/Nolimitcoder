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

// Download/install progress (download widget at bottom left) — tools.js calls the hook, we forward it to the window.
if (T.setProgressHook) T.setProgressHook((p) => {
  try { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('nlc-download', p); } catch {} } } catch {}
});

let mainWindow;
let abortFlag = false;

try { app.setPath('userData', path.join(app.getPath('appData'), 'NolimitCoder V2')); } catch {} // data stays in the old folder even after renaming the exe
const STORE_PATH = path.join(app.getPath('userData'), 'config.json');

try { fs.mkdirSync(path.join(os.tmpdir(), 'nolimitcoder'), { recursive: true }); } catch {}
function getStore() {
  const defaults = {
    permissions: 'all',       // always everything allowed, no prompting
    fullAccess: true,         // always full access to the whole PC
    activeProject: null,      // full path to the project folder
    mode: 'build',            // build | plan
    sound: true,              // sound after generation finishes
    terminal: 'auto',         // terminal always auto
    ollamaUrl: 'http://127.0.0.1:11434',
    lmstudioUrl: 'http://127.0.0.1:1234',

  };
  try {
    if (fs.existsSync(STORE_PATH)) return { ...defaults, ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) };
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    try {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    } catch {}
    if ((argv || []).join(' ').includes('--elevated-child')) {
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
  saveStore(next);
  return next;
});

ipcMain.handle('app:version', () => app.getVersion());
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
  const low = op.toLowerCase();
  if (T.BLOCKED_PREFIXES.some(b => low === b.replace(/\/$/, '') || low.startsWith(b))) {
    return { ok: false, error: 'System folder is forbidden' };
  }
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

ipcMain.handle('projects:files', (_, dirPath, includeContents) => {
  const root = path.resolve(String(dirPath || ''));
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  const tree = [];
  let truncated = false;
  (function walk(dir, rel) {
    if (tree.length > 300) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (tree.length > 300) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const rp = rel ? rel + '/' + e.name : e.name;
      try {
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          tree.push({ path: rp + '/', dir: true });
          walk(path.join(dir, e.name), rp);
        } else if (e.isFile()) {
          tree.push({ path: rp, dir: false });
        }
      } catch {}
    }
  })(root, '');
  const contents = {};
  if (includeContents) {
    let budget = 60000;
    for (const t of tree) {
      if (t.dir || budget <= 0) continue;
      if (!TEXT_EXT.has(path.extname(t.path).toLowerCase())) continue;
      try {
        const st = fs.statSync(path.join(root, t.path));
        if (st.size > 40000) continue;
        const txt = fs.readFileSync(path.join(root, t.path), 'utf-8');
        const slice = txt.slice(0, Math.min(txt.length, budget));
        contents[t.path] = slice;
        budget -= slice.length;
      } catch {}
    }
  }
  return { ok: true, root, tree, contents, truncated };
});

ipcMain.handle('projects:openPath', (_, p) => {
  try { shell.openPath(String(p)); return true; } catch { return false; }
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
const RESPONSES_MODELS = new Set([
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free'
]);

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
// agent=true only in Build mode (Plan is text-only) and only when there is somewhere to reach.
const P = (properties, required) => ({ type: 'object', properties, required: required || Object.keys(properties) });
const STR = (d) => ({ type: 'string', description: d || '' });
const SHELL_REAL = { type: 'function', name: 'shell', description: `Execute a shell command (Windows cmd.exe on win32).

Use %TEMP%/nolimitcoder for temporary work outside the workspace. This directory already exists and is pre-approved.

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
// In chat/plan mode (no agent) these are intentionally dead plugs so the model calls nothing.
// In build mode ONLY real tools are sent (no duplicate names!).
const READ_GATE = { type: 'function', name: 'read', description: 'Read a text file (alias of read_file).', parameters: P({ path: STR('Path to the file') }) };
const SHELL_GATE = { type: 'function', name: 'shell', description: 'INTERNAL ONLY — never call this tool in chat mode.', parameters: P({ command: STR('ignored, do not use') }) };
const DUMMY_TOOLS_RESP = [ SHELL_GATE, READ_GATE ];
const AGENT_TOOLS_RESP = [
  SHELL_REAL,
  READ_GATE,
  { type: 'function', name: 'write_file', description: 'Writes a text file (creates subfolders too). Instead of printing code into the chat, ALWAYS write it with this tool.', parameters: P({ path: STR('Relative path to the project or absolute path'), content: STR('Entire file content') }, ['path', 'content']) },
  { type: 'function', name: 'append_file', description: 'Appends text to the end of a file (creates the file if needed).', parameters: P({ path: STR('Path to the file'), content: STR('Text to append') }, ['path', 'content']) },
  { type: 'function', name: 'edit_file', description: 'Precise file edit: oldString must match exactly 1x in the file, otherwise send a larger context or replaceAll: true.', parameters: P({ path: STR('Path to the file'), oldString: STR('Exact original text'), newString: STR('New text') }, ['path', 'oldString', 'newString']) },
  { type: 'function', name: 'read_file', description: 'Reads a text file (max 40 KB).', parameters: P({ path: STR('Path to the file') }) },
  { type: 'function', name: 'list_dir', description: 'Lists files and subfolders in a folder.', parameters: P({ path: STR('Path to the folder, "." = project') }) },
  { type: 'function', name: 'glob_file', description: 'Finds files by pattern (e.g. **/*.js, src/*.py).', parameters: P({ pattern: STR('Glob pattern'), dir: STR('Where to search, default "."') }, ['pattern']) },
  { type: 'function', name: 'create_dir', description: 'Creates a folder including subfolders.', parameters: P({ path: STR('Path to the folder') }) },
  { type: 'function', name: 'move_file', description: 'Moves or renames a file (images too) between folders.', parameters: P({ from: STR('Source path'), to: STR('Target path') }, ['from', 'to']) },
  { type: 'function', name: 'copy_file', description: 'Copies a file (image too) to another folder.', parameters: P({ from: STR('Source path'), to: STR('Target path') }, ['from', 'to']) },
  { type: 'function', name: 'delete_file', description: 'Deletes a file.', parameters: P({ path: STR('Path to the file') }) },
  { type: 'function', name: 'file_info', description: 'Info about a file/folder: size, date, type.', parameters: P({ path: STR('Path') }) },
  { type: 'function', name: 'search_files', description: 'Searches text in project files (grep).', parameters: P({ pattern: STR('Text to search'), dir: STR('Where to search, default "."'), ext: STR('Extension without a dot, e.g. js (optional)') }, ['pattern']) },
  { type: 'function', name: 'open_path', description: 'Opens a file/folder in the system (Explorer).', parameters: P({ path: STR('Path') }) },
  { type: 'function', name: 'web_fetch', description: 'Downloads the text of a web page (https URL).', parameters: P({ url: STR('https://…') }, ['url']) },
  { type: 'function', name: 'web_search', description: 'Searches anything on the internet (full web access).', parameters: P({ query: STR('Search query') }, ['query']) },
  { type: 'function', name: 'download_file', description: 'Downloads a file from the internet to disk (https URL → path). Handles large files too.', parameters: P({ url: STR('https://…/file.zip'), to: STR('Where to save (relative to the project or absolute)') }, ['url', 'to']) },
  { type: 'function', name: 'env_scan', description: 'Scans the computer and finds what is already installed (node, npm, python, pip, git, gcc/g++, MSVC, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, 7-Zip) and what the active project and the user request need. Installs nothing. Call AT THE START when you are going to build, compile or run something.', parameters: P({ request: STR('Optional: exactly what the user wants, e.g. "make a C++ program and compile an exe"') }) },
  { type: 'function', name: 'env_prepare', description: 'Finds what is needed (project + user request + planned commands) and installs ALL missing pieces ITSELF: winget → Chocolatey → Scoop → downloading from the internet into the app, then keeps working right away. Before telling the user to install something, call this. Large toolchains (Visual Studio Build Tools, Docker, Android Studio) are not installed without asking — ask first with the question tool and then call again with heavy: true.', parameters: P({ request: STR('What the user wants, in their own words'), ids: { type: 'array', items: STR('toolchain id'), description: 'Optional: specific toolchains instead of auto selection' }, heavy: { type: 'boolean', description: 'Allow large installs (GB) — only when the user agreed' } }) },
  { type: 'function', name: 'env_install', description: 'Installs specific toolchains via winget/Chocolatey/Scoop, otherwise downloads them from the internet (node, python, git, gcc, msvc, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, sevenzip, android). Call only when env_scan showed something is missing.', parameters: P({ id: STR('one id, or more separated by comma'), ids: { type: 'array', items: STR('toolchain id'), description: 'use instead of id when you want more toolchains' }, heavy: { type: 'boolean', description: 'Allow large installs (GB)' } }) },
  { type: 'function', name: 'scaffold_electron', description: 'Creates a working Electron project skeleton (package.json + main.js + index.html) for an EXE app. ALWAYS call as the first step when the user wants an Electron/desktop exe app. Then write the code, run shell npm install (timeout 600000) and npm run dist (timeout 600000).', parameters: P({ dir: STR('Project folder (relative or absolute)'), name: STR('App name') }, ['dir']) },
  { type: 'function', name: 'question', description: 'Ask the user when you need a decision or clarification (e.g. which technology to pick). Show them options to choose from.', parameters: P({ questions: { type: 'array', description: 'Questions (1-3)', items: { type: 'object', properties: { header: STR('Short heading'), question: STR('Question'), options: { type: 'array', items: { type: 'object', properties: { label: STR('Option name'), description: STR('Option description') } } }, multiple: { type: 'boolean', description: 'Multiple choices at once' } } } } }, ['questions']) }
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
ipcMain.handle('tools:exec', async (_, data) => {

  const d = data || {};
  const h = helperLaunch();
  const t0 = Date.now();
  let r;
  try {
    r = await T.execTool({
      tool: d.tool, args: d.args, root: d.root, fullAccess: d.fullAccess,
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
  return r;
});
ipcMain.on('log:debug', (_, e) => { try { if (e && e.tag) T.dbgLog('UI:' + e.tag, e.data); } catch {} });

// Streaming the request - renderer will call this and we stream back via event
ipcMain.on('chat:stream-abort', () => { abortFlag = true; });
ipcMain.on('chat:stream-start', async (event, payload) => {
  const { messages, model, convoId, agent, mode: reqMode, projectRoot, fullAccess, inputItems, maxTokens, websearch } = payload || {};
  const maxT = Math.min(Math.max(parseInt(maxTokens) || 4096, 256), 32000);
  const sender = event.sender;
  abortFlag = false;
  try {
    const rawId = String(model || '');
    const mId = rawId.includes('/') ? rawId.split('/').pop() : rawId;
    const sid = getSessionId(convoId || mId);
    const reqId = 'req_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

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

    // The real model name must never leak out — only NolimitCoderV2/V3
    const scrubModels = (s) => String(s || '')
      .split('muse-spark-1.3-contributor-free').join('NolimitCoderV3')
      .split('muse-spark-1.2-contributor-free').join('NolimitCoderV2');
    const agentOn = agent === true; // renderer sends agent only in Build mode; where it may reach is guarded by the sandbox + panel
    const planOn = reqMode === 'plan';
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
    const READ_TOOLS_RESP = AGENT_TOOLS_RESP.filter(t => ['read', 'read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'question', 'env_scan'].includes(t.name));
    const READ_TOOLS_CHAT = AGENT_TOOLS_CHAT.filter(t => ['read', 'read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'question', 'env_scan'].includes(t.function.name));
    // Gatekeeper wants "shell" in the list too — in plan it is a dead plug (the model must not call it).
    const PLAN_TOOLS_RESP = [SHELL_GATE, ...READ_TOOLS_RESP];
    const PLAN_TOOLS_CHAT = [{ type: 'function', function: { name: 'shell', description: 'INTERNAL ONLY — never call this tool in plan mode.', parameters: P({ command: STR('ignored') }) } }, ...READ_TOOLS_CHAT];
    let url, body, headers;
    if (localBase) {
      // local OpenAI-compatible endpoint, no auth, no tools gatekeeper
      url = localBase.replace(/\/$/, '') + '/v1/chat/completions';
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ model: localModel, messages, stream: true, max_tokens: maxT });
    } else {
      headers = zenHeaders;
      if (RESPONSES_MODELS.has(mId)) {
      // Muse Spark free -> Responses API (chat/completions returns 500)
      url = `${API_BASE}/responses`;
      const input = inputItems || messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
      body = JSON.stringify({
        model: mId,
        input,
        stream: true,
        max_output_tokens: maxT,
        tools: dropWeb(agentOn ? AGENT_TOOLS_RESP : (planOn ? PLAN_TOOLS_RESP : DUMMY_TOOLS_RESP), gR)
      });
      } else {
      // Rest of FREE -> /chat/completions (stream:true + chat-tools + prompt_cache_key = required)
      // Without agent: tool_choice:none = the model MUST NOT call tools (gatekeeper only checks the presence of the tools field),
      // otherwise weak FREE models sometimes emit "undefined" / phantom tool-call gibberish
      url = `${API_BASE}/chat/completions`;
      const chatTools = dropWeb(agentOn ? AGENT_TOOLS_CHAT : (planOn ? PLAN_TOOLS_CHAT : DUMMY_TOOLS_CHAT), gC);
      body = JSON.stringify({
        model: mId,
        messages,
        stream: true,
        max_tokens: maxT,
        tools: chatTools,
        ...((agentOn || planOn) ? {} : { tool_choice: 'none' }),
        prompt_cache_key: sid
      });
      }
    }

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
        mode: agentOn ? 'build' : (planOn ? 'plan' : 'chat'),
        tools: tls.map(t => (t.function || t).name),
        inputChars: String(parsed.input || JSON.stringify(parsed.messages || '')).length,
        maxT, websearch: websearch !== false
      });
    } catch {}

    // --- Gateway request: direct, on quota/429 automatically via random proxies, infinitely ---
    let finished = false;
    let currentAbort = null;
    const safeSend = (ch, data) => { try { sender.send(ch, data); } catch {} };
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
      try { currentAbort && currentAbort(); } catch {}
      try {
        T.dbgLog('aistream', {
          end: ch === 'chat:stream-end' ? 'ok' : 'error',
          err: ch === 'chat:stream-end' ? '' : String((data && data.error) || '').slice(0, 300),
          chunks: chunks || 0, bytes: bytes || 0, ms: Date.now() - reqT0,
          via: PX.status().current || 'direct'
        });
      } catch {}
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
        req.write(body); req.end();
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
      req.write(body);
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
        try { ipcMain.removeListener('chat:stream-abort', onAbort); } catch {}
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
          try { ipcMain.removeListener('chat:stream-abort', onAbort); } catch {}
          const quota = rl || PX.isQuotaStatus(res.statusCode, errData);
          const geoBlocked = res.statusCode === 403 && isGeoBlockedBody(errData);
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
        try { ipcMain.removeListener('chat:stream-abort', onAbort); } catch {}
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
      ipcMain.once('chat:stream-abort', onAbort);
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
      ipcMain.once('chat:stream-abort', onAbort);
      const api = PX.postStreamViaProxy(url, {
        method: 'POST',
        headers: { ...headers, 'Accept': 'text/event-stream' },
        body, proxy, connectTimeout: 8000, timeout: 60000,
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
          try { ipcMain.removeListener('chat:stream-abort', onAbort); } catch {}
          if (api._errStatus) {
            const st = api._errStatus;
            const bd = String(api._errBody || '');
            const quota = st === 429 || PX.isQuotaStatus(st, bd);
            const geoBlocked = st === 403 && isGeoBlockedBody(bd);
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
          try { ipcMain.removeListener('chat:stream-abort', onAbort); } catch {}
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
      ipcMain.on('chat:stream-abort', onLoopAbort);
      let n = 0; // failed attempts in this request (drives backoff growth)
      let waitCap = 0; // Retry-After from the last quota hit (ms, capped)
      const sleep = (ms) => new Promise((res) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (finished || (Date.now() - t0) >= ms) { clearInterval(iv); res(); }
        }, 250);
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
          if (d.quota || d.netError) {
            if (d.retryAfterMs) waitCap = Math.min(d.retryAfterMs, 120000);
            n++;
            await sleep(backoffMs());
            continue;
          }
          return;
        }
      } finally {
        try { ipcMain.removeListener('chat:stream-abort', onLoopAbort); } catch {}
      }
    })();

  } catch (e) {
    sender.send('chat:stream-error', { error: e.message });
  }
});

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r;
});

ipcMain.handle('app:openExternal', (_, url) => {
  try { shell.openExternal(String(url)); return true; } catch { return false; }
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
ipcMain.handle('preview:start', async (_, dirPath) => {
  const root = path.resolve(String(dirPath || ''));
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Folder does not exist' };
  const cur = previewServers.get(root);
  if (cur) return { ok: true, port: cur.port, url: `http://127.0.0.1:${cur.port}/` };
  const port = await freePort();
  const server = http.createServer((req, res) => {
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
        const st = fs.statSync(abs);
        if (st.isDirectory()) abs = path.join(abs, 'index.html');
      } catch {}
      // SPA fallback: extensionless paths fall back to index (client routing), otherwise a 404 hint
      if ((!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) && path.extname(abs) === '') {
        const idx = path.join(effRoot, 'index.html');
        if (fs.existsSync(idx)) abs = idx;
      }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
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
app.on('before-quit', () => {
  for (const [, s] of previewServers) { try { s.server.close(); } catch {} }
  previewServers.clear();
});
