const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
// Zvýšený pomocník: tahle instance slouží JEN jako executor za rourou,
// žádné okno, žádný zámek, jen pipe klient (spouští ho hlavní appka zvýšeně).
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

// Progress stahování/instalací (download widget vlevo dole) — tools.js volá hook, my to pošleme do okna.
if (T.setProgressHook) T.setProgressHook((p) => {
  try { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('nlc-download', p); } catch {} } } catch {}
});

let mainWindow;
let abortFlag = false;

try { app.setPath('userData', path.join(app.getPath('appData'), 'NolimitCoder V2')); } catch {} // data zustavaji ve stare slozce i po prejmenovani exe
const STORE_PATH = path.join(app.getPath('userData'), 'config.json');

try { fs.mkdirSync(path.join(os.tmpdir(), 'nolimitcoder'), { recursive: true }); } catch {}
function getStore() {
  const defaults = {
    permissions: 'all',       // vždy vše povoleno, žádné dotazování
    fullAccess: true,         // vždy plný přístup k celému PC
    activeProject: null,      // full path ke složce projektu
    mode: 'build',            // build | plan
    sound: true,              // zvuk po dokončení generování
    terminal: 'auto',         // terminál vždy auto
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

  // Když renderer spadne (OOM apod.), nestojí celá appka — jen se přenačte
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

// Jedna instance. Při restartu jako správce se nová (zvýšená) instance ozve
// příznakem --elevated-child a stará se pak sama vypne. Normální dvojklik
// jen vyfocusuje okno (když UAC zamítneš, běží se dál beze změny).
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
  // net session projde jen se zvýšenými právy
  try {
    const { execFile } = require('child_process');
    const ok = await new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', 'net session'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
    });
    return !!ok;
  } catch { return false; }
});

ipcMain.handle('app:relaunchAdmin', async () => {
  // Spustí TUTO aplikaci znovu jako správce (1× UAC okno). Stará instance
  // se vypne sama přes second-instance — když UAC zamítneš, nic se nestane a jede se dál.
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
  // Proxy pool (ProxyScrape free list): načíst přibalené + cache, čerstvé stáhnout na pozadí.
  try {
    const cacheDir = path.join(app.getPath('userData'), 'proxies');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    try { PX.loadProxies(cacheDir); } catch {}
    try { T.dbgLog('proxy', { act: 'init', counts: PX.counts() }); } catch {}
    // tichý refresh po startu (neblokuje okno), pak každých 30 min
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

// 429 = free kvota vycerpana. Retry-After (s) z hlavicky, max 300.
function parseRetryAfterMs(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(n, 300) * 1000;
}
// 403 RegionError = zeme je pro model blokovana (geo-ban).
function isGeoBlockedBody(s) {
  return /RegionError|not available in your country/i.test(String(s || ''));
}

// Seznam modelu: nejdřív napřímo, při quota/429 automaticky přes random proxy z poolu.
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
  // quota → zkus 3 random proxy rychle za sebou
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
  return { ok: false, error: `quota 429 i přes proxy (zkuseno 3×) — ${direct.body || ''}`.slice(0, 500), via: 'direct+proxy', isRateLimit: true };
});

// ===== PROXY pool (ProxyScrape) — status / refresh / list pro UI =====
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
  // lokalni AI server
  const localai = await fetchLocalModels(`http://127.0.0.1:4096/config`);
  results.localai = localai;
  return results;
});

// ===== PROJECTS — složka projects (vytvořit / přejmenovat / smazat / vybrat) =====
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
  if (!n) return { ok: false, error: 'Prázdný název' };
  const p = path.join(projectsDir(), n);
  if (fs.existsSync(p)) return { ok: false, error: 'Složka už existuje' };
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, name: n, path: p };
});

ipcMain.handle('projects:rename', (_, oldName, newName) => {
  const o = safeName(oldName), n = safeName(newName);
  if (!o || !n) return { ok: false, error: 'Špatný název' };
  const op = path.join(projectsDir(), o), np = path.join(projectsDir(), n);
  if (!fs.existsSync(op)) return { ok: false, error: 'Projekt neexistuje' };
  if (fs.existsSync(np)) return { ok: false, error: 'Cíl už existuje' };
  try { fs.renameSync(op, np); } catch (e) { return { ok: false, error: e.message }; }
  const st = getStore();
  if (st.activeProject === op) { st.activeProject = np; saveStore(st); }
  return { ok: true, name: n, path: np };
});

ipcMain.handle('projects:delete', (_, name) => {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'Špatný název' };
  const p = path.join(projectsDir(), n);
  if (!fs.existsSync(p)) return { ok: false, error: 'Projekt neexistuje' };
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
  const st = getStore();
  if (st.activeProject === p) { st.activeProject = null; saveStore(st); }
  return { ok: true };
});

ipcMain.handle('projects:renamePath', (_, oldPath, newName) => {
  const n = safeName(newName);
  if (!n) return { ok: false, error: 'Špatný název' };
  const op = path.resolve(String(oldPath || ''));
  if (!op || !fs.existsSync(op)) return { ok: false, error: 'Složka neexistuje' };
  const low = op.toLowerCase();
  if (T.BLOCKED_PREFIXES.some(b => low === b.replace(/\/$/, '') || low.startsWith(b))) {
    return { ok: false, error: 'Systémová složka je zakázaná' };
  }
  const np = path.join(path.dirname(op), n);
  if (fs.existsSync(np)) return { ok: false, error: 'Cíl už existuje' };
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
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Složka neexistuje' };
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

// ===== NOLIMIT FREE TIER pres branu (zadny user API key) =====
// Zdroj generovani: brana NolimitCoder (klientsky fingerprint v hlavickach nize).
// Auth: Bearer public + fingerprint oficialniho klienta.
// Gatekeeper (od 19.9.2026) vyzaduje: stream:true + tools [shell, read] + fingerprint.
// Overeno 24.9.2026: 7x /chat/completions + 2x /responses funguje bez klice.

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
// Stable session per conversation (lepsi cache + routing), per-request id unikatni
const sessionCache = new Map();
function getSessionId(convoId) {
  if (!convoId) return genSessionId();
  if (!sessionCache.has(convoId)) sessionCache.set(convoId, genSessionId());
  return sessionCache.get(convoId);
}

// ===== FILE TOOLS — kompletní sada nástrojů (provedení v tools.js) =====
// Gatekeeper vyžaduje nástroj se jménem shell (+read) — proto je shell vždy v seznamu.
// agent=true jen v Build modu (Plan je text-only) a jen když je kam sahat.
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
// Gatekeeper brány vyžaduje, aby v seznamu byl nástroj se jménem "shell" a "read".
// V chat/plan režimu (bez agenta) jsou to záměrně mrtvé zátky, aby model nic nevolal.
// V build režimu se posílají POUZE skutečné nástroje (žádné duplicity jmen!).
const READ_GATE = { type: 'function', name: 'read', description: 'Read a text file (alias of read_file).', parameters: P({ path: STR('Path to the file') }) };
const SHELL_GATE = { type: 'function', name: 'shell', description: 'INTERNAL ONLY — never call this tool in chat mode.', parameters: P({ command: STR('ignored, do not use') }) };
const DUMMY_TOOLS_RESP = [ SHELL_GATE, READ_GATE ];
const AGENT_TOOLS_RESP = [
  SHELL_REAL,
  READ_GATE,
  { type: 'function', name: 'write_file', description: 'Zapíše textový soubor (vytvoří i podsložky). Místo vypisování kódu do chatu ho VŽDY zapiš tímto nástrojem.', parameters: P({ path: STR('Relativní cesta k projektu nebo absolutní cesta'), content: STR('Celý obsah souboru') }, ['path', 'content']) },
  { type: 'function', name: 'append_file', description: 'Připíše text na konec souboru (soubor případně vytvoří).', parameters: P({ path: STR('Cesta k souboru'), content: STR('Text k připsání') }, ['path', 'content']) },
  { type: 'function', name: 'edit_file', description: 'Přesná editace souboru: oldString musí v souboru sedět přesně 1x, jinak pošli větší kontext nebo replaceAll: true.', parameters: P({ path: STR('Cesta k souboru'), oldString: STR('Přesný původní text'), newString: STR('Nový text') }, ['path', 'oldString', 'newString']) },
  { type: 'function', name: 'read_file', description: 'Přečte textový soubor (max 40 KB).', parameters: P({ path: STR('Cesta k souboru') }) },
  { type: 'function', name: 'list_dir', description: 'Vypíše soubory a podsložky ve složce.', parameters: P({ path: STR('Cesta ke složce, "." = projekt') }) },
  { type: 'function', name: 'glob_file', description: 'Najde soubory podle vzoru (např. **/*.js, src/*.py).', parameters: P({ pattern: STR('Glob vzor'), dir: STR('Kde hledat, výchozí "."') }, ['pattern']) },
  { type: 'function', name: 'create_dir', description: 'Vytvoří složku včetně podsložek.', parameters: P({ path: STR('Cesta ke složce') }) },
  { type: 'function', name: 'move_file', description: 'Přesune nebo přejmenuje soubor (i obrázky) mezi složkami.', parameters: P({ from: STR('Zdrojová cesta'), to: STR('Cílová cesta') }, ['from', 'to']) },
  { type: 'function', name: 'copy_file', description: 'Zkopíruje soubor (i obrázek) do jiné složky.', parameters: P({ from: STR('Zdrojová cesta'), to: STR('Cílová cesta') }, ['from', 'to']) },
  { type: 'function', name: 'delete_file', description: 'Smaže soubor.', parameters: P({ path: STR('Cesta k souboru') }) },
  { type: 'function', name: 'file_info', description: 'Info o souboru/složce: velikost, datum, typ.', parameters: P({ path: STR('Cesta') }) },
  { type: 'function', name: 'search_files', description: 'Vyhledá text v souborech projektu (grep).', parameters: P({ pattern: STR('Hledaný text'), dir: STR('Kde hledat, výchozí "."'), ext: STR('Přípona bez tečky, např. js (volitelné)') }, ['pattern']) },
  { type: 'function', name: 'open_path', description: 'Otevře soubor/složku v systému (Průzkumník).', parameters: P({ path: STR('Cesta') }) },
  { type: 'function', name: 'web_fetch', description: 'Stáhne text webové stránky (https URL).', parameters: P({ url: STR('https://…') }, ['url']) },
  { type: 'function', name: 'web_search', description: 'Vyhledá cokoliv na internetu (plný přístup k webu).', parameters: P({ query: STR('Hledaný dotaz') }, ['query']) },
  { type: 'function', name: 'download_file', description: 'Stáhne soubor z internetu na disk (https URL → cesta). Umí i velké soubory.', parameters: P({ url: STR('https://…/soubor.zip'), to: STR('Kam uložit (relativně k projektu i absolutně)') }, ['url', 'to']) },
  { type: 'function', name: 'env_scan', description: 'Skenuje počítač a zjistí, co už je nainstalované (node, npm, python, pip, git, gcc/g++, MSVC, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, 7-Zip) a co je potřeba pro aktivní projekt i pro zadání uživatele. Nic neinstaluje. Volej NA ZAČÁTKU, když budeš něco stavět, kompilovat nebo spouštět.', parameters: P({ request: STR('Volitelné: co přesně uživatel chce, např. "udělej C++ program a zkompiluj exe"') }) },
  { type: 'function', name: 'env_prepare', description: 'Zjistí, co je potřeba (projekt + zadání uživatele + plánované příkazy) a VŠECHNO chybějící DOINSTALUJE SÁM: winget → Chocolatey → Scoop → stažení z internetu do aplikace, a pak rovnou pokračuje v práci. Než uživateli řekneš, ať si něco instaluje, zavolej tohle. Velké toolchainy (Visual Studio Build Tools, Docker, Android Studio) se bez dotazu neinstalují — u nich se nejdřív zeptej nástrojem question a pak volej znovu s heavy: true.', parameters: P({ request: STR('Co uživatel chce, v jeho vlastních slovech'), ids: { type: 'array', items: STR('id toolchainu'), description: 'Volitelné: konkrétní toolchainy místo automatického výběru' }, heavy: { type: 'boolean', description: 'Povolit velké instalace (GB) — jen když uživatel souhlasil' } }) },
  { type: 'function', name: 'env_install', description: 'Doinstaluje konkrétní toolchainy přes winget/Chocolatey/Scoop, jinak je stáhne z internetu (node, python, git, gcc, msvc, cmake, make, dotnet, java, maven, gradle, go, rust, bun, deno, php, ruby, docker, sevenzip, android). Volej jen když env_scan ukázal, že chybí.', parameters: P({ id: STR('jedno id, nebo víc oddělených čárkou'), ids: { type: 'array', items: STR('id toolchainu'), description: 'použij místo id, když chceš víc toolchainů' }, heavy: { type: 'boolean', description: 'Povolit velké instalace (GB)' } }) },
  { type: 'function', name: 'scaffold_electron', description: 'Vytvoří funkční kostru Electron projektu (package.json + main.js + index.html) pro EXE aplikaci. Volej VŽDY jako první krok, když uživatel chce Electron/desktropovou exe aplikaci. Pak dopiš kód, spusť shell npm install (timeout 600000) a npm run dist (timeout 600000).', parameters: P({ dir: STR('Složka projektu (relativně nebo absolutně)'), name: STR('Název aplikace') }, ['dir']) },
  { type: 'function', name: 'question', description: 'Zeptej se uživatele, když potřebuješ rozhodnutí nebo vyjasnění (např. kterou technologii zvolit). Ukaž mu možnosti, ze kterých vybere.', parameters: P({ questions: { type: 'array', description: 'Otázky (1-3)', items: { type: 'object', properties: { header: STR('Krátký nadpis'), question: STR('Otázka'), options: { type: 'array', items: { type: 'object', properties: { label: STR('Název volby'), description: STR('Popis volby') } } }, multiple: { type: 'boolean', description: 'Více voleb najednou' } } } } }, ['questions']) }
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
  } catch (e) { r = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
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

// Streaming pozadavku - renderer will call this and we stream back via event
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

    // VSECHNO jede pres branu NolimitCoder - zadny user key, vzdy Bearer public
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

    // Nikde ven nesmí pravé jméno modelu — jen NolimitCoderV2/V3
    const scrubModels = (s) => String(s || '')
      .split('muse-spark-1.3-contributor-free').join('NolimitCoderV3')
      .split('muse-spark-1.2-contributor-free').join('NolimitCoderV2');
    const agentOn = agent === true; // renderer posílá agent jen v Build modu; kam se smí, hlídá sandbox + panel
    const planOn = reqMode === 'plan';
    // LOCAL modely (Ollama / LM Studio / vLLM, OpenAI-kompatibilní)
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
    // Google search vypínač z Nastavení: web_search se vůbec nenabídne.
    const noWeb = websearch === false;
    const dropWeb = (arr, get) => noWeb ? arr.filter(t => get(t) !== 'web_search') : arr;
    const gR = (t) => t.name, gC = (t) => t.function.name;
    const READ_TOOLS_RESP = AGENT_TOOLS_RESP.filter(t => ['read', 'read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'question', 'env_scan'].includes(t.name));
    const READ_TOOLS_CHAT = AGENT_TOOLS_CHAT.filter(t => ['read', 'read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'question', 'env_scan'].includes(t.function.name));
    // Gatekeeper chce v seznamu i "shell" — v planu je to mrtvá zátka (model ho nesmí volat).
    const PLAN_TOOLS_RESP = [SHELL_GATE, ...READ_TOOLS_RESP];
    const PLAN_TOOLS_CHAT = [{ type: 'function', function: { name: 'shell', description: 'INTERNAL ONLY — never call this tool in plan mode.', parameters: P({ command: STR('ignored') }) } }, ...READ_TOOLS_CHAT];
    let url, body, headers;
    if (localBase) {
      // lokální OpenAI-kompatibilní endpoint, bez auth, bez tools gatekeeperu
      url = localBase.replace(/\/$/, '') + '/v1/chat/completions';
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ model: localModel, messages, stream: true, max_tokens: maxT });
    } else {
      headers = zenHeaders;
      if (RESPONSES_MODELS.has(mId)) {
      // Muse Spark free -> Responses API (chat/completions vraci 500)
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
      // Zbytek FREE -> /chat/completions (stream:true + chat-tools + prompt_cache_key = povinne)
      // Bez agenta: tool_choice:none = model NESMÍ volat tools (gatekeeper kontroluje jen přítomnost tools pole),
      // jinak slabé FREE modely občas vypustí "undefined" / phantom tool-call bláboly
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
    // Vse (brana i lokalni modely) jede vzdy naprimo. Zadna proxy, zadna VPN.
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

    // --- Požadavek na bránu: napřímo, při quota/429 automaticky přes random proxy ---
    const MAX_PROXY_TRIES = 5;
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

    // Společný streamovač odpovědi (direct i proxy) — chunky jdou rovnou do rendereru.
    const streamDirect = () => new Promise((resolve) => {
      if (localBase) {
        // lokální modely vždy napřímo, proxy nedává smysl
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
        // síťová chyba napřímo → rovnou zkusit proxy (třeba je problém na IP)
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
          // terminální stav řeší volající (resolve s výsledkem), nechceme double-finish
          if (ch === 'chat:stream-end' || ch === 'chat:stream-error') { finishOnce(ch, data, chunks, bytes); resolve({ fatal: true }); return; }
        }
        // průběžné volání done bez resolve → jen úklid (nepoužívá se)
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
      // úspěšný start streamu — dej vědět volajícímu, že jede (aby nezkoušel další proxy)
      if (resolve) resolve({ streaming: true });
      // přepneme resolve na no-op, další události už jen forwardují chunky
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
            // hlavicku s chybou resime v onChunk/onEnd sběrem těla
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
          // prázdný stream přes proxy (padlý tunel bez dat) → brát jako fail proxy, zkusit další
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

    // Hlavní smyčka: direct → při quota/netError okamžitě random proxy (max 5×), každá jiná.
    (async () => {
      if (localBase) { await streamDirect(); return; }
      // Když se blížíme limitu (čerstvá 429), začít rovnou přes proxy — je to rychlejší než další 429 napřímo.
      if (PX.shouldUseProxyFirst()) {
        for (let i = 0; i < MAX_PROXY_TRIES && !finished; i++) {
          const proxy = PX.getRandomProxy(i === 0 ? null : undefined);
          if (!proxy) break;
          notifyProxy(proxy, i === 0 ? 'preemptive-quota' : 'retry');
          safeSend('chat:stream-chunk', ''); // udržet spojení
          const r = await streamViaProxy(proxy);
          if (r.fatal) return;
          if (r.quota) { PX.markBad(proxy); continue; }       // quota i přes proxy → další random proxy
          if (r.proxyFail) { PX.markBad(proxy); continue; }    // padlá proxy → další
          if (r.streaming) return; // jede — zbytek řeší forwardování
        }
        // proxy pool vyčerpán → padnout zpět na direct (ať renderer aspoň dostane poctivou 429)
      }
      const d = await streamDirect();
      if (d && (d.quota || d.netError)) {
        const whyQuota = !!d.quota;
        if (whyQuota) { try { safeSend('chat:stream-chunk', ''); } catch {} }
        for (let i = 0; i < MAX_PROXY_TRIES && !finished; i++) {
          const proxy = PX.getRandomProxy();
          if (!proxy) break;
          notifyProxy(proxy, whyQuota ? 'quota-switch' : 'neterror-switch');
          const r = await streamViaProxy(proxy);
          if (r.fatal) return;
          if (r.quota || r.proxyFail) { PX.markBad(proxy); continue; }
          if (r.streaming) return;
        }
        // Všechny proxy selhaly → poctivá hláška s quota příznakem (renderer zkusí 2. model)
        if (!finished) {
          const raMs = d.retryAfterMs || 0;
          finishOnce('chat:stream-error', {
            error: scrubModels(`HTTP ${d.status || 429}: ${String(d.body || d.error || 'quota').slice(0, 1200)} (zkuseno i přes ${MAX_PROXY_TRIES} proxy)`),
            url, isRateLimit: true, retryAfterMs: raMs, viaExhausted: true,
          }, 0, 0);
        }
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

// ===== VESTAVĚNÝ TERMINÁL (uživatelův — normální práva, bez ptaní, bez oken) =====
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

// ===== LIVE PREVIEW pro Website projekty (localhost server jen pro 127.0.0.1) =====
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
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'Složka neexistuje' };
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
      // React/Vue build do dist/ má přednost před kořenem
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
      // SPA fallback: bezpříponové cesty padnou na index (client routing), jinak 404 nápověda
      if ((!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) && path.extname(abs) === '') {
        const idx = path.join(effRoot, 'index.html');
        if (fs.existsSync(idx)) abs = idx;
      }
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<body style="background:#101010;color:#888;font-family:sans-serif"><h3>404 — v projektu zatím nic není. Nech AI něco vygenerovat (index.html).</h3></body>');
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
  return { ok: false, error: 'Server se nepovedlo spustit' };
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
