// NolimitCoder tools — complete toolset (bash/read/write/edit/glob/grep/env)
// Pure node module with no electron dependencies (testable). Called by main.js via IPC.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const net = require('net');

/* ===== AI debug log (dist/ai-debug.log) — agent behavior diagnostics =====
   Every loop turn, every tool, every AI request is written here.
   The file rotates at 8 MB. Everything in try/catch — logging must never break anything. */
let dbgFile = '';
let dbgWrites = 0;
function dbgFilePath() {
  if (dbgFile) return dbgFile;
  // Stejná složka jako Error Log (Logs/…) — všechny logy na jednom místě.
  try {
    const dir = require('./errlog').logsDir();
    if (dir) { dbgFile = path.join(dir, 'ai-debug.log'); return dbgFile; }
  } catch {}
  // BEZPEČNOST: debug log do uživatelského profilu, NE vedle instalace.
  try {
    const e = require('electron');
    if (e && e.app) {
      const dir = path.join(e.app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      dbgFile = path.join(dir, 'ai-debug.log');
      return dbgFile;
    }
  } catch {}
  const dirs = [];
  try {
    const here = String(__dirname || '');
    if (!/app\.asar/i.test(here)) dirs.push(path.join(here, '..', '..')); // dev: src/main -> root
  } catch {}
  try {
    const e = require('electron');
    if (e && e.app && e.app.isPackaged) dirs.push(path.dirname(process.execPath));
  } catch {}
  try { dirs.push(process.cwd()); } catch {}
  for (const d of dirs) {
    try {
      const dir = path.join(d, 'dist');
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.wtest');
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe, { force: true });
      dbgFile = path.join(dir, 'ai-debug.log');
      break;
    } catch {}
  }
  if (!dbgFile) { try { dbgFile = path.join(os.tmpdir(), 'ai-debug.log'); } catch {} }
  return dbgFile;
}
function dbgLog(tag, data) {
  try {
    const f = dbgFilePath();
    if (!f) return;
    if (++dbgWrites % 20 === 0) {
      try {
        if (fs.statSync(f).size > 8 * 1048576) {
          try { fs.rmSync(f + '.old', { force: true }); } catch {}
          try { fs.renameSync(f, f + '.old'); } catch {}
        }
      } catch {}
    }
    const seen = { n: 0 };
    const json = JSON.stringify(data === undefined ? null : data, (k, v) => {
      if (typeof v === 'string' && v.length > 2000) return v.slice(0, 2000) + `…[${v.length}]`;
      if (typeof v === 'object' && v !== null) { if (++seen.n > 200) return '[…]'; }
      return v;
    });
    fs.appendFileSync(f, scrubSecrets(`[${new Date().toISOString()}] [${tag}] ${json}\n`));
  } catch {}
}
// BEZPEČNOST: z logů se mažou tajemství (tokeny, hesla, klíče) — nikdy plaintext.
function scrubSecrets(s) {
  let t = String(s || '');
  t = t.replace(/ya29\.[\w\-.~+/=]+/g, '[TOKEN]');
  t = t.replace(/"?(refresh_token|access_token|client_secret|id_token)"?\s*[:=]\s*"[^"]*"/gi, '"$1":"[SECRET]"');
  t = t.replace(/'?(refresh_token|access_token|client_secret|id_token)'?\s*[:=]\s*'[^']*'/gi, "'$1':'[SECRET]'");
  t = t.replace(/(refresh_token|access_token|client_secret)\s*=\s*\S+/gi, '$1=[SECRET]');
  t = t.replace(/(password|passwd|pwd|api[_-]?key|secret)\s*[:=]\s*(\S+)/gi, '$1=[SECRET]');
  t = t.replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [SECRET]');
  t = t.replace(/token=[^\s&"']+/gi, 'token=[SECRET]');
  return t;
}

const BLOCKED_PREFIXES = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', '/etc/', '/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
const TEXT_EXT = new Set(['.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.json', '.py', '.html', '.css', '.c', '.cpp', '.h', '.java', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.ps1', '.vue', '.svelte']);

// Compilers/runtime: find in PATH and outside it, and when missing,
// install via winget, otherwise portable from the internet into userData/tools.
const TOOLCHAINS = {
  node: { label: 'Node.js', bins: [['node', '--version']], winget: 'OpenJS.NodeJS.LTS', url: 'https://nodejs.org/', portable: 'node', cmds: ['node', 'npm', 'npx', 'corepack', 'tsc', 'ts-node', 'electron', 'electron-builder', 'vite', 'next', 'webpack', 'rollup', 'eslint', 'prettier', 'yarn', 'pnpm', 'ng', 'expo'] },
  python: { label: 'Python', bins: [['python', '--version'], ['py', '--version']], winget: 'Python.Python.3.12', url: 'https://www.python.org/downloads/', portable: 'python', cmds: ['python', 'py', 'pip', 'pip3', 'pytest', 'django-admin', 'flask', 'uvicorn', 'gunicorn', 'black', 'ruff', 'mypy', 'poetry'] },
  git: { label: 'Git', bins: [['git', '--version']], winget: 'Git.Git', url: 'https://git-scm.com/downloads', portable: 'git', cmds: ['git', 'gh'] },
  gcc: { label: 'GCC / MinGW (C, C++)', bins: [['gcc', '--version'], ['g++', '--version']], winget: 'BrechtSanders.WinLibs.POSIX.UCRT', url: 'https://winlibs.com/', portable: 'gcc', cmds: ['gcc', 'g++', 'cc', 'c++', 'cpp', 'ar', 'ld', 'strip', 'objdump', 'objcopy', 'nm', 'ranlib', 'windres', 'dlltool', 'mingw32-make', 'gdb'] },
  msvc: { label: 'MSVC (Visual Studio Build Tools)', heavy: true, probe: 'vswhere', bins: [['cl', '--version']], winget: 'Microsoft.VisualStudio.2022.BuildTools', wingetExtra: ' --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"', url: 'https://visualstudio.microsoft.com/downloads/', cmds: ['cl', 'msbuild', 'devenv', 'nmake', 'link', 'lib', 'rc'] },
  cmake: { label: 'CMake', bins: [['cmake', '--version']], winget: 'Kitware.CMake', url: 'https://cmake.org/download/', portable: 'cmake', cmds: ['cmake', 'ctest', 'cpack'] },
  make: { label: 'Make', bins: [['mingw32-make', '--version'], ['make', '--version']], winget: 'GnuWin32.Make', url: 'https://www.mingw-w64.org/', cmds: ['make', 'mingw32-make', 'gmake'] },
  dotnet: { label: '.NET SDK', bins: [['dotnet', '--version']], winget: 'Microsoft.DotNet.SDK.9', url: 'https://dotnet.microsoft.com/download', portable: 'dotnet', cmds: ['dotnet', 'msbuild', 'nuget', 'csc'] },
  java: { label: 'Java (JDK)', bins: [['java', '-version'], ['javac', '-version']], winget: 'Microsoft.OpenJDK.21', url: 'https://adoptium.net/', portable: 'java', cmds: ['java', 'javac', 'jar', 'javadoc', 'keytool'] },
  maven: { label: 'Maven', deps: ['java'], bins: [['mvn', '-v']], winget: 'Apache.Maven', url: 'https://maven.apache.org/download.cgi', cmds: ['mvn'] },
  gradle: { label: 'Gradle', deps: ['java'], bins: [['gradle', '-v']], winget: 'Gradle.Gradle', url: 'https://gradle.org/install/', cmds: ['gradle', 'gradlew'] },
  go: { label: 'Go', bins: [['go', 'version']], winget: 'GoLang.Go', url: 'https://go.dev/dl/', portable: 'go', cmds: ['go', 'gofmt'] },
  rust: { label: 'Rust (Cargo)', bins: [['cargo', '--version']], winget: 'Rustlang.Rustup', url: 'https://rust-lang.org/tools/install', portable: 'rust', cmds: ['cargo', 'rustc', 'rustup', 'rustfmt'] },
  bun: { label: 'Bun', bins: [['bun', '--version']], winget: 'Oven-sh.Bun', url: 'https://bun.sh/', portable: 'bun', cmds: ['bun', 'bunx'] },
  deno: { label: 'Deno', bins: [['deno', '--version']], winget: 'DenoLand.Deno', url: 'https://deno.com/', portable: 'deno', cmds: ['deno'] },
  php: { label: 'PHP', bins: [['php', '-v']], winget: 'PHP.PHP.8.3', url: 'https://windows.php.net/download/', portable: 'php', cmds: ['php', 'composer'] },
  ruby: { label: 'Ruby', bins: [['ruby', '-v']], winget: 'RubyInstallerTeam.RubyInstallerWithDevKit', url: 'https://rubyinstaller.org/', cmds: ['ruby', 'gem', 'bundle', 'rake', 'rails'] },
  docker: { label: 'Docker Desktop', heavy: true, bins: [['docker', '--version']], winget: 'Docker.DockerDesktop', url: 'https://www.docker.com/products/docker-desktop/', cmds: ['docker', 'docker-compose'] },
  sevenzip: { label: '7-Zip', bins: [['7z', 'i'], ['7zr', 'i']], winget: '7zip.7zip', url: 'https://www.7-zip.org/', portable: 'sevenzip', cmds: ['7z', '7za', '7zr'] },
  android: { label: 'Android Studio + SDK', heavy: true, bins: [['adb', 'version']], winget: 'Google.AndroidStudio', url: 'https://developer.android.com/studio', cmds: ['adb', 'sdkmanager'] },
  unity: { label: 'Unity Editor', heavy: true, manual: true, bins: [['unity', '-version']], url: 'https://unity.com/download', cmds: ['unity'] },
  unreal: { label: 'Unreal Engine', heavy: true, manual: true, bins: [['UnrealEditor', '-version']], url: 'https://www.unrealengine.com/download', cmds: [] }
};
const TOOL_GROUPS = { cpp: { label: 'C/C++ compiler', prefer: ['msvc', 'gcc'], install: ['gcc'] } };
// Package managers as a second instance (some PCs lack winget but have choco/scoop)
const PKG_ALIAS = {
  node: { choco: 'nodejs-lts', scoop: 'nodejs-lts' },
  python: { choco: 'python312', scoop: 'python' },
  git: { choco: 'git', scoop: 'git' },
  gcc: { choco: 'mingw', scoop: 'gcc' },
  msvc: { choco: 'visualstudio2022buildtools', scoop: 'vscode' },
  cmake: { choco: 'cmake', scoop: 'cmake' },
  make: { choco: 'make', scoop: 'make' },
  dotnet: { choco: 'dotnet-sdk', scoop: 'dotnet-sdk' },
  java: { choco: 'temurin21', scoop: 'temurin21-jdk' },
  maven: { choco: 'maven', scoop: 'maven' },
  gradle: { choco: 'gradle', scoop: 'gradle' },
  go: { choco: 'golang', scoop: 'go' },
  rust: { choco: 'rustup.install', scoop: 'rustup' },
  bun: { choco: 'bun', scoop: 'bun' },
  deno: { choco: 'deno', scoop: 'deno' },
  php: { choco: 'php', scoop: 'php' },
  ruby: { choco: 'ruby', scoop: 'ruby' },
  docker: { choco: 'docker-desktop', scoop: 'docker' },
  sevenzip: { choco: '7zip', scoop: '7zip' },
  android: { choco: 'android-studio', scoop: 'android-studio' }
};
for (const [id, m] of Object.entries(PKG_ALIAS)) if (TOOLCHAINS[id]) Object.assign(TOOLCHAINS[id], m);
const TOOL_ALIAS = {
  pip: 'python', pip3: 'python', python3: 'python', py: 'python', conda: 'python',
  npm: 'node', npx: 'node', yarn: 'node', pnpm: 'node', tsc: 'node',
  'g++': 'gcc', cc: 'gcc', cxx: 'gcc', 'c++': 'gcc', clang: 'gcc', 'clang++': 'gcc',
  cl: 'msvc', msbuild: 'msvc', nmake: 'msvc',
  cargo: 'rust', rustc: 'rust', rustup: 'rust',
  javac: 'java', jar: 'java', mvn: 'maven', gradlew: 'gradle', 'mingw32-make': 'make',
  composer: 'php', gem: 'ruby', bundle: 'ruby', gh: 'git', 'docker-compose': 'docker'
};
const CMD_TOOL = (() => { const m = new Map(); for (const [id, d] of Object.entries(TOOLCHAINS)) for (const c of d.cmds || []) if (!m.has(c)) m.set(c, id); return m; })();
const COMPILERS = TOOLCHAINS;

function normToolName(t) {
  return String(t || '').replace(/^(default|functions|tools)\./i, '').trim().toLowerCase();
}
function foldKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function knownFolders() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  return {
    'documents': docs, 'dokumenty': docs,
    'desktop': path.join(home, 'Desktop'), 'plocha': path.join(home, 'Desktop'),
    'downloads': path.join(home, 'Downloads'), 'stazene': path.join(home, 'Downloads'),
    'pictures': path.join(home, 'Pictures'), 'obrazky': path.join(home, 'Pictures'),
    'music': path.join(home, 'Music'), 'hudba': path.join(home, 'Music'),
    'videos': path.join(home, 'Videos'), 'videa': path.join(home, 'Videos'),
    'home': home, 'domu': home, 'temp': os.tmpdir(), 'tmp': os.tmpdir()
  };
}
/* Expande systemovych promennych v cestach: %TEMP% (cmd styl), $env:TEMP (PowerShell),
   $HOME a ~ (unix styl). BEZ TOHO vznikne v projektu literalni slozka "%TEMP%", protoze
   AI posila %TEMP%/nolimitcoder/... i do SOUBOROVYCH nastroju (copy_file, write_file...),
   kde cmd.exe neexpanduje nic. Po expanzi ukazuje cesta na skutecny Temp. */
/* Zakaz zalohovaciho bordelu v projektu: .uibak/, *.bak, *-backup, *-old, *-kopie...
   AI si pred editaci delalo "zalohy" (create_dir .uibak + copy_file), takze v projektu
   zustaval balast. edit_file je presny a nepotrebuje zalohy. Kdyz uzivatel VYSLOVNE
   chce zalohu, at si rekne - pak se pravidlo obejde pres shell (tenhle guard plati jen
   pro souborove nastroje). Vraci text zamitnuti, nebo null. */
function backupJunkGuard(absPath) {
  const s = String(absPath || '');
  const low = s.toLowerCase();
  const segs = low.replace(/\\/g, '/').split('/');
  for (const g of segs) {
    if (!g) continue;
    // skryte zalohovaci adresare: .uibak, .bak, .backup, .old...
    if (/^\.(uibak|bak|backup|backups|old|orig|tmp)$/.test(g))
      return 'Zalohovaci slozka "' + g + '" je zakazana - projekt musi zustat cisty. Edituj primo (edit_file je presny, zalohy nepotrebuje). Pokracuj bez zalohy.';
    // slozky typu xxx-backup, xxx-old, xxx-kopie, xxx-copy, xxx-bak
    if (/-(backup|backups|bak|old|orig|copy|copies|kopie|zaloha)$/.test(g) || /^(backup|backups|zalohy|tmp)[-_]/.test(g))
      return 'Zalohovaci slozka "' + g + '" je zakazana - projekt musi zustat cisty. Edituj primo a pokracuj bez zalohy.';
  }
  const base = segs[segs.length - 1] || '';
  if (/\.(bak|orig|rej|old)$/.test(base) || /~$/.test(base))
    return 'Zalohovaci soubor "' + base + '" je zakazany - projekt musi zustat cisty. Edituj primo a pokracuj bez zalohy.';
  return null;
}
function expandEnvVars(p) {
  let s = String(p || '');
  if (!s) return s;
  // $env:NAME (PowerShell) -> hodnota
  s = s.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => process.env[name] !== undefined ? process.env[name] : m);
  // %NAME% (Windows cmd) -> hodnota
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    if (process.env[name] !== undefined) return process.env[name];
    const up = Object.keys(process.env).find(k => k.toUpperCase() === name.toUpperCase());
    return up ? process.env[up] : m;
  });
  // $HOME, $HOMEPATH, ~
  s = s.replace(/\$HOME\b/g, os.homedir());
  if (/^~([\\/]|$)/.test(s)) s = os.homedir() + s.slice(1);
  return s;
}
function resolveTarget(root, p, fullAccess) {
  let raw = expandEnvVars(String(p || ''));
  if (!path.isAbsolute(raw) && root) {
    // Model občas zopakuje jméno projektové složky ("PAXI 1/main.js" při rootu
    // "...\PAXI 1") → vznikla by vnořená složka PAXI 1\PAXI 1 a zápis "se neuložil".
    // První segment shodný se jménem rootu se škrtá (legitimní vnořená složka
    // stejného jména je prakticky vyloučená; známé složky typu Documents se neškrtají).
    const pre = raw.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
    const base0 = path.basename(path.resolve(String(root))).toLowerCase();
    if (pre.length > 1 && base0 && pre[0].toLowerCase() === base0 && !knownFolders()[foldKey(pre[0])]) {
      raw = pre.slice(1).join('/');
    }
  }
  let abs;
  if (path.isAbsolute(raw)) {
    abs = path.normalize(raw);
  } else {
    const segs = raw.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
    const hit = segs.length ? knownFolders()[foldKey(segs[0])] : null;
    abs = hit ? path.join(hit, ...segs.slice(1)) : path.resolve(root, raw);
  }
  // Žádné omezování: AI může zapisovat kamkoli na disk, i do C:\Windows a Program Files.
  if (!fullAccess) {
    const r = path.resolve(root);
    const inProj = abs === r || abs.startsWith(r + path.sep);
    if (!inProj) {
      const userOk = Object.entries(knownFolders()).some(([k, v]) => {
        if (k === 'home' || k === 'domu') return false;
        const kr = path.resolve(v);
        return abs === kr || abs.startsWith(kr + path.sep);
      });
      if (!userOk) throw new Error('Outside the project folder (Documents/Desktop/Downloads are also allowed, or enable Full access in Settings): ' + abs);
    }
  }
  return abs;
}
// The model sometimes sends a parameter under a different name (file, filename…) — unify it
const ARG_ALIASES = {
  path: ['path', 'file', 'filename', 'filepath', 'file_path', 'target', 'to', 'dest', 'destination', 'name', 'dir', 'folder'],
  from: ['from', 'source', 'src', 'sourcepath', 'source_path', 'oldpath', 'old_path'],
  to: ['to', 'dest', 'destination', 'target', 'targetpath', 'target_path', 'newpath', 'new_path', 'output', 'outfile'],
  content: ['content', 'text', 'data', 'body', 'code', 'value'],
  pattern: ['pattern', 'query', 'text', 'search', 'regex'],
  dir: ['dir', 'directory', 'folder', 'path', 'cwd', 'in'],
  command: ['command', 'cmd', 'input', 'script', 'code', 'run'],
  url: ['url', 'link', 'href', 'address'],
  oldString: ['oldstring', 'old_string', 'old', 'search', 'find'],
  newString: ['newstring', 'new_string', 'new', 'replace', 'replacement']
};
function canonArgs(tool, args) {
  const out = { ...(args || {}) };
  const wants = {
    write_file: ['path', 'content'], append_file: ['path', 'content'],
    read_file: ['path'], list_dir: ['path'], create_dir: ['path'],
    move_file: ['from', 'to'], copy_file: ['from', 'to'], delete_file: ['path'],
    file_info: ['path'], search_files: ['pattern', 'dir'], open_path: ['path'],
    edit_file: ['path', 'oldString', 'newString'], glob_file: ['pattern', 'dir'],
    shell: ['command'], web_fetch: ['url'], env_install: ['id']
  }[tool] || [];
  const low = {};
  for (const k of Object.keys(out)) low[k.toLowerCase()] = k;
  for (const canon of wants) {
    if (out[canon] !== undefined && out[canon] !== null && out[canon] !== '') continue;
    for (const al of (ARG_ALIASES[canon] || [])) {
      const hit = low[al.toLowerCase()];
      if (hit && out[hit] !== undefined && out[hit] !== null && out[hit] !== '') { out[canon] = out[hit]; break; }
    }
  }
  return out;
}
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}
// Models often write unix commands even on Windows + smart quotes/dashes.
// Translate to cmd.exe equivalents so it works without errors.
function normalizeShell(cmd, light) {
  let c = String(cmd || '');
  c = c.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-').replace(/ /g, ' ');
  if (light || process.platform !== 'win32') return c;
/* Rozdeli prikaz na segmenty podle &&, || a ; — ale jen MIMO uvozovky.
   `node -e "const a=1;const b=2"` se nesmi rozdelit ani prelozit (strednik patri JS).
   Respektuje "...", '...' i `...` vcetne escapovani. */
function splitShellSegments(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '', quote = null, esc = false;
  const push = () => { out.push(cur); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\' && quote !== "'") { cur += ch; esc = true; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`' ) { quote = ch; cur += ch; continue; }
    if (ch === '&' && s[i + 1] === '&') { push(); out.push('&&'); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { push(); out.push('||'); i++; continue; }
    if (ch === ';') { push(); out.push(';'); continue; }
    cur += ch;
  }
  push();
  return out;
}
  const parts = splitShellSegments(c);
  const map1 = { pwd: 'cd', clear: 'cls', ls: 'dir', cat: 'type', cp: 'copy', mv: 'move', touch: 'type nul >' };
  return parts.map(seg => {
    // cmd.exe `;` NENÍ oddělovač příkazů (umí ho až PowerShell) → "node -v; x" spadne
    // jako "node: bad option: -v;". Pro cmd překládáme `;` na `&`.
    if (/^\s*;\s*$/.test(seg)) return seg.replace(';', '&');
    if (/^\s*(&&|\|\|)\s*$/.test(seg)) return seg;
    const m = seg.match(/^(\s*)([A-Za-z][\w.-]*)([\s\S]*)$/);
    if (!m) return seg;
    const [, pre, name, rest] = m;
    const low = name.toLowerCase();
    if (low === 'ls') return pre + 'dir' + rest.replace(/\s-[a-zA-Z]+\b/g, '');
    if (low === 'rm') {
      if (/\s-[a-zA-Z]*r/i.test(rest)) return pre + 'rmdir /s /q' + rest.replace(/\s-[a-zA-Z]+\b/g, '');
      return pre + 'del' + rest;
    }
    if (low === 'mkdir') return pre + 'mkdir' + rest.replace(/\s-p\b/g, '');
    if (low === 'cp' && /\s-[a-zA-Z]*r/i.test(rest)) return pre + 'xcopy' + rest.replace(/\s-[a-zA-Z]+\b/g, '');
    if (low === 'which' || low === 'command') return pre + 'where' + rest;
    if (low === 'export') return pre + 'set' + rest;
    if (low === 'sleep') {
      const n = (rest.match(/\d+/) || ['5'])[0];
      return `${pre}timeout /t ${n} >nul`;
    }
    if (map1[low]) return pre + map1[low] + rest;
    return seg;
  }).join('');
}
// The console writes Czech in OEM (cp852) — Node cannot decode it, so a custom table (empirically verified).
const OEM_CZ = {0xa0:'\u00e1',0x9f:'\u010d',0xd4:'\u010f',0x82:'\u00e9',0xd8:'\u011b',0xa1:'\u00ed',0xe5:'\u0148',0xa2:'\u00f3',0xfd:'\u0159',0xe7:'\u0161',0x9c:'\u0165',0xa3:'\u00fa',0x85:'\u016f',0xec:'\u00fd',0xa7:'\u017e',0xb5:'\u00c1',0xac:'\u010c',0xd2:'\u010e',0x90:'\u00c9',0xb7:'\u011a',0xd6:'\u00cd',0xd5:'\u0147',0xe0:'\u00d3',0xfc:'\u0158',0xe6:'\u0160',0x9b:'\u0164',0xe9:'\u00da',0xde:'\u016e',0xed:'\u00dd',0xa6:'\u017d'};
function decodeConsole(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  let s = '';
  for (const byte of b) s += byte < 0x80 ? String.fromCharCode(byte) : (OEM_CZ[byte] || String.fromCharCode(byte));
  return s;
}
/* Zápis obsahu souboru přes `shell` je vždy past. Na Windows to končí buď
   "The string is missing the terminator: '@" (here-string), nebo "The command line
   is too long." (limit cmd.exe 8191 znaků) — soubor se neuloží a model to opakuje.
   Nástroj `write_file` existuje přesně na to. Tady příkaz odmítneme a řekneme,
   co volat místo toho; tím se celá chybaová třída odstraní, neopakuje. */
/* Zakaz destruktivnich prikazu na systemove cesty. AI jednou zavolalo
   `rmdir /s /q "%TEMP%"` - v shellu se %TEMP% expanduje na SKUTECNY Windows Temp
   a prikaz zacal mazat cely docasny adresar systemu. Tohle se nesmi stat nikdy.
   Vraci text zamitnuti, nebo null. */
// Kriticke systemove procesy se pres taskkill/Stop-Process NESMI — model v zoufalstvi
// (zamek app.asar) zkousel zabijet i explorer.exe. Seznam se kontroluje u /IM i /FI filtru.
const CRITICAL_PROC = new Set(['system', 'registry', 'memory compression', 'smss.exe', 'csrss.exe',
  'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  'sihost.exe', 'taskhostw.exe', 'runtimebroker.exe', 'shellhost.exe', 'startmenuexperiencehost.exe',
  'searchhost.exe', 'searchindexer.exe', 'fontdrvhost.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe',
  'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'nolimitcoder.exe', 'electron.exe']);
function criticalProcGuard(cmd) {
  const c = String(cmd || '');
  const targets = [];
  let m;
  const reIM = /taskkill(?:\.exe)?\s+(?:\/[a-z]+\s+)*?\/IM\s+("([^"]+)"|(\S+))/gi;
  while ((m = reIM.exec(c))) targets.push(m[2] || m[3]);
  const reFI = /IMAGENAME\s+eq\s+("([^"]+)"|(\S+))/gi;
  while ((m = reFI.exec(c))) targets.push(m[2] || m[3]);
  const reSP = /Stop-Process\s+(?:-[A-Za-z]+\s+\S+\s+)*-Name\s+("([^"]+)"|'([^']+)'|([^\s;,]+))/gi;
  while ((m = reSP.exec(c))) targets.push(m[2] || m[3] || m[4]);
  for (let t of targets) {
    t = String(t || '').toLowerCase().replace(/["',;]+$/, '');
    if (!t) continue;
    if (t.includes('*')) return 'ZAMITNUTO - taskkill s hvezdickou (*) by zabil vsechno. Mir vzdycky na jedno konkretni exe aplikace z dist/.';
    const base = t.split(/[\\/]/).filter(Boolean).pop() || t;
    const name = /\.exe$/i.test(base) ? base.toLowerCase() : (base + '.exe').toLowerCase();
    if (CRITICAL_PROC.has(name)) {
      return 'ZAMITNUTO - proces "' + base + '" je systemovy (Plocha/okna/konzole/samotna aplikace). Jeho ukonceni by shodilo Windows nebo zabilo vlastni terminal. Zabijej jen jedno konkretni exe aplikace z dist/.';
    }
  }
  return null;
}
function destructiveShellGuard(cmd) {
  const c = String(cmd || '');
  if (!/\b(rmdir|rd|del|erase|format|takeown|icacls)\b/i.test(c)) return null;
  // "format" JEN jako formátování disku: cmd `format C:`, `format /q c:`, PS `Format-Volume`.
  // PowerShellský výpis `Format-List`/`Format-Table` a `--format json` nesmějeme zamítnout —
  // AI pak jen ztrácelo kola tím, že zkoušelo jiný shell a dostalo to samé zamítnutí.
  if (/\bformat\s*(\/[a-z]|[a-z]:)/i.test(c) || /\bformat-volume\b/i.test(c)) {
    return 'ZAMITNUTO - prikaz format je zakazany. Disky se neformatuji, nikdy.';
  }
  // expanduj %VAR% pro kontrolu (shell by je expandoval taky)
  let x = c;
  try { x = expandEnvVars(c); } catch {}
  const low = x.toLowerCase();
  const home = os.homedir().toLowerCase();
  const windir = (process.env.WINDIR || process.env.SYSTEMROOT || 'C:\\Windows').toLowerCase();
  const tmp = (process.env.TEMP || process.env.TMP || '').toLowerCase();
  const sysRoots = [windir, tmp, home, 'c:', 'c:/', 'c:\\windows', 'c:/windows',
    'c:\\program files', 'c:/program files', 'c:\\program files (x86)', 'c:/program files (x86)'];
  // rmdir/rd/del s /s /q na koren systemu, Windows, profil nebo cely Temp = stop
  const delRe = /\b(rmdir|rd)\b[^&|]*?\/s|\bdel\b[^&|]*?\/s/i;
  if (!delRe.test(c)) return null;
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '');
  // najdi cil: text v uvozovkach nebo posledni parametr bez prepinacu
  const quoted = [...c.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const bare = c.split(/[&|]/).map(s => s.trim().split(/\s+/).pop()).filter(Boolean);
  const cands = [...quoted, ...bare].map(s => { try { return norm(expandEnvVars(s).toLowerCase()); } catch { return norm(s.toLowerCase()); } });
  for (const cand of cands) {
    for (const r of sysRoots) {
      if (!r) continue;
      const rn = norm(r);
      if (cand === rn || cand === rn + '\\*'
        || cand.startsWith(rn + '\\') || cand.startsWith(rn + '/')) return 'ZAMITNUTO - mazani systemove cesty "' + cand + '" je zakazano (rmdir/del /s /q na Windows, profil, Temp nebo disk). Pracuj jen uvnitr projektu.';
    }
  }
  return null;
}
function shellFileWriteGuard(cmd) {
  const c = String(cmd || '');
  if (!c.trim()) return null;
  const has = (re) => re.test(c);
  // 1) PowerShell here-string  @' … '@   (musí být na vlastních řádcích)
  if (has(/@'/)) {
    return "PowerShell here-string (@' … '@) nepoužívej — cmd.exe má limit 8191 znaků a '@ musí být na začátku řádku. Použij nástroj write_file.";
  }
  if (has(/Set-Content|Out-File|Add-Content/i)) {
    return 'Zapisování souborů přes Set-Content/Out-File je křehké (limity, kódování, uvozovky). Použij nástroj write_file.';
  }
  // 2) bash heredoc  cat <<EOF … EOF
  if (has(/<<-?\s*['"]?[A-Za-z_]/)) {
    return 'Bash heredoc (<<EOF) na Windows nefunguje. Použij nástroj write_file.';
  }
  // 3) přesměrování do souboru:  > file  /  >> file  (2>nul a /dev/null jsou OK)
  const redirects = c.match(/(?:^|[^0-9<>])>>?\s*("[^"]+"|'[^']+'|[^\s>|&]+)/g) || [];
  const realTargets = redirects
    .map(s => s.replace(/^(?:^|[^0-9<>])>>?\s*/, '').replace(/^["']|["']$/g, ''))
    .filter(t => t && !/^(nul|null|\/dev\/null|&[12])$/i.test(t));
  if (realTargets.length && (c.length > 500 || has(/@'|<<|Set-Content/i))) {
    return 'Přesměrování (' + realTargets.slice(0, 2).join(', ') + ') je nebezpečné pro dlouhý obsah — cmd.exe zkrátí příkaz na 8191 znaků. Použij nástroj write_file.';
  }
  return null;
}

// Spuštění okenní aplikace (start "" app.exe nebo app.exe) čekáním na výstup navěky
// visí — okno běží dál a dědí si stdout. Takový příkaz pustíme odpojeně a hned vrátíme.
function isGuiLaunch(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  // start [title] "cesta\app.exe"  |  "cesta\app.exe"  |  app.exe
  // + start BEZ uvozovek (start \ byl přesně ten systémový dialog)
  if (/^\s*start\b/i.test(c)) return /\.exe\b/i.test(c) || !!guiTarget(c);
  if (/^\s*"[^"]+\.exe"(\s|$)/i.test(c)) return true;
  if (/^\s*[^\s"']+\.exe(\s|$)/i.test(c) && !/[&|<>]/.test(c)) return true;
  return false;
}
// Cíl GUI spuštění (start "" "cesta\app.exe" | "cesta\app.exe" | app.exe).
// Když cíl neexistuje, cmd/start by ukázal SYSTÉMOVÝ dialog "Windows nemůže nalézt" —
// tomu bráníme kontrolou předem a vrátíme čistou chybu.
function guiTarget(cmd) {
  const c = String(cmd || '');
  let m = c.match(/^\s*start\s+(?:"[^"]*"\s+)?"([^"]+)"/i) || c.match(/^\s*"([^"]+\.exe)"/i);
  if (m) return m[1];
  // start [switches] [title] target — i BEZ uvozovek (start \ = systémový dialog)
  m = c.match(/^\s*start\s+(.*)$/i);
  if (m) {
    let rest = m[1].trim().replace(/^(\/[a-z]+\s+)+/i, ''); // /min /wait /b ...
    const tq = rest.match(/^"[^"]*"\s+(\S+)/);
    if (tq) return tq[1];
    const tok = rest.match(/^(\S+)/);
    if (tok && !/^"/.test(tok[1])) {
      const t = tok[1];
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // URL (https://…) → prohlížeč, bez dialogu; C:\ není URL
      if (/[\\/]/.test(t) || /\.(exe|bat|cmd|msi|com|scr|pif)$/i.test(t)) return t;
    }
  }
  m = c.match(/^\s*([^\s"']+\.exe)(?=\s|$)/i);
  if (m) return m[1];
  return null;
}
// Rozdělí složený příkaz na segmenty (…, & …, && …, || …, ;) — respektuje uvozovky.
// DŮVOD: dialog byl ve TŘETÍM segmentu (taskkill … & timeout … & start \) a kontrola
// viděla jen začátek příkazu. Odteď se kontroluje KAŽDÝ segment.
function splitSegments(cmd) {
  const segs = [];
  let cur = '', q = null;
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '&' || ch === ';' || ch === '|') {
      if ((ch === '&' || ch === '|') && s[i + 1] === ch) i++;
      segs.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs.map(x => x.trim()).filter(Boolean);
}
// Build příkazy — jejich výstupem může být exe, které v době kontroly ještě neexistuje
// (npm run dist & start dist\app.exe je legitimní ověřovací flow a nesmí se blokovat).
const BUILD_LIKE = /(npm\s+run\s+(dist|build)|electron-builder|msbuild|dotnet\s+(build|publish)|cargo\s+build|go\s+build|g\+\+?.*-o\b|pyinstaller|cmake\s+--build|gradlew?\s+.*(build|assemble)|ng\s+build|vite\s+build|next\s+build)/i;
// První chybějící GUI cíl v libovolném segmentu, nebo null když je vše OK.
// Vždy se blokuje: holé '\' a absolutní neexistující cesty. Relativní cíl projde jen
// když mu v řetězu předchází build (jinak je to překlep → dialog).
function findBadGuiTarget(cmd, cwd) {
  const segs = splitSegments(cmd);
  const builds = segs.some(s => BUILD_LIKE.test(s));
  for (const seg of segs) {
    if (!isGuiLaunch(seg)) continue;
    const gt = guiTarget(seg);
    if (!gt || guiTargetExists(gt, cwd)) continue;
    if (/^[\\/]+$/.test(gt)) return gt;
    if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(gt)) return gt;
    if (!builds) return gt;
  }
  return null;
}
function guiTargetExists(t, cwd) {
  try {
    // %TEMP%… / $env:… musíme expandovat — jinak existsSync vidí jen surový řetězec
    // a chybně hlásí "soubor neexistuje" u cesty, která reálně existuje.
    let x = String(t || '').replace(/^"|"$/g, '');
    try { x = expandEnvVars(x); } catch {}
    if (/^[\\/]+$/.test(x)) return false; // holé '\' nebo '/' — to byl ten systémový dialog
    if (/[\\/]/.test(x)) return fs.existsSync(x);
    const win = process.env.SystemRoot || 'C:\\Windows';
    const dirs = [cwd, path.join(win, 'System32'), path.join(win, 'SysWOW64'), win];
    return dirs.some(d => d && fs.existsSync(path.join(d, x)));
  } catch { return false; }
}
function runDetached(cmd, cwd) {
  return new Promise((resolve) => {
    try {
      const isWin = process.platform === 'win32';
      const { spawn } = require('child_process');
      const c = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/c', cmd] : ['-c', cmd], {
        cwd, detached: true, stdio: 'ignore', windowsHide: false
      });
      c.unref();
      resolve({ ok: true, output: 'Spuštěno na pozadí (okno aplikace zůstalo otevřené).\n[exit 0]' });
    } catch (e) {
      resolve({ ok: false, output: 'Error: ' + (e && e.message) });
    }
  });
}
function runCmd(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // windowsVerbatimArguments: uvozovky uvnitř příkazu se předají cmd v původní podobě
    // (bez toho rozbíjí filtry typu tasklist /FI "IMAGENAME eq X.exe").
    const child = execFile(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/c', cmd] : ['-c', cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer', ...(isWin ? { windowsVerbatimArguments: true } : {}) }, (err, stdout, stderr) => {
        let out = decodeConsole(stdout);
        const errS = decodeConsole(stderr);
        if (errS) out += (out ? '\n[stderr]\n' : '') + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + '\n… (output truncated)';
        if (err) {
          const code = typeof err.code === 'number' ? `exit ${err.code}` : String(err.code || 'error');
          resolve({ ok: false, output: `${out}\n[${code}${err.killed ? ', timeout' : ''}]`.trim() });
        } else {
          resolve({ ok: true, output: (out.trim() || '(no output)') + '\n[exit 0]' });
        }
      });
    void child;
  });
}
function decodeSmart(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ""));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { return decodeConsole(b); }
}
// Running without a shell (no quote parsing): for tar/7z, where cmd /s /c breaks quoted paths.
function runArgv(exe, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(exe, args || [],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        let out = decodeSmart(stdout);
        const errS = decodeSmart(stderr);
        if (errS) out += (out ? '\n[stderr]\n' : '') + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + '\n… (output truncated)';
        if (err) {
          const code = typeof err.code === 'number' ? `exit ${err.code}` : String(err.code || 'error');
          resolve({ ok: false, output: `${out}\n[${code}${err.killed ? ', timeout' : ''}]`.trim() });
        } else resolve({ ok: true, output: (out.trim() || '(no output)') + '\n[exit 0]' });
      });
    void child;
  });
}
/* Odhad, kterým shellem příkaz myslel. cmd.exe nebere `;` jako oddělovač příkazů,
   bere `&&`/`||`/`&` a `%VAR%`, `if exist`. PowerShell bere `;`, `$env:`, `$()`,
   `` ` ``, `if (…)`, `| Select-Object`. Bez toho se mixed příkaz spustí v cmd,
   `;` zůstane v argumentu a program dostane "bad option: -v;". */
const PS_ONLY = /(^|[^\\])\$env:|\$\(|\$_|^\s*powershell(\.exe)?\b|^\s*pwsh(\.exe)?\b|\bSelect-Object\b|\bWhere-Object\b|\bForEach-Object\b|\bWrite-Host\b|\bNew-Object\b|\bGet-ChildItem\b|\bGet-Content\b|\bSet-Location\b|\bTest-Path\b|\bRemove-Item\b|`|\bif\s*\(/i;
const CMD_ONLY = /\bif\s+exist\b|\bif\s+errorlevel\b|%[A-Za-z_][A-Za-z0-9_]*%|&&|\|\||\bdel\s+\/|\bdir\s+\/b\b|\btaskkill\s+\/|\bstart\s+""/i;
function preferredShellOrder(cmd) {
  const c = String(cmd || '');
  const ps = PS_ONLY.test(c);
  const cm = CMD_ONLY.test(c);
  if (ps && !cm) return ['powershell', 'pwsh', 'cmd'];
  if (cm && !ps) return ['cmd', 'powershell', 'pwsh'];
  return ['cmd', 'powershell', 'pwsh'];
}

function runCmdKind(kind, cmd, cwd, timeoutMs, cancelKey) {
  return new Promise((resolve) => {
    const lite = kind === "powershell" || kind === "pwsh";
    const c2 = normalizeShell(cmd, lite);
    // Okenní appka se spouští odpojeně — jinak čekání visí, dokud okno nezavřeš.
    // Neexistující cíl = čistá chyba, nikdy SYSTÉMOVÝ dialog.
    if (kind === 'cmd' && isGuiLaunch(c2)) {
      const gt2 = guiTarget(c2);
      if (gt2 && !guiTargetExists(gt2, cwd)) { resolve({ ok: false, output: 'Error: file does not exist, not launching (no system dialog): ' + gt2, launched: true, incompatible: false }); return; }
      runDetached(c2, cwd).then(r => resolve(Object.assign(r, { launched: true, incompatible: false }))); return;
    }
    const spec = kind === "powershell"
      ? { exe: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", c2] }
      : kind === "pwsh"
        ? { exe: "pwsh.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", c2] }
        : { exe: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: process.platform === "win32" ? ["/d", "/c", c2] : ["-c", c2] };
    const child = execFile(spec.exe, spec.args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "buffer", ...(process.platform === "win32" && kind === "cmd" ? { windowsVerbatimArguments: true } : {}) }, (err, stdout, stderr) => {
        try { if (cid) activeProcs.delete(cid); } catch {}
        if (err && (err.code === "ENOENT" || /not found/i.test(err.message || ""))) { resolve({ ok: false, output: "", launched: false }); return; }
        let out = decodeSmart(stdout);
        const errS = decodeSmart(stderr);
        if (errS) out += (out ? "\n[stderr]\n" : "") + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + "\n… (output truncated)";
        const incompatible = kind === "cmd"
          ? /is not recognized as an internal or external command|nen\u00ed rozpozn\u00e1n|neni rozpoznan/i.test(out)
          : /is not recognized as the name of a cmdlet|nen\u00ed rozpozn\u00e1n|neni rozpoznan/i.test(out);
        if (err && err.killed) { resolve({ ok: false, output: (out + "\n[timeout]").trim(), launched: true, incompatible: false }); return; }
        if (err && typeof err.code === "number") { resolve({ ok: false, output: (out + "\n[exit " + err.code + "]").trim(), launched: true, incompatible }); return; }
        if (err) { resolve({ ok: false, output: (out + "\n[" + String(err.code || "error") + "]").trim(), launched: true, incompatible }); return; }
        resolve({ ok: true, output: (out.trim() || "(no output)") + "\n[exit 0]", launched: true, incompatible });
      });
    // Stop tlacitko: bezici prikaz musi jit zabit (viz cancelToolsFor).
    // PID se pamatuje i pro pristi build (sirotci po Stopu uprostred buildu).
    let cid = null;
    try {
      if (child && child.pid) {
        cid = 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        activeProcs.set(cid, { child, pid: child.pid, key: String(cancelKey || cwd || '') });
        rememberPid(cancelKey || cwd, child.pid);
      }
    } catch {}
    void child;
  });
}
// Always forbidden (breaks the PC). Only the command name (first token) is checked,
// so it does not block innocent things like "npm run format".
function firstToken(cmd) {
  const m = String(cmd || '').trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  return ((m && (m[1] || m[2] || m[3])) || '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}
const ALWAYS_BLOCKED_NAMES = new Set(['format', 'diskpart', 'bcdedit', 'bootrec', 'diskshadow', 'mkfs', 'dd']);
const ALWAYS_BLOCKED_RE = /:\(\)\s*\{/;
function isAlwaysBlocked(cmd) {
  if (ALWAYS_BLOCKED_RE.test(String(cmd))) return true;
  return ALWAYS_BLOCKED_NAMES.has(firstToken(cmd));
}
// ============================================================================
// Je obsah useknutý? (stream/model skončil dřív, než se dopsal soubor)
//
// Stará verze počítala závorky přes celý text naslepo — a hlásila useknutí i na
// HOTOVÝCH souborech: HTML končící </html> (poslední "class" bez ; nebo {),
// apostrofy a komentáře v JS. AI pak přepisovala celé soubory nanovo a Error Log
// se plnil jejich obsahem (errors-2026-10-01.txt — 5x falešný poplach).
//
// Teď: kontrola podle typu souboru, komentáře/řetězce/regex se PŘESKAKUJÍ
// a hlásí se jen vysoce jisté signály, které skoro vždy znamenají useknutí na
// konci obsahu. Co se neví jistě, se NEHLÁSÍ — lepší propuštěný usekl než
// odmítnutý hotový soubor.
// ============================================================================
function fileExtOf(f) {
  try { return path.extname(String(f || '')).toLowerCase(); } catch { return ''; }
}
// Konec řetězce: index za uzavírací uvozovkou, -1 = narazilo na nový řádek
// (bývá to apostrof v textu, ne řetězec — nechceme falešný poplach),
// -2 = konec obsahu uvnitř řetězce (to je jisté useknutí).
function strEnd(t, i, ch, multi) {
  const n = t.length;
  let j = i + 1;
  while (j < n) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ch) return j + 1;
    if (!multi && c === '\n') return -1;
    j++;
  }
  return -2;
}
// Může tady začínat regulární výraz? (jinak je to dělení)
function regexAllowed(sig, word) {
  if (!sig) return true;
  if ('(,=:[!&|?{};+-*%~^<>'.indexOf(sig) >= 0) return true;
  return /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/.test(word);
}
// Konec regulárního výrazu (nebo -1, když to výraz není).
function regexEnd(t, i) {
  const n = t.length;
  let j = i + 1, inCls = false;
  while (j < n) {
    const c = t[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return -1;
    if (inCls) { if (c === ']') inCls = false; }
    else if (c === '[') inCls = true;
    else if (c === '/') { j++; while (j < n && /[a-z]/i.test(t[j])) j++; return j; }
    j++;
  }
  return -1;
}
// V CSS/SCSS je "// komentář" jen na začátku řádku nebo po ; { } , —
// jinak by "url(//cdn…) " shodilo závorky a vznikl by falešný poplach.
function styleLineComment(t, i) {
  const ls = t.lastIndexOf('\n', i - 1) + 1;
  const prefix = t.slice(ls, i).replace(/\s+$/, '');
  return prefix === '' || /[;{},]$/.test(prefix);
}
// Skenování kódu: přeskakuje komentáře, řetězce, šablony a regexy,
// počítá jen závorky mimo ně. mode: 'js' | 'style' | 'hash' | 'json'.
// Vrací důvod (prázdný řetězec = obsah vypadá kompletně).
function scanCode(t, mode) {
  const n = t.length;
  const out = t.split('');                      // kopie pro maskování (pro pátý krok)
  const mask = (a, b) => { for (let k = Math.max(0, a); k < b && k < n; k++) if (t[k] !== '\n') out[k] = ' '; };
  const opens = { '{': 0, '[': 0, '(': 0 };
  const pairs = { '}': '{', ']': '[', ')': '(' };
  let i = 0, prevSig = '', prevWord = '';
  const lineComment = (a) => {
    const e = t.indexOf('\n', a);
    const end = e < 0 ? n : e;
    mask(a, end);
    return end;
  };
  while (i < n) {
    const c = t[i], c2 = t[i + 1];
    // ---- komentáře ----
    if (c === '/' && c2 === '*') {
      const e = t.indexOf('*/', i + 2);
      if (e < 0) return 'neuzavřený komentář /*';
      mask(i, e + 2); i = e + 2; prevSig = ')'; prevWord = ''; continue;
    }
    if (c === '/' && c2 === '/' && (mode === 'js' || mode === 'json' || (mode === 'style' && styleLineComment(t, i)))) {
      i = lineComment(i); continue;
    }
    if (mode === 'hash' && c === '#') { i = lineComment(i); continue; }
    // ---- řetězce ----
    if (c === '"' || c === "'") {
      // Python: trojité uvozovky = docstring (může být přes víc řádků)
      if (mode === 'hash' && (t.startsWith('"""', i) || t.startsWith("'''", i))) {
        const q3 = t.substr(i, 3);
        const e = t.indexOf(q3, i + 3);
        if (e < 0) return 'neuzavřený docstring';
        mask(i, e + 3); i = e + 3; prevSig = ')'; prevWord = ''; continue;
      }
      const e = strEnd(t, i, c, false);
      if (e === -2) return 'neukončený řetězec';
      if (e === -1) { i++; prevSig = c; prevWord = ''; continue; }  // není to řetězec
      mask(i, e); i = e; prevSig = ')'; prevWord = ''; continue;
    }
    // ---- šablona `…${…}…` ----
    if (mode === 'js' && c === '`') {
      const e = strEnd(t, i, '`', true);
      if (e === -2) return 'neukončená šablona `';
      mask(i, e); i = e; prevSig = ')'; prevWord = ''; continue;
    }
    // ---- regulární výraz vs. dělení ----
    if (mode === 'js' && c === '/' && regexAllowed(prevSig, prevWord)) {
      const r = regexEnd(t, i);
      if (r > 0) { mask(i, r); i = r; prevSig = ')'; prevWord = ''; continue; }
    }
    // ---- závorky (jen mimo řetězce/komentáře) ----
    if (opens[c] !== undefined) { opens[c]++; prevSig = c; prevWord = ''; i++; continue; }
    if (pairs[c]) { opens[pairs[c]]--; prevSig = c; prevWord = ''; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z0-9_$À-ž]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$À-ž]/.test(t[j])) j++;
      prevWord = t.slice(i, j); prevSig = t[j - 1]; i = j; continue;
    }
    prevSig = c; prevWord = ''; i++;
  }
  for (const k of Object.keys(opens)) if (opens[k] > 0) return 'nezavřená ' + k + ' (' + opens[k] + ')';
  // Poslední slovo příkazu bez "{" a ";" — začátek bloku, který se nedopsal.
  // Testuje se na maskovaném textu, aby řetězce a komentáře nevadily.
  if (mode !== 'json' && /\b(function|class|if|for|while|switch|try)\b[^{;]*$/.test(out.join('').replace(/\s+$/, ''))) {
    return 'useknutá na nedokončeném bloku';
  }
  return '';
}
// HTML/XML: neuzavřený komentář, neuzavřený <script>/<style>,
// obsah končící uprostřed značky a useknutý skript uvnitř.
function scanHtml(t) {
  const lo = t.toLowerCase();
  // 1) neuzavřený HTML komentář = jisté useknutí
  for (let p = t.indexOf('<!--'); p >= 0; p = t.indexOf('<!--', p + 4)) {
    if (t.indexOf('-->', p + 4) < 0) return 'neuzavřený komentář <!--';
  }
  // 2) poslední <script>/<style> musí být uzavřený
  for (const tag of ['script', 'style']) {
    const open = lo.lastIndexOf('<' + tag);
    if (open >= 0 && lo.indexOf('</' + tag + '>', open) < 0) return 'neuzavřený <' + tag + '> blok';
  }
  // 3) obsah končí uprostřed značky? ("<circle …" bez uzavíracího ">")
  const tail = t.replace(/\s+$/, '');
  if (tail && !tail.endsWith('>') && tail.lastIndexOf('<') > tail.lastIndexOf('>')) {
    return 'useknutá HTML značka (obsah končí uprostřed <…)';
  }
  // 4) obsah posledního <script>/<style> zkontrolujeme jako kód
  for (const [tag, mode] of [['script', 'js'], ['style', 'style']]) {
    const open = lo.lastIndexOf('<' + tag);
    if (open < 0) continue;
    const gt = lo.indexOf('>', open);
    const close = lo.indexOf('</' + tag + '>', open);
    if (gt >= 0 && close > gt) {
      const r = scanCode(t.slice(gt + 1, close), mode);
      if (r) return 'v <' + tag + '>: ' + r;
    }
  }
  return '';
}
// Je tenhle obsah useknutý? file = cílový soubor (kvůli příponě).
function truncatedCodeReason(s, file) {
  const t = String(s || '');
  if (!t.trim()) return 'prázdný obsah';
  const ext = fileExtOf(file);
  const head = t.slice(0, 600);
  if (/^\.(html?|xhtml|xml|svg|vue|svelte)$/.test(ext)
    || /^\s*(<!doctype\s+html|<\?xml|<svg[\s>]|<html[\s>])/i.test(head)) return scanHtml(t);
  // Textové soubory, kde závorky nic neznamenají — žádná kontrola
  // (dřív to dělalo falešné poplachy třeba u README.md).
  if (/^\.(md|markdown|txt|text|log|csv|tsv|yml|yaml|ini|cfg|conf|rst|adoc|lock|gitignore)$/.test(ext)) return '';
  if (/^\.(json|jsonc)$/.test(ext)) return scanCode(t, 'json');
  if (/^\.(css|scss|less|sass)$/.test(ext)) return scanCode(t, 'style');
  if (/^\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|java|c|h|cpp|hpp|cc|cs|go)$/.test(ext)) return scanCode(t, 'js');
  if (/^\.(py|rb|sh|bash|zsh|ps1|pl)$/.test(ext)) return scanCode(t, 'hash');
  // Neznámý typ: radši nic nehlásit (falešný poplach = odmítnutí hotového
  // souboru). Rozpoznáme jen JSON podle obsahu.
  const trimmed = t.replace(/^\s+/, '');
  if (trimmed[0] === '{' || trimmed[0] === '[') return scanCode(t, 'json');
  return '';
}
// Příkazy, které reálně potřebují administrátora. Ty jdou do elevovaného helperu.
function needsElevation(cmd) {
  const c = String(cmd || '').toLowerCase();
  return /(^|[&|]\s*)(reg\s+(add|delete|import)|sc\s+(create|delete|config|start|stop|query)|net\s+(user|localgroup|stop|start)|schtasks|takeown|icacls|cacls|bcdedit|bootrec|diskpart|net stop|net start|wevtutil|manage-bde|takeown)/.test(c)
    || /\bc:\\(windows|program files|program files \(x86\))/i.test(String(cmd || ''))
    || /\bschtasks\b|\bsc\s+(?:create|config|start|stop)\b|\breg(?:edit|\.exe)?\s+(?:add|delete)\b/.test(c);
}
// Žádný blacklist příkazů — plný přístup, bez omezení.
function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('windows-1250').decode(buf); } catch { return buf.toString('utf-8'); }
  }
}
// ASYNCHRONNÍ — na síťovém disku (Z: WebDAV) trvá readdir stovky ms až sekundy.
// Synchronní verze blokovala hlavní proces a Windows ukázal "neodpovídá".
async function globWalk(root, pattern, fullAccess) {
  const pat = String(pattern || '**').replace(/\\/g, '/');
  const segs = pat.split('/').filter(s => s.length);
  const out = [];
  const rxCache = new Map();
  const segRx = (s) => {
    if (!rxCache.has(s)) {
      const rx = '^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      rxCache.set(s, new RegExp(rx, 'i'));
    }
    return rxCache.get(s);
  };
  const walk = async (dir, si, rel) => {
    if (out.length >= 200) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const last = si === segs.length - 1;
    for (const e of entries) {
      if (out.length >= 200) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rp = rel ? rel + '/' + e.name : e.name;
      try {
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          if (segs[si] === '**') {
            await walk(full, si, rp); // ** eats arbitrarily deep
            if (si + 1 < segs.length) await walk(full, si + 1, rp);
            else out.push(rp + '/');
          } else if (segRx(segs[si]).test(e.name)) {
            if (last) out.push(rp + '/');
            else await walk(full, si + 1, rp);
          }
        } else if (e.isFile()) {
          const seg = segs[si];
          let hit = false;
          if (seg === '**') {
            // ** alone takes everything; **/x matches the next segment too (even at the root)
            if (si === segs.length - 1) hit = true;
            else if (si + 1 === segs.length - 1 && segRx(segs[si + 1]).test(e.name)) hit = true;
          } else if (last && segRx(seg).test(e.name)) hit = true;
          if (hit) {
            const abs = path.resolve(full);
            const r = path.resolve(root);
            if (!fullAccess && abs !== r && !abs.startsWith(r + path.sep)) continue;
            out.push(rp);
          }
        }
      } catch {}
    }
    // "**/x": also search nested directories with the same pattern
    if (segs[si] !== '**') {
      for (const e of entries) {
        if (out.length >= 200) return;
        try {
          if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
            await walk(path.join(dir, e.name), si, rel ? rel + '/' + e.name : e.name);
          }
        } catch {}
      }
    }
  };
  await walk(root, 0, '');
  return [...new Set(out)].slice(0, 200);
}
function fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(String(url));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(String(url), { headers: { 'User-Agent': 'NolimitCoder/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve({ ok: false, output: `HTTP ${res.statusCode}` });
      }
      let data = '';
      res.on('data', c => { if (data.length < 60000) data += c; });
      res.on('end', () => {
        const txt = data.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        resolve({ ok: true, output: txt.slice(0, 15000) || '(empty page)' });
      });
    });
    req.on('error', e => resolve({ ok: false, output: 'Error: ' + e.message }));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); resolve({ ok: false, output: 'Timeout' }); });
  });
}

// Portable tools (when winget fails): download from the web into userData/tools and add to PATH,
// so the shell finds them right away — no admin rights needed.
async function toolsBinDirs(userDataDir) {
  const out = [];
  if (!userDataDir) return out;
  const base = path.join(String(userDataDir), 'tools');
  const regFile = path.join(base, '.bins.json');
  try {
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
    for (const id of Object.keys(reg || {})) for (const d of reg[id] || []) if (fs.existsSync(d)) out.push(d);
  } catch {}
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (/^node-v\d/i.test(e.name) && fs.existsSync(path.join(full, 'node.exe'))) { out.push(full); continue; }
          if (fs.existsSync(path.join(full, 'cmd', 'git.exe'))) { out.push(path.join(full, 'cmd')); continue; }
          if (fs.existsSync(path.join(full, 'git.exe'))) { out.push(full); continue; }
          if (/^python-/i.test(e.name) && fs.existsSync(path.join(full, 'python.exe'))) { out.push(full); continue; }
          await walk(full, depth + 1);
        }
      } catch {}
    }
  };
  try { if (fs.existsSync(base)) walk(base, 0); } catch {}
  return [...new Set(out)];
}
function rememberToolDir(userDataDir, id, dir) {
  try {
    if (!userDataDir || !dir) return;
    const base = path.join(String(userDataDir), 'tools');
    fs.mkdirSync(base, { recursive: true });
    const regFile = path.join(base, '.bins.json');
    let reg = {};
    try { reg = JSON.parse(fs.readFileSync(regFile, 'utf-8')); } catch {}
    if (!Array.isArray(reg[id])) reg[id] = [];
    if (!reg[id].some(d => String(d).toLowerCase() === String(dir).toLowerCase())) reg[id].push(dir);
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2), 'utf-8');
  } catch {}
}
async function prependPortableBins(userDataDir) {
  try {
    const sep = path.delimiter;
    const cur = String(process.env.PATH || '').split(sep);
    for (const d of await toolsBinDirs(userDataDir)) {
      if (!cur.some(p => p.toLowerCase() === d.toLowerCase())) cur.unshift(d);
    }
    process.env.PATH = cur.join(sep);
  } catch {}
}
// Download/install progress for the download widget in the UI (bottom left).
// main.js registers a hook that forwards events to the renderer.
let progressHook = null;
function setProgressHook(fn) { progressHook = (typeof fn === 'function') ? fn : null; }
function dlEvent(ev) { try { if (progressHook) progressHook(Object.assign({ t: Date.now() }, ev)); } catch {} }
// Current label of the download (set by installTool so downloadFile knows what it is).
let dlContext = '';
// Registry of running downloads for cancellation from the UI (Stop / Cancel all).
const dlControllers = new Map(); // id(dest) -> { cancelled, reqs:Set }
function cancelDownload(id) {
  const ids = id ? [String(id)] : [...dlControllers.keys()];
  let hit = false;
  for (const k of ids) {
    const c = dlControllers.get(k);
    if (!c) continue;
    hit = true;
    c.cancelled = true;
    for (const r of c.reqs || []) { try { r.destroy(new Error('Cancelled by user')); } catch {} }
  }
  return hit;
}
// HEAD: size + Range support (for segmented downloads). Returns {url,size,ranges} or null.
function headInfo(url, timeoutMs) {
  return new Promise((resolve) => {
    let over = false;
    const fin = (v) => { if (!over) { over = true; resolve(v); } };
    const go = (u, left) => {
      const mod = String(u).startsWith('https:') ? https : http;
      const req = mod.request(String(u), { method: 'HEAD', headers: { 'User-Agent': 'NolimitCoder/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), left - 1);
        }
        res.resume();
        if (res.statusCode !== 200) return fin(null);
        const len = parseInt(res.headers['content-length'] || '', 10);
        fin({ url: String(u), size: isNaN(len) ? 0 : len, ranges: /bytes/i.test(String(res.headers['accept-ranges'] || '')) });
      });
      req.on('error', () => fin(null));
      req.setTimeout(timeoutMs || 15000, () => { try { req.destroy(); } catch {} fin(null); });
      try { req.end(); } catch { fin(null); }
    };
    go(url, 4);
  });
}
const DL_SEGS = 6; // parallel streams for large files
const DL_SEG_MIN = 8 * 1048576; // segment only files > 8 MB
function downloadFile(url, dest, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let restarting = false;
    let tries = 0;
    let stage = 'seg';
    const id = String(dest);
    const label = dlContext || path.basename(String(dest));
    const ctrl = { cancelled: false, reqs: new Set() };
    dlControllers.set(id, ctrl);
    let lastPct = -2;
    let lastEmit = 0;
    const prog = (received, total) => {
      const pct = total > 0 ? Math.floor(received * 100 / total) : -1;
      const now = Date.now();
      if (pct !== lastPct || now - lastEmit > 500) {
        lastPct = pct; lastEmit = now;
        dlEvent({ kind: 'dl', id, label, phase: 'download', percent: pct, received, total: total || 0 });
      }
    };
    const cleanupParts = () => {
      for (let i = 0; i < DL_SEGS; i++) { try { fs.rmSync(id + '.part' + i, { force: true }); } catch {} }
    };
    const finishOk = (size, total) => {
      if (done) return;
      done = true;
      dlControllers.delete(id);
      dlEvent({ kind: 'dl', id, label, phase: 'download', percent: 100, received: size, total: total || size });
      resolve({ ok: true, size });
    };
    const fail = (msg) => {
      if (done || restarting) return;
      for (const r of [...ctrl.reqs]) { try { r.destroy(); } catch {} }
      ctrl.reqs.clear();
      cleanupParts();
      if (ctrl.cancelled) {
        done = true;
        dlControllers.delete(id);
        cleanupParts();
        try { fs.rmSync(dest, { force: true }); } catch {}
        dlEvent({ kind: 'dl', id, label, phase: 'error', percent: -1, error: 'Cancelled by user' });
        return resolve({ ok: false, error: 'Cancelled by user' });
      }
      if (stage === 'seg') { stage = 'single'; restarting = true; cleanupParts(); single(); return; }
      if (tries < 1) { tries++; restarting = true; single(); return; }
      done = true;
      dlControllers.delete(id);
      cleanupParts();
      try { fs.rmSync(dest, { force: true }); } catch {}
      dlEvent({ kind: 'dl', id, label, phase: 'error', percent: -1, error: msg });
      resolve({ ok: false, error: msg });
    };
    // ---- single stream (also fallback) ----
    const single = () => {
      restarting = false;
      const go = (u, left, expected) => {
        if (done || ctrl.cancelled) return fail('Cancelled by user');
        const mod = String(u).startsWith('https:') ? https : http;
        const req = mod.get(String(u), { headers: { 'User-Agent': 'NolimitCoder/2.0' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
            res.resume();
            const len = parseInt(res.headers['content-length'] || '', 10);
            return go(new URL(res.headers.location, u).toString(), left - 1, isNaN(len) ? expected : len);
          }
          if (res.statusCode !== 200) { res.resume(); return fail('HTTP ' + res.statusCode); }
          const len = parseInt(res.headers['content-length'] || '', 10);
          if (!isNaN(len)) expected = len;
          const ws = fs.createWriteStream(dest);
          let received = 0;
          prog(0, expected || 0);
          res.on('data', c => { received += c.length; prog(received, expected || 0); });
          res.on('aborted', () => fail(ctrl.cancelled ? 'Cancelled by user' : 'Connection interrupted in the middle of the download'));
          res.pipe(ws);
          ws.on('finish', () => ws.close(() => {
            if (done) return;
            let size = 0;
            try { size = fs.statSync(dest).size; } catch {}
            if (!size) return fail('Downloaded 0 B');
            if (expected && size < expected) return fail(`Incomplete download (${(size / 1048576).toFixed(1)} of ${(expected / 1048576).toFixed(1)} MB)`);
            finishOk(size, expected);
          }));
          ws.on('error', e => fail(e.message));
        });
        ctrl.reqs.add(req);
        const unreg = () => ctrl.reqs.delete(req);
        req.on('error', e => { unreg(); fail((e && e.message) || 'Network error'); });
        req.on('close', unreg);
        req.setTimeout(timeoutMs || 120000, () => { try { req.destroy(new Error(ctrl.cancelled ? 'Cancelled by user' : 'Download timeout')); } catch {} });
      };
      go(url, 4, 0);
    };
    // ---- one segment of the parallel download ----
    const segDownload = (u, start, end, partFile, shared) => new Promise((res, rej) => {
      const go = (uu, left) => {
        if (done || ctrl.cancelled) return rej(new Error('Cancelled by user'));
        const mod = String(uu).startsWith('https:') ? https : http;
        const req = mod.get(String(uu), { headers: { 'User-Agent': 'NolimitCoder/2.0', Range: `bytes=${start}-${end}` } }, (rs) => {
          if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && left > 0) {
            rs.resume();
            return go(new URL(rs.headers.location, uu).toString(), left - 1);
          }
          if (rs.statusCode !== 206) { rs.resume(); return rej(new Error(rs.statusCode === 200 ? 'no-range' : 'HTTP ' + rs.statusCode)); }
          const ws = fs.createWriteStream(partFile);
          rs.on('data', c => { shared.received += c.length; prog(shared.received, shared.total); });
          rs.on('aborted', () => rej(new Error('Connection interrupted')));
          rs.pipe(ws);
          ws.on('finish', () => ws.close(() => res(true)));
          ws.on('error', e => rej(e));
        });
        ctrl.reqs.add(req);
        const unreg = () => ctrl.reqs.delete(req);
        req.on('error', e => { unreg(); rej(e); });
        req.on('close', unreg);
        req.setTimeout(timeoutMs || 300000, () => { try { req.destroy(new Error(ctrl.cancelled ? 'Cancelled by user' : 'Download timeout')); } catch {} });
      };
      go(u, 4);
    });
    // ---- parallel download + assembly ----
    const startSeg = (finalUrl, size) => {
      restarting = false;
      const N = DL_SEGS;
      const part = Math.ceil(size / N);
      const shared = { received: 0, total: size };
      prog(0, size);
      const jobs = [];
      for (let i = 0; i < N; i++) {
        const a = i * part, b = Math.min(size - 1, (i + 1) * part - 1);
        if (a > b) break;
        jobs.push(segDownload(finalUrl, a, b, id + '.part' + i, shared));
      }
      Promise.all(jobs).then(async () => {
        if (done || ctrl.cancelled) return fail('Cancelled by user');
        try {
          const ws = fs.createWriteStream(dest);
          for (let i = 0; i < jobs.length; i++) {
            if (done || ctrl.cancelled) { try { ws.destroy(); } catch {} return fail('Cancelled by user'); }
            await new Promise((res2, rej2) => {
              const rs = fs.createReadStream(id + '.part' + i);
              rs.on('error', rej2);
              rs.pipe(ws, { end: false });
              rs.on('end', res2);
            });
          }
          ws.end();
          await new Promise((res2) => ws.on('close', res2));
          cleanupParts();
          let sz = 0;
          try { sz = fs.statSync(dest).size; } catch {}
          if (!sz) return fail('Downloaded 0 B');
          if (sz < size) return fail(`Incomplete download (${(sz / 1048576).toFixed(1)} of ${(size / 1048576).toFixed(1)} MB)`);
          finishOk(sz, size);
        } catch (e) { fail((e && e.message) || 'Assembly error'); }
      }).catch((e) => {
        if (done || restarting) return;
        if (ctrl.cancelled) return fail('Cancelled by user');
        if (String((e && e.message) || e) === 'no-range') { stage = 'single'; restarting = true; cleanupParts(); return single(); }
        fail((e && e.message) || 'Download error');
      });
    };
    // ---- start: try segments first, otherwise a single stream ----
    (async () => {
      try {
        const info = await headInfo(url, 20000);
        if (done || ctrl.cancelled) return fail('Cancelled by user');
        if (info && info.size > DL_SEG_MIN && info.ranges) { stage = 'seg'; return startSeg(info.url, info.size); }
      } catch {}
      stage = 'single';
      single();
    })();
  });
}
function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const go = (u, left) => {
      const mod = String(u).startsWith('https:') ? https : http;
      const req = mod.get(String(u), { headers: { 'User-Agent': 'NolimitCoder/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), left - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', c => { if (data.length < 2000000) data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs || 20000, () => { req.destroy(); resolve(null); });
    };
    go(url, 4);
  });
}
async function installPortableNode(userDataDir) {
  if (!userDataDir) throw new Error('Missing userData');
  dlContext = 'Node.js';
  const toolsDir = path.join(String(userDataDir), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  // find the latest LTS version (no hardcoding)
  const index = await fetchJson('https://nodejs.org/dist/index.json', 20000);
  const lts = Array.isArray(index) ? index.find(v => v && v.lts) : null;
  const ver = (lts && lts.version) || 'v22.14.0';
  const existing = path.join(toolsDir, `node-${ver}-win-x64`, 'node.exe');
  if (fs.existsSync(existing)) {
    await prependPortableBins(userDataDir);
    return { ok: true, output: `Node.js ${ver} is already downloaded in ${path.dirname(existing)} and is in PATH.` };
  }
  const zipUrl = `https://nodejs.org/dist/${ver}/node-${ver}-win-x64.zip`;
  const zipDest = path.join(toolsDir, `node-${ver}-win-x64.zip`);
  const dl = await downloadFile(zipUrl, zipDest, 300000);
  if (!dl.ok) {
    try { fs.rmSync(zipDest, { force: true }); } catch {}
    throw new Error(`Download failed (${dl.error}). Manual: https://nodejs.org/`);
  }
  const ps = await runCmd(`powershell -NoProfile -Command "Expand-Archive -Force '${zipDest}' '${toolsDir}'"`, toolsDir, 300000);
  try { fs.rmSync(zipDest, { force: true }); } catch {}
  if (!fs.existsSync(existing)) throw new Error(`Extraction failed (${ps.output.slice(-300)}). Manual: https://nodejs.org/`);
  await prependPortableBins(userDataDir);
  return { ok: true, output: `Node.js ${ver} downloaded from the internet to ${path.dirname(existing)} and added to PATH.` };
}
// Portable Git (MinGit) — when winget fails: find the latest version via the GitHub API,
// download MinGit-*-64-bit.zip into userData/tools and add cmd/ to PATH. No admin needed.
async function installPortableGit(userDataDir) {
  if (!userDataDir) throw new Error('Missing userData');
  dlContext = 'Git';
  const toolsDir = path.join(String(userDataDir), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const already = (await toolsBinDirs(userDataDir)).some(() => true);
  if (already) {
    const probe = await new Promise((resolve) => {
      execFile('git', ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
        resolve(!err && /git version/i.test(String(stdout || '')));
      });
    });
    if (probe) return { ok: true, output: 'Git is already available in PATH.' };
  }
  const rel = await fetchJson('https://api.github.com/repos/git-for-windows/git/releases/latest', 20000);
  const assets = (rel && rel.assets) || [];
  const mg = assets.find(a => /MinGit-.*-64-bit\.zip$/i.test(a.name || '')) || assets.find(a => /MinGit.*64.*\.zip$/i.test(a.name || ''));
  if (!mg || !mg.browser_download_url) throw new Error('Could not find MinGit to download. Manual: https://git-scm.com/downloads');
  const destDir = path.join(toolsDir, 'mingit');
  const zipDest = path.join(toolsDir, 'mingit.zip');
  const dl = await downloadFile(mg.browser_download_url, zipDest, 300000);
  if (!dl.ok) {
    try { fs.rmSync(zipDest, { force: true }); } catch {}
    throw new Error(`Download failed (${dl.error}). Manual: https://git-scm.com/downloads`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  await runCmd(`powershell -NoProfile -Command "Expand-Archive -Force '${zipDest}' '${destDir}'"`, toolsDir, 300000);
  try { fs.rmSync(zipDest, { force: true }); } catch {}
  const gitExe = path.join(destDir, 'cmd', 'git.exe');
  if (!fs.existsSync(gitExe)) throw new Error('Extraction failed. Manual: https://git-scm.com/downloads');
  await prependPortableBins(userDataDir);
  return { ok: true, output: `Git (${mg.name}) downloaded from the internet to ${destDir} and added to PATH.` };
}

// ===== ENVIRONMENT DETECTION: what is already on the PC (including outside PATH) =====
const ENV_TTL = 15000;
const envState = { tools: null, at: 0, packages: null, pkgAt: 0, dirs: [], dirsAt: 0 };

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)); }
  catch { return []; }
}
function pfDir() { return process.env.ProgramFiles || 'C:\\Program Files'; }
function pf86Dir() { return process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'; }

function knownBinDirs() {
  if (envState.dirs.length && Date.now() - envState.dirsAt < 30000) return envState.dirs;
  const H = os.homedir();
  const out = [
    path.join(pfDir(), 'nodejs'),
    path.join(H, 'AppData', 'Local', 'Programs', 'Python'),
    path.join(pfDir(), 'Git', 'cmd'), path.join(pfDir(), 'Git', 'bin'), path.join(pf86Dir(), 'Git', 'cmd'),
    path.join(pfDir(), 'Go', 'bin'), 'C:\\Go\\bin',
    path.join(pfDir(), 'dotnet'), path.join(H, '.dotnet'),
    path.join(pfDir(), 'Eclipse Adoptium'), path.join(pfDir(), 'Java'), path.join(pfDir(), 'Microsoft'),
    path.join(H, '.cargo', 'bin'), path.join(H, '.rustup', 'toolchains'),
    path.join(pfDir(), 'CMake', 'bin'), path.join(pfDir(), '7-Zip'),
    path.join(pfDir(), 'WinLibs', 'mingw64', 'bin'), path.join(pf86Dir(), 'WinLibs', 'mingw64', 'bin'),
    path.join(pf86Dir(), 'GnuWin32', 'bin'), 'C:\\mingw64\\bin',
    'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', 'C:\\msys64\\usr\\bin',
    path.join(pfDir(), 'LLVM', 'bin'), 'C:\\LLVM\\bin',
    path.join(pfDir(), 'Bun'), path.join(H, '.bun', 'bin'), path.join(H, '.deno', 'bin'),
    path.join(H, 'scoop', 'shims'), path.join(pfDir(), 'Strawberry', 'c', 'bin'), 'C:\\Strawberry\\c\\bin',
    path.join(H, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'), path.join(pfDir(), 'WinGet', 'Links'),
    path.join(pfDir(), 'Apache', 'maven'), path.join(pfDir(), 'Gradle')
  ];
  const pyRoot = path.join(H, 'AppData', 'Local', 'Programs', 'Python');
  for (const d of listDirs(pyRoot)) { out.push(d, path.join(d, 'Scripts')); }
  for (const d of listDirs(path.join(pfDir(), 'Eclipse Adoptium'))) out.push(path.join(d, 'bin'));
  for (const d of listDirs(path.join(pfDir(), 'Java'))) out.push(path.join(d, 'bin'));
  for (const d of listDirs(path.join(pfDir(), 'Microsoft'))) {
    if (/^(jdk|openjdk|temurin|microsoft-jdk)/i.test(path.basename(d))) out.push(path.join(d, 'bin'));
  }
  for (const d of listDirs(path.join(H, '.rustup', 'toolchains'))) out.push(path.join(d, 'bin'));
  for (const d of listDirs(path.join(H, 'sdk'))) if (/^go\d/i.test(path.basename(d))) out.push(path.join(d, 'bin'));
  for (const d of listDirs(path.join(H, 'scoop', 'apps'))) { out.push(path.join(d, 'shims'), path.join(d, 'current', 'bin')); }
  for (const d of listDirs(path.join(H, 'AppData', 'Roaming', 'nvm'))) out.push(d);
  envState.dirs = [...new Set(out.filter(d => { try { return fs.existsSync(d); } catch { return false; } }))];
  envState.dirsAt = Date.now();
  return envState.dirs;
}

function whereBin(bin) {
  return new Promise((resolve) => {
    const names = /\.(exe|cmd|bat|com)$/i.test(bin) ? [bin] : [bin + '.exe', bin + '.cmd', bin + '.bat'];
    execFile('where.exe', [names[0]], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (first) { try { if (fs.existsSync(first)) return resolve({ ok: true, path: first, source: 'PATH' }); } catch {} }
      }
      for (const dir of knownBinDirs()) {
        for (const n of names) {
          const p = path.join(dir, n);
          try { if (fs.existsSync(p)) return resolve({ ok: true, path: p, source: 'FOUND' }); } catch {}
        }
      }
      resolve({ ok: false });
    });
  });
}

function probeVersion(exePath, args) {
  return new Promise((resolve) => {
    execFile(exePath, args || [], { timeout: 12000, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const out = (String(stdout || '') + ' ' + String(stderr || '')).trim();
      resolve((out.split('\n').find(l => l.trim()) || (err ? '' : 'ok')).trim().slice(0, 90));
    });
  });
}

function findVcvarsFromCl(clPath) {
  try {
    const p = path.resolve(path.dirname(clPath), '..', '..', '..', '..', '..', '..', 'Auxiliary', 'Build', 'vcvars64.bat');
    return fs.existsSync(p) ? p : '';
  } catch { return ''; }
}

async function detectMsvc() {
  const label = TOOLCHAINS.msvc.label;
  const vswhere = path.join(pf86Dir(), 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  let install = '';
  if (fs.existsSync(vswhere)) {
    const r = await runCmd(`"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`, os.homedir(), 20000);
    install = String(r.output || '').split('\n').map(s => s.trim()).filter(s => /^[A-Za-z]:\\/i.test(s))[0] || '';
  }
  if (install) {
    const ver = listDirs(path.join(install, 'VC', 'Tools', 'MSVC')).sort().pop();
    if (ver) {
      const dir = path.join(install, 'VC', 'Tools', 'MSVC', ver, 'bin', 'Hostx64', 'x64');
      const vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
      return { ok: true, id: 'msvc', bin: 'cl', path: path.join(dir, 'cl.exe'), dir, version: 'Visual Studio ' + ver, source: 'FOUND', vcvars: fs.existsSync(vcvars) ? vcvars : '', label, heavy: true };
    }
  }
  const hit = await whereBin('cl');
  if (hit.ok) {
    return { ok: true, id: 'msvc', bin: 'cl', path: hit.path, dir: path.dirname(hit.path), version: await probeVersion(hit.path, []), source: hit.source, vcvars: findVcvarsFromCl(hit.path), label, heavy: true };
  }
  return { ok: false, id: 'msvc', bin: 'cl', label, heavy: true, winget: TOOLCHAINS.msvc.winget, url: TOOLCHAINS.msvc.url };
}

async function detectTool(id) {
  const def = TOOLCHAINS[id];
  if (!def) return { id, label: id, ok: false };
  if (def.probe === 'vswhere') return detectMsvc();
  for (const entry of def.bins || []) {
    const bin = entry[0];
    const hit = await whereBin(bin);
    if (!hit.ok) continue;
    return { id, label: def.label, ok: true, bin, path: hit.path, dir: path.dirname(hit.path), version: await probeVersion(hit.path, entry.slice(1)), source: hit.source, heavy: !!def.heavy };
  }
  return { id, label: def.label, ok: false, heavy: !!def.heavy, manual: !!def.manual, winget: def.winget || '', url: def.url || '' };
}

function resolveIdSync(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (TOOLCHAINS[k]) return k;
  if (TOOL_GROUPS[k]) return TOOL_GROUPS[k].install[0];
  if (TOOL_ALIAS[k]) return TOOL_ALIAS[k];
  return null;
}
async function resolveNeed(raw, tools) {
  const k = String(raw || '').trim().toLowerCase();
  if (TOOL_GROUPS[k]) {
    const g = TOOL_GROUPS[k];
    for (const p of g.prefer) if (tools && (tools[p] || {}).ok) return p;
    return g.install[0];
  }
  return resolveIdSync(k);
}

const MANIFEST_NEEDS = {
  'package.json': ['node'], 'package-lock.json': ['node'], 'pnpm-lock.yaml': ['node'], 'yarn.lock': ['node'], 'bun.lockb': ['node', 'bun'],
  'requirements.txt': ['python', 'pip'], 'pyproject.toml': ['python', 'pip'], 'setup.py': ['python', 'pip'], 'pipfile': ['python', 'pip'],
  'cargo.toml': ['rust'], 'go.mod': ['go'],
  'pom.xml': ['java', 'maven'], 'build.gradle': ['java', 'gradle'], 'build.gradle.kts': ['java', 'gradle'],
  'cmakelists.txt': ['cmake', 'cpp'], 'makefile': ['make', 'cpp'], 'makefile.am': ['make', 'cpp'],
  'dockerfile': ['docker'], 'docker-compose.yml': ['docker'], 'compose.yaml': ['docker'],
  'composer.json': ['php'], 'gemfile': ['ruby'], 'rakefile': ['ruby'],
  'index.html': [], 'index.htm': [], 'style.css': [], 'main.js': [], 'app.js': []
};
const EXT_NEEDS = {
  '.py': ['python'], '.java': ['java'], '.kt': ['java', 'gradle'], '.cs': ['dotnet'],
  '.rs': ['rust'], '.go': ['go'], '.php': ['php'], '.rb': ['ruby'],
  '.c': ['cpp'], '.cpp': ['cpp'], '.cc': ['cpp'], '.hpp': ['cpp'], '.cxx': ['cpp'],
  '.ts': ['node'], '.tsx': ['node'], '.jsx': ['node'], '.vue': ['node'], '.svelte': ['node']
};

async function detectProject(root) {
  const out = { root: root || '', kind: 'no project', needs: [], files: [] };
  if (!root || !fs.existsSync(String(root))) return out;
  const needs = [];
  const add = (ids) => { for (const i of ids || []) if (!needs.includes(i)) needs.push(i); };
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 2 || files.length > 500) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name !== 'assets') await walk(full, depth + 1); continue; }
      const low = e.name.toLowerCase();
      if (files.length < 200) files.push(path.relative(root, full).replace(/\\/g, '/'));
      if (MANIFEST_NEEDS[low]) add(MANIFEST_NEEDS[low]);
      if (/\.(csproj|fsproj|vbproj|sln)$/i.test(low)) add(['dotnet']);
      const ext = path.extname(low);
      if (EXT_NEEDS[ext]) add(EXT_NEEDS[ext]);
    }
  };
  await walk(String(root), 0);
  const names = files.map(f => path.basename(f).toLowerCase());
  let kind = '';
  if (names.includes('package.json')) {
    let pkgTxt = '';
    try { pkgTxt = (await fs.promises.readFile(path.join(String(root), 'package.json'), 'utf-8')).slice(0, 20000).toLowerCase(); } catch {}
    kind = /electron-builder|"electron"/.test(pkgTxt) ? 'Electron app'
      : /"next"/.test(pkgTxt) ? 'Next.js web'
      : /"vite"/.test(pkgTxt) ? 'Vite web'
      : /"nuxt"/.test(pkgTxt) ? 'Nuxt web'
      : 'Node.js/npm project';
  } else if (names.includes('cargo.toml')) kind = 'Rust project';
  else if (names.includes('go.mod')) kind = 'Go project';
  else if (names.includes('requirements.txt') || names.includes('pyproject.toml')) kind = 'Python project';
  else if (names.some(n => n.endsWith('.csproj') || n.endsWith('.sln'))) kind = '.NET project';
  else if (names.includes('pom.xml')) kind = 'Java (Maven)';
  else if (names.some(n => n.startsWith('build.gradle'))) kind = 'Java/Kotlin (Gradle)';
  else if (names.includes('cmakelists.txt')) kind = 'C/C++ (CMake)';
  else if (names.includes('makefile')) kind = 'C/C++ (Make)';
  else if (names.includes('dockerfile')) kind = 'Docker project';
  else if (names.includes('composer.json')) kind = 'PHP project';
  else if (names.includes('gemfile')) kind = 'Ruby project';
  else if (names.some(n => /\.(cpp|cc|cxx|c)$/.test(n))) kind = 'C/C++ sources';
  else if (names.some(n => n.endsWith('.py'))) kind = 'Python sources';
  else if (names.includes('index.html')) kind = 'static website';
  if (needs.includes('cpp') && !needs.includes('msvc') && !needs.includes('gcc')) { /* group resolution later */ }
  out.kind = kind || 'code';
  out.needs = needs;
  out.files = files.slice(0, 120);
  return out;
}

const INTENT_RULES = [
  [/\bc\+\+|\bcpp\b|\bg\+\+|\.cpp\b|\.hpp\b|\.cc\b|\.cxx\b|sfml|raylib|allegro|opengl|vulkan|\bsdl2?\b|pdcurses|conio/i, ['cpp']],
  [/\bmsvc\b|visual studio/i, ['msvc']],
  [/\bc#\b|csharp|dotnet|\.cs\b|\.csproj\b|wpf|blazor|maui/i, ['dotnet']],
  [/\bpython|\bpy\b|\.py\b|flask|django|fastapi|pandas|numpy|selenium|pygame|tkinter|pyqt|discord bot|telegram bot/i, ['python']],
  [/\bnode\b|nodejs|node\.js|\bnpm\b|\bnpx\b|electron|\breact\b|next\.?js|\bvue\b|angular|svelte|nestjs|express|typescript|javascript|tailwind|three\.?js|webov|web app|str\u00e1nk|\bhtml\b|\bcss\b/i, ['node']],
  [/\brust|\bcargo\b|\.rs\b/i, ['rust']],
  [/golang|\bgo\s+lang\b|\.go\b|gin-gonic|fiber/i, ['go']],
  [/\bjava\b|\bjavu\b|\bjavac\b|\bkotlin|android|\bapk\b|\bspring\b|\bjar\b/i, ['java']],
  [/\bmaven|pom\.xml/i, ['java', 'maven']],
  [/\bgradle|build\.gradle/i, ['java', 'gradle']],
  [/\bphp\b|laravel|composer/i, ['php']],
  [/\bruby\b|\brails\b|gemfile/i, ['ruby']],
  [/\bdart\b|flutter/i, ['git']],
  [/\bcmake\b/i, ['cmake']],
  [/\bgit\b|github|gitlab|bitbucket|commit|repozit/i, ['git']],
  [/\bdocker\b|kontejner|container/i, ['docker']],
  [/\bunity\b/i, ['unity']],
  [/\bunreal\b/i, ['unreal']],
  [/7-?zip|\b7z\b|\brar\b/i, ['sevenzip']]
];
function detectIntent(text) {
  const t = String(text || '').trim();
  const needs = [];
  if (t) {
    for (const [rx, ids] of INTENT_RULES) {
      if (!rx.test(t)) continue;
      for (const i of ids) if (!needs.includes(i)) needs.push(i);
    }
  }
  return { text: t.slice(0, 200), needs };
}

const SHELL_BUILTINS = new Set(['cd', 'dir', 'echo', 'type', 'copy', 'move', 'del', 'erase', 'mkdir', 'rmdir', 'ren', 'rename', 'where', 'set', 'if', 'for', 'call', 'start', 'exit', 'cls', 'tree', 'attrib', 'find', 'findstr', 'more', 'tasklist', 'taskkill', 'ipconfig', 'ping', 'netstat', 'systeminfo', 'ver', 'vol', 'date', 'time', 'timeout', 'choice', 'cmd', 'powershell', 'pwsh', 'curl', 'tar', 'certutil', 'bitsadmin', 'reg', 'sc', 'net', 'xcopy', 'robocopy', 'comp', 'fc', 'sort', 'wsl', 'explorer', 'notepad', 'del', 'shutdown', 'msiexec', 'choco', 'scoop', 'winget']);
function requiredForCommand(cmd) {
  const segs = String(cmd || '').split(/\r?\n|&&|\|\||;|\|/g).map(s => s.trim()).filter(Boolean);
  const ids = [];
  for (const seg of segs) {
    const m = seg.match(/^["']?([A-Za-z0-9][\w.+~-]*)/);
    if (!m) continue;
    const bin = m[1].toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
    if (SHELL_BUILTINS.has(bin)) continue;
    const id = CMD_TOOL.get(bin) || TOOL_ALIAS[bin];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function detectAllTools(force) {
  if (!force && envState.tools && Date.now() - envState.at < ENV_TTL) return envState.tools;
  const tools = {};
  const queue = Object.keys(TOOLCHAINS);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) { const id = queue.shift(); tools[id] = await detectTool(id); }
  }));
  envState.tools = tools;
  envState.at = Date.now();
  return tools;
}

async function detectManagers() {
  if (envState.packages && Date.now() - envState.pkgAt < 60000) return envState.packages;
  const out = {};
  for (const m of ['winget', 'choco', 'scoop']) {
    const hit = await whereBin(m);
    out[m] = hit.ok ? (hit.path || m) : false;
  }
  envState.packages = out;
  envState.pkgAt = Date.now();
  return out;
}

function applyDiscoveredPaths(paths) {
  try {
    const sep = path.delimiter;
    const cur = String(process.env.PATH || '').split(sep);
    let changed = false;
    for (const p of paths || []) {
      if (!p || !p.dir) continue;
      if (!cur.some(x => String(x).toLowerCase() === String(p.dir).toLowerCase())) { cur.push(p.dir); changed = true; }
    }
    if (changed) process.env.PATH = cur.join(sep);
  } catch {}
}

async function scanEnv(opts) {
  const o = opts || {};
  const tools = await detectAllTools(!!o.force);
  const project = await detectProject(o.root);
  const intent = detectIntent(o.request);
  const needed = [];
  for (const raw of [...project.needs, ...intent.needs]) {
    const id = await resolveNeed(raw, tools);
    if (id && !needed.includes(id)) needed.push(id);
  }
  const missing = needed.filter(id => !(tools[id] || {}).ok);
  const data = {
    at: Date.now(), os: `${os.type()} ${os.release()}`, user: (() => { try { return os.userInfo().username; } catch { return '?'; } })(),
    tools, project, intent, needed, missing,
    packages: await detectManagers(),
    paths: Object.values(tools).filter(t => t.ok && t.dir && t.id !== 'msvc').map(t => ({ id: t.id, dir: t.dir, source: t.source }))
  };
  applyDiscoveredPaths(data.paths);
  return data;
}

// Short version for the MODEL (the full table is in the Settings panel from data.tools).
// Reason: a weak model gets lost in a 22-row table and then calls tools with empty arguments.
function envReportShort(s) {
  const lines = [];
  const pkg = Object.entries(s.packages || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
  lines.push(`PC: ${s.os} \u00b7 package managers: ${pkg}`);
  lines.push(`Project${s.project.root ? ' ' + s.project.root : ''}: ${s.project.kind}`);
  if (s.intent.text) lines.push(`Request: "${s.intent.text}" \u2192 needs: ${s.intent.needs.join(', ') || 'nothing specific'}`);
  const lbl = (i) => (TOOLCHAINS[i] || {}).label || i;
  if (s.needed.length) {
    lines.push('Needed status:');
    for (const i of s.needed) {
      const t = (s.tools || {})[i] || {};
      if (t.ok) lines.push(`  \u2713 ${lbl(i)} (${t.version || 'found'})`);
      else {
        const how = t.manual ? 'manual only: ' + (t.url || '') : t.heavy ? 'large toolchain (heavy: true)' : 'will install via env_prepare';
        lines.push(`  \u2717 ${lbl(i)} \u2014 missing (${how})`);
      }
    }
  } else lines.push('Needed for this job: nothing yet');
  lines.push(`Missing in total: ${s.missing.length ? s.missing.map(lbl).join(', ') : 'nothing \u2014 everything is here'}`);
  return lines.join('\n');
}
function envReport(s) {
  const lines = [];
  const pkg = Object.entries(s.packages || {}).map(([k, v]) => `${k} ${v ? '\u2713' : '\u2717'}`).join(', ');
  lines.push(`PC: ${s.os} \u00b7 user ${s.user} \u00b7 package managers: ${pkg}`);
  lines.push('Tools on this PC:');
  for (const t of Object.values(s.tools)) {
    if (t.ok) lines.push(`  \u2713 ${t.label} \u2014 ${t.version || 'found'}${t.dir ? ' \u00b7 ' + t.dir : ''}${t.source === 'FOUND' ? ' (was outside PATH, added to PATH)' : ''}`);
    else lines.push(`  \u2717 ${t.label} \u2014 missing${t.heavy ? ' \u00b7 large toolchain' : ''}${t.winget ? ' \u00b7 winget ' + t.winget : ''}${t.manual ? ' \u00b7 manual only' : ''}${t.url ? ' \u00b7 ' + t.url : ''}`);
  }
  lines.push(`Project${s.project.root ? ' ' + s.project.root : ''}: ${s.project.kind}`);
  if (s.intent.text) lines.push(`User request: "${s.intent.text}" \u2192 needs: ${s.intent.needs.join(', ') || 'nothing specific'}`);
  lines.push(`Needed for this job: ${s.needed.length ? s.needed.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ') : 'nothing yet'}`);
  lines.push(`Missing, will be installed: ${s.missing.length ? s.missing.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ') : 'nothing \u2014 everything is here'}`);
  return lines.join('\n');
}
function envHow(r) {
  return r.how === 'winget' ? 'winget' : r.how === 'choco' ? 'Chocolatey' : r.how === 'scoop' ? 'Scoop' : 'downloaded from the internet';
}
function envActionReport(after, results) {
  const lines = [envReportShort(after), '', 'Actions:'];
  for (const r of results || []) {
    if (r.already) lines.push(`  \u2713 ${r.label} \u2014 already on this PC (${r.version || 'found'})`);
    else if (r.ok) lines.push(`  \u2713 ${r.label} \u2014 installed (${envHow(r)})`);
    else if (r.missing) lines.push(`  \u24d8 ${r.label} \u2014 missing, installation would start${r.heavy ? ' (large toolchain, needs heavy: true)' : ''}`);
    else if (r.manual) lines.push(`  \u24d8 ${r.label} \u2014 cannot be installed automatically: ${String(r.output || '').replace(/^.*(Odkaz|Link): /, '')}`);
    else lines.push(`  \u2717 ${r.label} \u2014 ${String(r.output || 'failed').split('\n').slice(0, 2).join(' ')}`);
  }
  lines.push(after.missing.length ? `\nStill missing after this action: ${after.missing.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ')}` : '\nEverything needed is ready \u2014 continue with the work.');
  return lines.join('\n');
}

// ===== Portable installs (winget fallback): all downloadable toolchains =====
async function toolsDirFor(userDataDir) {
  const d = path.join(String(userDataDir || os.tmpdir()), 'tools');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function ghAsset(repo, re) {
  const hit = (assets) => (assets || []).find(a => re.test(a.name || ''));
  let rel = await fetchJson('https://api.github.com/repos/' + repo + '/releases/latest', 25000);
  let a = hit(rel && rel.assets);
  if (!a) {
    const list = await fetchJson('https://api.github.com/repos/' + repo + '/releases?per_page=6', 25000);
    for (const r of (Array.isArray(list) ? list : [])) {
      a = hit(r.assets);
      if (a) break;
    }
  }
  return a && a.browser_download_url ? a : null;
}
function nonEmptyDir(d) { try { return fs.readdirSync(d).length > 0; } catch { return false; } }
async function unzipTo(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  dlEvent({ kind: 'dl', id: String(zip), label: dlContext || path.basename(String(zip)), phase: 'extract', percent: -1 });
  let r = await runArgv('tar', ['-xf', zip, '-C', dest], dest, 900000);
  if (r.ok && nonEmptyDir(dest)) return true;
  r = await runCmd(`powershell -NoProfile -Command "Expand-Archive -Force '${zip}' '${dest}'"`, dest, 900000);
  return !!r.ok && nonEmptyDir(dest);
}
async function untarTo(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true });
  dlEvent({ kind: 'dl', id: String(tgz), label: dlContext || path.basename(String(tgz)), phase: 'extract', percent: -1 });
  const r = await runArgv('tar', ['-xf', tgz, '-C', dest], dest, 900000);
  return !!r.ok && nonEmptyDir(dest);
}
async function sevenZTo(seven, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const hit = await whereBin('7z');
  if (!hit.ok) return false;
  dlEvent({ kind: 'dl', id: String(seven), label: dlContext || path.basename(String(seven)), phase: 'extract', percent: -1 });
  const r = await runArgv(hit.path, ['x', '-y', '-o' + dest, seven], dest, 900000);
  return !!r.ok && nonEmptyDir(dest);
}
async function findFileRe(root, re, maxDepth) {
  const rx = re instanceof RegExp ? re : new RegExp(re, 'i');
  let best = '';
  const walk = async (dir, depth) => {
    if (depth > (maxDepth || 4) || best) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { if (best) return; if (e.isFile() && rx.test(e.name)) { best = path.join(dir, e.name); return; } }
    for (const e of entries) { if (best) return; if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1); }
  };
  await walk(root, 0);
  return best;
}
const PORTABLE_INSTALLERS = {
  async node(ud) { return installPortableNode(ud); },
  async git(ud) { return installPortableGit(ud); },
  async python(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('astral-sh/python-build-standalone', /^cpython-3\.(12|13).*-x86_64-pc-windows-msvc-install_only\.tar\.gz$/i);
    if (!a) throw new Error('Could not find portable Python.');
    const f = path.join(d, 'python.tar.gz');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'python');
    await untarTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^python\.exe$/i, 4);
    if (!exe) throw new Error('Python extraction failed.');
    rememberToolDir(ud, 'python', path.dirname(exe));
    rememberToolDir(ud, 'python', path.join(path.dirname(exe), 'Scripts'));
    await prependPortableBins(ud);
    return { output: `Python downloaded from the internet (${a.name}).` };
  },
  async gcc(ud) {
    const d = await toolsDirFor(ud);
    const has7z = (await whereBin('7z')).ok;
    const a = await ghAsset('brechtsanders/winlibs_mingw', has7z
      ? /^winlibs-x86_64-.*gcc.*\.7z$/i
      : /^winlibs-x86_64-.*gcc.*\.zip$/i);
    if (!a) throw new Error('Could not find WinLibs GCC.');
    const f = path.join(d, 'winlibs' + (has7z ? '.7z' : '.zip'));
    const dl = await downloadFile(a.browser_download_url, f, 900000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'gcc');
    const okx = has7z ? await sevenZTo(f, out) : await unzipTo(f, out);
    if (!okx) throw new Error('GCC extraction failed.');
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^(gcc|g\+\+)\.exe$/i, 5);
    if (!exe) throw new Error('GCC extraction failed.');
    rememberToolDir(ud, 'gcc', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: `GCC downloaded from the internet (${a.name}).` };
  },
  async cmake(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('Kitware/CMake', /^(?:cmake-[\d.]+-)?windows-x86_64\.zip$/i);
    if (!a) throw new Error('Could not find a CMake release.');
    const f = path.join(d, 'cmake.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'cmake');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^cmake\.exe$/i, 4);
    if (!exe) throw new Error('CMake extraction failed.');
    rememberToolDir(ud, 'cmake', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: `CMake downloaded from the internet (${a.name}).` };
  },
  async go(ud) {
    const d = await toolsDirFor(ud);
    const idx = await fetchJson('https://go.dev/dl/?mode=json', 25000);
    const rel = Array.isArray(idx) ? idx.find(v => v && v.stable) : null;
    const files = (rel && rel.files) || [];
    const f64 = files.find(x => x.os === 'windows' && x.arch === 'amd64' && x.kind === 'archive') || null;
    if (!f64) throw new Error('Could not find a Go release.');
    const f = path.join(d, 'go.zip');
    const dl = await downloadFile('https://go.dev/dl/' + f64.filename, f, 900000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'go');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^go\.exe$/i, 4);
    if (!exe) throw new Error('Go extraction failed.');
    rememberToolDir(ud, 'go', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: `Go ${rel.version} downloaded from the internet.` };
  },
  async java(ud) {
    const d = await toolsDirFor(ud);
    const f = path.join(d, 'jdk.zip');
    const dl = await downloadFile('https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse', f, 900000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'java');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^javac\.exe$/i, 4);
    if (!exe) throw new Error('JDK extraction failed.');
    rememberToolDir(ud, 'java', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: 'JDK 21 downloaded from the internet (Adoptium).' };
  },
  async dotnet(ud) {
    const d = await toolsDirFor(ud);
    const ps1 = path.join(d, 'dotnet-install.ps1');
    const dl = await downloadFile('https://dot.net/v1/dotnet-install.ps1', ps1, 120000);
    if (!dl.ok) throw new Error('Script download failed: ' + dl.error);
    const target = path.join(d, 'dotnet');
    const r = await runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -Channel 9.0 -InstallDir "${target}" -NoPath`, d, 900000);
    if (!r.ok || !fs.existsSync(path.join(target, 'dotnet.exe'))) throw new Error('.NET SDK installation failed: ' + r.output.slice(-300));
    rememberToolDir(ud, 'dotnet', target);
    await prependPortableBins(ud);
    return { output: '.NET SDK 9 downloaded from the internet into the app.' };
  },
  async rust(ud) {
    const d = await toolsDirFor(ud);
    const exe = path.join(d, 'rustup-init.exe');
    const dl = await downloadFile('https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe', exe, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const r = await runCmd(`"${exe}" -y --profile minimal --default-toolchain stable --no-modify-path`, d, 900000);
    const cargoDir = path.join(os.homedir(), '.cargo', 'bin');
    if (!r.ok || !fs.existsSync(path.join(cargoDir, 'cargo.exe'))) throw new Error('Rust installation failed: ' + r.output.slice(-300));
    rememberToolDir(ud, 'rust', cargoDir);
    await prependPortableBins(ud);
    return { output: 'Rust (cargo) downloaded from the internet (rustup).' };
  },
  async bun(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('oven-sh/bun', /^bun-windows-x64\.zip$/i);
    if (!a) throw new Error('Could not find a Bun release.');
    const f = path.join(d, 'bun.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'bun');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^bun\.exe$/i, 4);
    if (!exe) throw new Error('Bun extraction failed.');
    rememberToolDir(ud, 'bun', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: `Bun downloaded from the internet (${a.name}).` };
  },
  async deno(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('denoland/deno', /^deno-x86_64-pc-windows-msvc\.zip$/i);
    if (!a) throw new Error('Could not find a Deno release.');
    const f = path.join(d, 'deno.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'deno');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^deno\.exe$/i, 4);
    if (!exe) throw new Error('Deno extraction failed.');
    rememberToolDir(ud, 'deno', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: `Deno downloaded from the internet (${a.name}).` };
  },
  async php(ud) {
    const d = await toolsDirFor(ud);
    const f = path.join(d, 'php.zip');
    const dl = await downloadFile('https://windows.php.net/downloads/releases/latest/php-8.4-nts-Win32-vs17-x64-latest.zip', f, 600000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    const out = path.join(d, 'php');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = await findFileRe(out, /^php\.exe$/i, 4);
    if (!exe) throw new Error('PHP extraction failed.');
    rememberToolDir(ud, 'php', path.dirname(exe));
    await prependPortableBins(ud);
    return { output: 'PHP 8.4 downloaded from the internet.' };
  },
  async sevenzip(ud) {
    const d = await toolsDirFor(ud);
    const sub = path.join(d, '7zip');
    fs.mkdirSync(sub, { recursive: true });
    const exe = path.join(sub, '7zr.exe');
    const dl = await downloadFile('https://www.7-zip.org/a/7zr.exe', exe, 300000);
    if (!dl.ok) throw new Error('Download failed: ' + dl.error);
    try { fs.copyFileSync(exe, path.join(sub, '7z.exe')); } catch {}
    rememberToolDir(ud, 'sevenzip', sub);
    await prependPortableBins(ud);
    return { output: '7-Zip downloaded from the internet.' };
  }
};

async function installTool(id, opts) {
  const o = opts || {};
  const def = TOOLCHAINS[id];
  if (!def) return { ok: false, output: 'Unknown toolchain: ' + id };
  if (def.manual) return { ok: false, manual: true, heavy: !!def.heavy, output: `${def.label} cannot be installed automatically. Link: ${def.url || ''}` };
  if (def.heavy && !o.heavy) return { ok: false, heavy: true, output: `${def.label} is a large toolchain (GB) \u2014 needs user confirmation (heavy: true). Manual: ${def.url || ''}` };
  const notes = [];
  const H = os.homedir();
  const alias = PKG_ALIAS[id] || {};
  const attempts = [];
  const pk = def.winget || alias.winget;
  const ck = def.choco || alias.choco;
  const sk = def.scoop || alias.scoop;
  if (pk) attempts.push({ how: 'winget', pkg: pk, cmd: `winget install --id ${pk} -e --silent --scope user --accept-package-agreements --accept-source-agreements${def.wingetExtra || ''}` });
  if (ck) attempts.push({ how: 'choco', pkg: ck, cmd: `choco install ${ck} -y --no-progress` });
  if (sk) attempts.push({ how: 'scoop', pkg: sk, cmd: `scoop install ${sk}` });
  for (const a of attempts) {
    if (o.only && o.only !== a.how) continue;
    if (!o.only && !(await whereBin(a.how)).ok) { notes.push(`${a.how} is not on this PC \u2014 skipped.`); continue; }
    dlContext = def.label;
    dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'install', percent: -1, how: a.how });
    const r = await runCmd(a.cmd, H, 900000);
    envState.dirs = []; envState.dirsAt = 0;
    const det = await detectTool(id);
    if (det.ok) {
      rememberToolDir(o.userDataDir, id, det.dir);
      await prependPortableBins(o.userDataDir);
      dlContext = '';
      dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'done', percent: 100, how: a.how, ok: true });
      return { ok: true, how: a.how, output: `${def.label} installed via ${a.how} (${a.pkg}): ${det.version || 'done'}${det.dir ? ' \u2192 ' + det.dir : ''}. Available in subsequent commands.` };
    }
    dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'error', percent: -1, how: a.how, ok: false });
    dlContext = '';
    if (r.ok) notes.push(`${a.how} (${a.pkg}) reported success, but I cannot find the binary \u2014 trying another way.`);
    else notes.push(`${a.how} (${a.pkg}) failed: ${String(r.output || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  }
  if (def.portable && o.userDataDir) {
    dlContext = def.label;
    try {
      const p = await PORTABLE_INSTALLERS[def.portable](o.userDataDir);
      const det = await detectTool(id);
      if (det.ok) {
        rememberToolDir(o.userDataDir, id, det.dir);
        await prependPortableBins(o.userDataDir);
        dlContext = '';
        dlEvent({ kind: 'dl', id: 'portable:' + id, label: def.label, phase: 'done', percent: 100, how: 'portable', ok: true });
        return { ok: true, how: 'portable', output: `${def.label} downloaded from the internet into the app: ${det.version || 'done'}${det.dir ? ' \u2192 ' + det.dir : ''}.${p && p.output ? ' ' + p.output : ''}` };
      }
      notes.push(`portable variant installed, but I cannot find the binary: ${(p && p.output) || ''}`);
    } catch (e) { notes.push('portable download failed: ' + e.message); }
    dlContext = '';
    dlEvent({ kind: 'dl', id: 'portable:' + id, label: def.label, phase: 'error', percent: -1, how: 'portable', ok: false });
  } else if (def.portable) {
    notes.push('portable variant not possible without a userData path');
  }
  return { ok: false, output: `Automatic installation of ${def.label} failed.${notes.length ? '\n' + notes.join('\n') : ''}\nManual: ${def.url || 'https://winget.run/'}` };
}

async function ensureTools(ids, opts) {
  const o = opts || {};
  const results = [];
  const seen = new Set();
  const queue = [];
  const push = (raw) => {
    const id = resolveIdSync(raw);
    if (!id || seen.has(id)) return;
    seen.add(id); queue.push(id);
  };
  for (const raw of ids || []) push(raw);
  while (queue.length) {
    const id = queue.shift();
    const def = TOOLCHAINS[id];
    if (!def) { results.push({ id, label: id, ok: false, output: 'Unknown toolchain' }); continue; }
    for (const dep of def.deps || []) push(dep);
    const det = await detectTool(id);
    if (det.ok) { results.push({ id, label: def.label, ok: true, already: true, version: det.version, path: det.path }); continue; }
    if (o.dryRun) { results.push({ id, label: def.label, ok: false, missing: true, heavy: !!def.heavy }); continue; }
    const r = await installTool(id, o);
    results.push({ id, label: def.label, ok: !!r.ok, how: r.how || '', heavy: !!r.heavy, manual: !!r.manual, output: r.output || '' });
  }
  envState.tools = null; envState.at = 0;
  envState.dirs = []; envState.dirsAt = 0;
  return results;
}

async function ensureForShell(cmd, opts) {
  const o = opts || {};
  const wanted = requiredForCommand(cmd);
  if (!wanted.length || !o.userDataDir) return [];
  const scan = await scanEnv({ root: o.root });
  const missing = [];
  for (const raw of wanted) {
    const id = await resolveNeed(raw, scan.tools);
    if (!id) continue;
    if ((scan.tools[id] || {}).ok) continue;
    const def = TOOLCHAINS[id];
    if (!def || def.heavy || def.manual) continue;
    if (!missing.includes(id)) missing.push(id);
  }
  if (!missing.length) return [];
  const res = await ensureTools(missing, o);
  await scanEnv({ root: o.root, force: true });
  return res.filter(r => !r.already);
}
function fetchHtml(url, timeoutMs) {
  return new Promise((resolve) => {
    const go = (u, left) => {
      const mod = String(u).startsWith('https:') ? https : http;
      const req = mod.get(String(u), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), left - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', c => { if (data.length < 500000) data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs || 20000, () => { req.destroy(); resolve(null); });
    };
    go(url, 4);
  });
}
// Shell as administrator: Windows UAC dialog + output via temp files.
// Called only when the normal path fails on permissions (installs etc.).
function runCmdAdmin(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const tag = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const outFile = path.join(os.tmpdir(), `nl-admin-${tag}.out`);
    const errFile = path.join(os.tmpdir(), `nl-admin-${tag}.err`);
    // Redirection is done by cmd ITSELF inside (> file) — Start-Process redirect with UAC is unreliable.
    // Everything goes into single-quoted PS strings: ' → ''
    const esc = (s) => String(s).replace(/'/g, "''");
    const inner = `${String(cmd)} > "${outFile}" 2> "${errFile}"`;
    const ps = `try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c','${esc(inner)}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -WorkingDirectory '${esc(cwd)}'; 'EXIT:' + $p.ExitCode } catch { 'ADMIN-FAIL:' + $_.Exception.Message }`;
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const text = String(stdout || '');
      let out = '';
      try { out = decodeConsole(fs.readFileSync(outFile)); } catch {}
      let errT = '';
      try { errT = decodeConsole(fs.readFileSync(errFile)); } catch {}
      try { fs.rmSync(outFile, { force: true }); } catch {}
      try { fs.rmSync(errFile, { force: true }); } catch {}
      if (/ADMIN-FAIL:/.test(text)) {
        const why = (text.split('ADMIN-FAIL:')[1] || '').trim().slice(0, 300);
        resolve({ ok: false, output: `Admin shell did not start at all (${why || 'UAC denied'}).` });
        return;
      }
      const m = text.match(/EXIT:(-?\d+)/);
      let combined = String(out || '');
      if (errT) combined += (combined ? '\n[stderr]\n' : '') + String(errT);
      if (combined.length > 20000) combined = combined.slice(0, 20000) + '\n… (output truncated)';
      if (err) {
        resolve({ ok: false, output: `${combined}\n[admin shell failed: ${err.killed ? 'timeout' : err.message}]`.trim() });
        return;
      }
      if (!m) {
        resolve({ ok: false, output: `${combined}\n[admin shell returned neither an exit code nor output \u2014 the command probably did not run.]`.trim() });
        return;
      }
      const code = parseInt(m[1], 10);
      resolve({ ok: code === 0, output: `${combined}\n[exit ${code}]`.trim() });
    });
  });
}
// Line diff (green + / red -) for edit_file
function diffLines(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  if (A.length * B.length > 60000) return null;
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i++; }
    else { out.push({ t: '+', s: B[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out.slice(0, 120);
}
/* ===== build_exe: kompletni pipeline EXE aplikace (100% zaruka) =====
   1) inventura: package.json + vsechny lokalni soubory, na ktere odkazuje index.html
   2) auto-oprava package.json: scripts.dist, devDependencies, build.files (vzdy kompletni)
   3) npm install, kdyz chybi node_modules nebo je starsi nez package.json
   4) PLNY rebuild (npm run dist / electron-builder) - nikdy se nic nepreskakuje
   5) verifikace: exe existuje a je cerstve, asar obsahuje vsechny soubory
   6) launch-test: exe se spusti, 4 s musi bezet, pak se zabije - report PASS/FAIL */
function collectHtmlRefs(html) {
  const s = String(html || '');
  const refs = [];
  const push = (v) => {
    v = String(v || '').trim();
    if (!v) return;
    if (/^(https?:|data:|blob:|file:|#)/i.test(v)) return;
    v = v.split(/[?#]/)[0].trim();
    if (!v || /^[a-zA-Z]+:/.test(v)) return;
    refs.push(v.replace(/^\.\//, ''));
  };
  const tagRe = /<(script|link|img|audio|video|source|track|embed)\b[^>]*?\b(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  let m;
  while ((m = tagRe.exec(s))) push(m[2].replace(/^["']|["']$/g, ''));
  const cssRe = /url\(\s*("[^"]*"|'[^']*'|[^)]+?)\s*\)/gi;
  while ((m = cssRe.exec(s))) {
    const v = m[1].replace(/^["']|["']$/g, '');
    if (!/^data:/i.test(v)) push(v);
  }
  return [...new Set(refs)];
}
function findHtmlDuplicates(html) {
  const s = String(html || '');
  const seen = new Map(), dups = [];
  const tagRe = /<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  let m;
  while ((m = tagRe.exec(s))) {
    const v = m[2].replace(/^["']|["']$/g, '').trim();
    if (!v || /^(https?:|data:)/i.test(v)) continue;
    const n = (seen.get(v) || 0) + 1;
    seen.set(v, n);
    if (n === 2) dups.push(v);
  }
  return dups;
}
// Bezici shell procesy: cid -> {child, pid, key}. Stop tlacitko je pres
// cancelToolsFor zabije (klic = projektova slozka).
const activeProcs = new Map();
// Vsechny PIDs, ktere jsme pro slozku kdy spustili (i davno skoncene).
// build_exe je na zacatku pobije — resi sirotky po Stopu uprostred buildu
// (stary builder by jinak drzel app.asar a KAZDY dalsi build by padl na zamku).
const dirProcs = new Map(); // rootKey -> Set<pid>
function rememberPid(key, pid) {
  try {
    if (!pid) return;
    const k = String(key || '');
    if (!k) return;
    let s = dirProcs.get(k);
    if (!s) { s = new Set(); dirProcs.set(k, s); }
    s.add(Number(pid));
    if (s.size > 200) { const a = [...s].slice(-200); dirProcs.set(k, new Set(a)); }
  } catch {}
}
// Snapshot procesu: pid -> {img, cmd}. Jedno volani na zacatku buildu (~1 s).
// POZOR: powershell.exe se spousti PRIMO pres execFile, NIKDY pres cmd.exe —
// cmd vrstva sezere `$_` a zbyde ".ProcessId" (overeno testy: primo OK, pres cmd KO).
async function procsSnapshot() {
  const map = new Map();
  try {
    const out = await new Promise((resolve) => {
      try {
        require('child_process').execFile('powershell.exe',
          ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + [char]124 + $_.Name + [char]124 + $_.CommandLine }'],
          { timeout: 30000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
          (err, stdout) => {
            if (err) { resolve(''); return; }
            resolve(String(stdout || ''));
          });
      } catch { resolve(''); }
    });
    for (const line of String(out || '').split('\n')) {
      const a = line.indexOf('|'), b = line.indexOf('|', a + 1);
      if (a < 0 || b < 0) continue;
      const pid = Number(line.slice(0, a).trim());
      if (!pid) continue;
      map.set(pid, { img: line.slice(a + 1, b).trim().toLowerCase(), cmd: line.slice(b + 1) });
    }
  } catch {}
  return map;
}
// Pobij sirotky PO NASICH predchozich buildech ve slozce. Dve vrstvy:
//  1) PIDs, ktere jsme sami spustili v teto session (dirProcs) — presne, rychle.
//  2) Sweep: node.exe s electron-builder + cestou projektu v cmdline — chyti i sirotky
//     z doby pred restartem aplikace (pamet dirProcs se restartem vymaze).
// Zabiji se jen procesy, ktere kazdym coulem vypadaji jako nase buildry — nikdy nic
// ciziho. PID se na Windows recykluje, takze samotne cislo nestaci.
async function killOwnOrphans(dir) {
  const key = String(dir || '');
  let n = 0;
  const killPid = (pid) => {
    try { require('child_process').execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, () => {}); n++; } catch {}
  };
  try {
    const snap = await procsSnapshot();
    const set = dirProcs.get(key);
    if (set && set.size) {
      for (const pid of [...set]) {
        try {
          const e = snap.get(Number(pid));
          if (!e) continue; // uz nebezi
          const cmd = String(e.cmd || '');
          const ours = (e.img === 'node.exe' && /electron-builder|npm/i.test(cmd))
            || ((e.img === 'cmd.exe' || e.img === 'powershell.exe' || e.img === 'pwsh.exe') && /npm install|electron-builder/i.test(cmd))
            || (e.img !== '' && /electron/i.test(e.img) && cmd.toLowerCase().includes(key.toLowerCase()));
          if (!ours) continue;
          killPid(pid);
        } catch {}
      }
    }
    // Sweep napric restartem: builder pro TUTO slozku (cmdline obsahuje cestu projektu).
    const klow = key.toLowerCase();
    for (const [pid, e] of snap) {
      try {
        if (e.img !== 'node.exe') continue;
        const cmd = String(e.cmd || '');
        if (/electron-builder/i.test(cmd) && cmd.toLowerCase().includes(klow)) killPid(pid);
      } catch {}
    }
  } catch {}
  try { dirProcs.delete(key); } catch {}
  if (n) await new Promise(r => setTimeout(r, 800));
  return n;
}
// Kooperativni stop pro build_exe (faze bez child procesu, napr. cekani na zamek):
// rootKey -> {cancelled}. tools:cancel nastavi cancelled=true.
const buildCancelTokens = new Map();
function runCmdLong(cmd, cwd, timeoutMs, cancelKey) {
  return new Promise((resolve) => {
    let child;
    const cid = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const done = (fn) => { try { activeProcs.delete(cid); } catch {} try { fn(); } catch {} };
    try {
      child = execFile(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
        // BEZ verbatim Node escapuje vnitrni uvozovky (\") a cmd /s je pak rozbije:
        // `taskkill /IM "Moje App.exe"` padalo na Invalid argument 'App' a kill nikdy
        // neprobehl (proto vzdy selhalo az DRUHE sestaveni — zamek drzela prezivsi instance).
        // Stejne tak citovana cesta k .cmd binarce. S verbatim jde prikaz doslovne.
        { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'buffer', ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}) },
        (err, stdout, stderr) => {
          done(() => {
            let out = decodeConsole(stdout);
            const errS = decodeConsole(stderr);
            if (errS) out += (out ? '\n[stderr]\n' : '') + errS;
            if (out.length > 12000) out = out.slice(-12000);
            if (err) {
              const code = typeof err.code === 'number' ? `exit ${err.code}` : String(err.code || 'error');
              resolve({ ok: false, code, output: `${out}\n[${code}${err.killed ? ', timeout' : ''}]`.trim() });
            } else {
              resolve({ ok: true, code: 'exit 0', output: (out.trim() || '(no output)').slice(-12000) });
            }
          });
        });
      // Stop tlacitko musi umet zabit i bezici prikaz (jinak agent "furt neco analyzuje").
      // Klic = projektova slozka, at se nerusi nastroje jinemu projektu.
      // PID se pamatuje i pro pristi build (sirotci po Stopu uprostred buildu).
      if (child && child.pid) {
        try { activeProcs.set(cid, { child, pid: child.pid, key: String(cancelKey || cwd || '') }); } catch {}
        try { rememberPid(cancelKey || cwd, child.pid); } catch {}
      }
    } catch (e) {
      done(() => resolve({ ok: false, code: 'error', output: 'Error: ' + (e && e.message) }));
      return;
    }
    void child;
  });
}
// Stop: zabije bezici shell prikazy projektu (cele stromy pres taskkill /T).
// Volá se z IPC tools:cancel. Vraci pocet zabitých procesu.
function cancelToolsFor(rootKey) {
  const key = String(rootKey || '');
  let n = 0;
  for (const [cid, e] of [...activeProcs]) {
    try {
      if (key && e.key !== key) continue;
      n++;
      // Poradi je kriticke: NEJDRIV taskkill /T (cely strom vcetne ping/node vnuku),
      // teprve pak kill primého potomka. Opacne by vnuk osirel, drzel by pipe
      // a callback by se ozval az po jeho konci (namereno 29 s misto ~1 s).
      try { if (e.pid) require('child_process').execFile('taskkill.exe', ['/PID', String(e.pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, () => {}); } catch {}
      const ch = e.child;
      try { activeProcs.delete(cid); } catch {}
      setTimeout(() => { try { if (ch && ch.exitCode === null) ch.kill(); } catch {} }, 800);
    } catch {}
  }
  // Kooperativni stop pro build_exe (faze bez child procesu).
  try {
    for (const [k, tok] of [...buildCancelTokens]) {
      if (!key || k === key) { try { tok.cancelled = true; } catch {} }
    }
  } catch {}
  return { killed: n };
}
function listExeFiles(distDir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(distDir)) {
      if (/\.exe$/i.test(f)) {
        const full = path.join(distDir, f);
        try { const st = fs.statSync(full); if (st.isFile()) out.push({ path: full, size: st.size, mtime: st.mtimeMs }); } catch {}
      }
    }
  } catch {}
  try {
    const unp = path.join(distDir, 'win-unpacked');
    for (const f of fs.readdirSync(unp)) {
      if (/\.exe$/i.test(f)) {
        const full = path.join(unp, f);
        try { const st = fs.statSync(full); if (st.isFile()) out.push({ path: full, size: st.size, mtime: st.mtimeMs, unpacked: true }); } catch {}
      }
    }
  } catch {}
  return out;
}
/* Launch-test: exe se spusti a 4 s musi bezet. Nevydrzi = FAIL s exit kodem.
   Instalacni Setup.exe se nikdy netestuje spustenim (to by rozjelo instalator). */
async function launchTestExe(exePath) {
  const name = path.basename(exePath);
  if (/setup|uninstall/i.test(name)) return { tested: false, reason: 'installer (Setup/Uninstall) se spoustenim netestuje' };
  try { await runCmdLong(`taskkill /IM "${name}" /F`, path.dirname(exePath), 10000); } catch {}
  await new Promise(r => setTimeout(r, 600));
  return new Promise((resolve) => {
    let child;
    try {
      child = require('child_process').spawn(exePath, [], { detached: false, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      resolve({ tested: true, ok: false, output: 'Nespustilo se: ' + (e && e.message) });
      return;
    }
    let done = false;
    const finish = async (ok, output) => {
      if (done) return;
      done = true;
      try { await runCmdLong(`taskkill /PID ${child.pid} /T /F`, path.dirname(exePath), 10000); } catch {}
      resolve({ tested: true, ok, output });
    };
    child.on('error', (e) => finish(false, 'Chyba spusteni: ' + (e && e.message)));
    child.on('exit', (code) => finish(false, `Aplikace se SAMA ukoncila po <4 s (exit ${code}). Hlavni proces spadl - zkontroluj main.js (uncaught exception, loadFile na neexistujici soubor).`));
    setTimeout(() => finish(true, 'Aplikace bezi (4 s test OK).'), 4000);
  });
}
/* Hash stavu projektu pro preskoceni zbytecneho rebuildu. Kdyz se od posledniho
   uspesneho buildu nic nezmenilo, build_exe vrati existujici exe okamzite misto
   10minutoveho npm install + electron-builder naprazdno. */
function hashProjectState(dir, pkgText, extraFiles, target) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update('target:' + String(target || '') + '\n');
  h.update('package.json:\n' + String(pkgText || '') + '\n');
  const files = [...new Set(extraFiles || [])];
  for (const rel of files) {
    try {
      const abs = path.join(dir, rel);
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      h.update('file:' + rel + ':' + st.size + ':' + st.mtimeMs + '\n');
      if (st.size > 0 && st.size <= 1048576) h.update(fs.readFileSync(abs));
    } catch {}
  }
  // Cely strom projektu (mimo node_modules/dist/.git): KAZDA zmena souboru musi
  // zmenit hash, jinak by build_exe preskocil rebuild a vratil stare exe.
  // Jen metadata (cesta+velikost+mtime), max 5000 souboru — rychle a staci to.
  const SKIP_TREE = new Set(['node_modules', 'dist', '.git']);
  try {
    let n = 0;
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (n > 5000) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_TREE.has(e.name)) continue;
          walk(p); continue;
        }
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          n++;
          h.update('tree:' + path.relative(dir, p) + ':' + st.size + ':' + st.mtimeMs + '\n');
        } catch {}
      }
    };
    walk(dir);
  } catch {}
  return h.digest('hex').slice(0, 32);
}
/* Test zamku souboru: otevreni pro zapis selze (EBUSY/EPERM), kdyz soubor drzi
   bezici aplikace, Explorer (nahledy) nebo antivirus. Levne - zadne prejmenovani. */
function isFileLocked(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const fd = fs.openSync(p, 'r+');
    try { fs.closeSync(fd); } catch {}
    return false;
  } catch { return true; }
}
async function execBuildExe(dir, opts) {
  opts = opts || {};
  const log = [];
  const step = (name, ok, detail) => {
    log.push((ok ? '[OK] ' : '[FAIL] ') + name + (detail ? ' - ' + detail : ''));
    return ok;
  };
  const fail = (msg) => ({ ok: false, output: log.join('\n') + '\n\nBUILD SELHAL: ' + msg });
  if (!fs.existsSync(dir)) return fail('Slozka neexistuje: ' + dir);
  const pkgFile = path.join(dir, 'package.json');
  // Klasika: projekt se postavil do PODSLOZKY (scaffold_electron s dir "neco"), ale build
  // bezi v rootu. Misto sucheho "chybi package.json" rovnou rekneme, kde lezi.
  if (!fs.existsSync(pkgFile)) {
    let sub = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        try { if (fs.existsSync(path.join(dir, e.name, 'package.json'))) sub.push(e.name); } catch {}
      }
    } catch {}
    const hint = sub.length === 1
      ? ' Projekt je ale v podslozce "' + sub[0] + '" — presun soubory do rootu (move_file) a zavolej build_exe znovu. Soubory patri PRIMO do vybrane slozky, nova podslozka jen kdyz to uzivatel vyslovne chce.'
      : (sub.length > 1 ? ' Kandidati v podslozkach: ' + sub.slice(0, 5).join(', ') + ' — pracuj v jedne z nich, nebo presun soubory do rootu.' : '');
    return fail('Chybi package.json - nejdriv scaffold_electron nebo napis package.json (main.js + index.html).' + hint);
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); }
  catch (e) { return fail('package.json je rozbity JSON: ' + e.message); }
  const entry = String(pkg.main || 'main.js');
  const entryAbs = path.join(dir, entry);
  if (!fs.existsSync(entryAbs)) return fail('Chybi vstupni soubor ' + entry + ' (package.json -> main).');
  const htmlAbs = path.join(dir, 'index.html');
  if (!fs.existsSync(htmlAbs)) return fail('Chybi index.html.');
  // --- inventura odkazu z index.html ---
  let refs = [];
  try { refs = collectHtmlRefs(fs.readFileSync(htmlAbs, 'utf8')); } catch {}
  step('Inventura odkazu', true, refs.length ? refs.join(', ') : 'zadne lokalni (vse inline)');
  const missing = refs.filter(r => !fs.existsSync(path.join(dir, r)));
  if (missing.length) return fail('Chybi soubory, na ktere odkazuje index.html: ' + missing.join(', ') + '. Napis je (write_file) a zavolej build_exe znovu.');
  step('Vsechny odkazovane soubory existuji', true);
  let dups = [];
  try { dups = findHtmlDuplicates(fs.readFileSync(htmlAbs, 'utf8')); } catch {}
  // --- auto-oprava package.json ---
  const fixed = [];
  pkg.scripts = pkg.scripts || {};
  if (!pkg.scripts.dist) { pkg.scripts.dist = 'electron-builder --win nsis'; fixed.push('scripts.dist'); }
  if (!pkg.scripts.start) { pkg.scripts.start = 'electron .'; fixed.push('scripts.start'); }
  pkg.devDependencies = pkg.devDependencies || {};
  if (!pkg.devDependencies.electron) { pkg.devDependencies.electron = '^33.0.0'; fixed.push('dev electron'); }
  if (!pkg.devDependencies['electron-builder']) { pkg.devDependencies['electron-builder'] = '^25.0.0'; fixed.push('dev electron-builder'); }
  pkg.build = pkg.build || {};
  pkg.build.directories = pkg.build.directories || {};
  if (!pkg.build.directories.output) { pkg.build.directories.output = 'dist'; fixed.push('directories.output'); }
  // Vystup MUSI byt dist — cela pipeline (probe zamku, skip pri beze zmeny,
  // verifikace, BUILD_STATE) pocita jen s nim. Cizi output (release, dist2)
  // by znamenal: build jinam + build_exe hlasi stare dist.
  // (Stalo se: agent prepsal output na release a exe skoncilo mimo dist.)
  else if (pkg.build.directories.output !== 'dist') {
    fixed.push('directories.output ' + pkg.build.directories.output + ' -> dist');
    pkg.build.directories.output = 'dist';
  }
  const wantFiles = new Set([entry, 'index.html', ...refs]);
  try { if (fs.existsSync(path.join(dir, 'preload.js'))) wantFiles.add('preload.js'); } catch {}
  for (const extra of ['src', 'vendor', 'assets', 'public']) {
    try {
      const st = fs.statSync(path.join(dir, extra));
      if (st.isDirectory()) wantFiles.add(extra + '/**/*');
    } catch {}
  }
  try { if (fs.existsSync(path.join(dir, 'styles.css'))) wantFiles.add('styles.css'); } catch {}
  const haveFiles = Array.isArray(pkg.build.files) ? pkg.build.files.slice() : [];
  for (const w of wantFiles) if (!haveFiles.includes(w)) { haveFiles.push(w); fixed.push('files +' + w); }
  if (haveFiles.length) pkg.build.files = haveFiles;
  if (!pkg.build.win) { pkg.build.win = { target: ['nsis'] }; fixed.push('win.target nsis'); }
  if (fixed.length) {
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
    step('package.json opraveno', true, fixed.join(', '));
  } else {
    step('package.json v poradku', true);
  }
  // --- BEZE ZMENY? Preskocit zbytecny 10minutovy rebuild ---
  // Kdyz se od posledniho uspesneho buildu nic nezmenilo, vratime existujici exe
  // okamzite. Zadny npm install, zadny electron-builder, zadny launch-test.
  const BUILD_STATE = '.nlc-build.json';
  let pkgTextNow = '';
  try { pkgTextNow = fs.readFileSync(pkgFile, 'utf8'); } catch {}
  const stateFiles = [entry, 'index.html', ...refs];
  try { if (fs.existsSync(path.join(dir, 'preload.js'))) stateFiles.push('preload.js'); } catch {}
  const curHash = hashProjectState(dir, pkgTextNow, stateFiles, opts.target || '');
  const distDirEarly = path.join(dir, 'dist');
  let skipBuild = false, skipExe = null;
  for (const sp of [path.join(distDirEarly, BUILD_STATE)]) {
    try {
      const stRaw = fs.readFileSync(sp, 'utf8');
      const st = JSON.parse(stRaw);
      if (st && st.hash === curHash && st.exe && fs.existsSync(st.exe)) {
        const est = fs.statSync(st.exe);
        if (est.isFile() && Math.abs(est.size - (st.size || 0)) < 2 && Math.abs(est.mtimeMs - (st.mtime || 0)) < 2000) {
          skipBuild = true; skipExe = st.exe;
          break;
        }
      }
    } catch {}
  }
  if (skipBuild) {
    step('Beze zmeny', true, 'projekt je stejny jako pri poslednim buildu - rebuild preskocen');
    step('EXE aktualni', true, skipExe + ' (' + (fs.statSync(skipExe).size / 1048576).toFixed(1) + ' MB)');
    if (dups.length) log.push('[WARN] Duplicitni odkazy v index.html (soubor se nacte 2x): ' + dups.join(', '));
    log.push('');
    log.push('HOTOVO - 100% (bez rebuildu, usetreno ~10 min): ' + skipExe);
    return { ok: true, output: log.join('\n') };
  }
  // Rucni build mimo build_exe (shell `npm run dist`) nezapise BUILD_STATE —
  // pak by nasledne build_exe stavilo ZNOVU, i kdyz je exe cerstve. Proto zalozni
  // test: je-li nejake exe v dist NOVEJSI nez vsechny zdroje, nic se nezmenilo
  // a rebuild se preskoci (stav se pri tom dopise, takze priste staci primarni test).
  if (!skipBuild) {
    try {
      let maxSrc = 0, nSrc = 0;
      const walkSrc = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (nSrc > 5000) return;
          if (e.name.startsWith('.') && e.name !== '.env') {
            if (e.name === '.git') continue;
          }
          const p = path.join(d, e.name);
          try {
            if (e.isDirectory()) {
              if (SKIP_TREE.has(e.name)) continue;
              walkSrc(p); continue;
            }
            const st = fs.statSync(p);
            if (!st.isFile()) continue;
            nSrc++;
            if (st.mtimeMs > maxSrc) maxSrc = st.mtimeMs;
          } catch {}
        }
      };
      walkSrc(dir);
      let best = null;
      for (const dd of [distDirEarly]) {
        try {
          for (const e of listExeFiles(dd)) {
            if (/setup|uninstall/i.test(path.basename(e.path))) continue;
            if (!best || e.mtime > best.mtime) best = e;
          }
        } catch {}
      }
      if (best && maxSrc && best.mtime > maxSrc + 2000) {
        step('Beze zmeny', true, 'exe je novejsi nez vsechny zdroje (postaveno rucne mimo build_exe) - rebuild preskocen');
        step('EXE aktualni', true, best.path + ' (' + (best.size / 1048576).toFixed(1) + ' MB)');
        try {
          fs.writeFileSync(path.join(distDirEarly, BUILD_STATE),
            JSON.stringify({ hash: curHash, exe: best.path, size: best.size, mtime: best.mtime, time: new Date().toISOString() }), 'utf8');
        } catch {}
        log.push('');
        log.push('HOTOVO - 100% (bez rebuildu, usetreno ~10 min): ' + best.path);
        return { ok: true, output: log.join('\n') };
      }
    } catch {}
  }
  // --- npm install, kdyz je potreba (dist se bez nej nevytvori) ---
  // Rozhoduje OBSAH zavislosti, ne datum package.json — to se meni i pri editaci
  // verzi/skriptu, ktera na node_modules nema vliv. Jinak by se pri kazdem pokusu
  // (treba po padlem buildu) zbytecne preinstalovavalo.
  const nmDir = path.join(dir, 'node_modules');
  const DEPS_STATE = '.nlc-deps.json';
  const depsKey = () => {
    try { return JSON.stringify({ d: (pkg && pkg.dependencies) || {}, dd: (pkg && pkg.devDependencies) || {} }); }
    catch { return ''; }
  };
  let needInstall = !fs.existsSync(path.join(nmDir, 'electron', 'package.json')) || !fs.existsSync(path.join(nmDir, 'electron-builder', 'package.json'));
  // Samotne package.json nestaci — chybi-li spustitelny .bin (napr. po rucnim mazani node_modules),
  // `npx` by potichu stáhnul CIZÍ major verzi builderu a build by padl záhadně.
  // Kontroluje se proto i binárka; spouští se pak přímo lokální binárka, nikdy holé npx.
  if (!needInstall) {
    const localBin = path.join(nmDir, '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
    if (!fs.existsSync(localBin)) needInstall = true;
  }
  try {
    if (!needInstall) {
      const st = JSON.parse(fs.readFileSync(path.join(nmDir, DEPS_STATE), 'utf8'));
      if (!st || st.key !== depsKey()) needInstall = true;
    }
  } catch { needInstall = true; }
  const isCancelled = () => { try { return !!(opts.cancelled && opts.cancelled()); } catch { return false; } };
  const failCancel = () => fail('Zruseno uzivatelem (Stop). Rozdelany build se zahodil, dist zustal jak byl.');
  // Jmena, pod kterymi muze bezet stara instance (dist exe + productName varianty).
  // Pouziva se pro kill i pro overeni — drive se overovala jen jmena z dist a prezivsi
  // proces s jinym jmenem (treba bez mezery) prosel jako "zadny exe nebezi".
  const killNames = new Set();
  try { for (const e of listExeFiles(path.join(dir, 'dist'))) killNames.add(path.basename(e.path)); } catch {}
  try {
    const pn0 = String((pkg.build && pkg.build.productName) || pkg.productName || pkg.name || '').trim();
    if (pn0) { killNames.add(pn0 + '.exe'); killNames.add(pn0.replace(/[^A-Za-z0-9]+/g, '') + '.exe'); }
  } catch {}
  // Sirotci po predchozich buildech (Stop uprostred buildu, padly kill) drzi app.asar
  // a kazdy dalsi build by padl na zamku. Pobijeme je driv, nez cokoliv saha na dist.
  try {
    const orph = await killOwnOrphans(dir);
    if (orph > 0) step('Sirotci po minulych buildech ukonceni', true, orph + '× proces');
  } catch {}
  if (isCancelled()) return failCancel();
  if (isCancelled()) return failCancel();
  if (needInstall) {
    step('npm install potreba', true, 'node_modules chybi nebo se zmenily zavislosti');
    const ins = await runCmdLong('npm install', dir, 600000, dir);
    if (isCancelled()) return failCancel();
    if (!ins.ok) return fail('npm install selhal:\n' + ins.output);
    try { fs.writeFileSync(path.join(nmDir, DEPS_STATE), JSON.stringify({ key: depsKey(), time: new Date().toISOString() }), 'utf8'); } catch {}
    step('npm install', true);
  } else {
    step('node_modules OK', true, 'zavislosti stejne — instalace netreba');
  }
  // --- Zabij bezici instance aplikace (builder jinak neprepise app.asar: "file is used by another process") ---
  // taskkill muze selhat potichu (napr. proces bezi jako SPRAVCE a my ne -> "Access denied").
  // Proto se po killu OVERUJE pres tasklist, jestli proces fakt skoncil. Kdyz prezil
  // a taskkill hlasil odepreni pristupu, nema smysl cekat 60 s — rovnou se rekne proc.
  const deniedKill = new Set();
  const taskkillOne = async (kn) => {
    try {
      const k = await runCmdLong(`taskkill /IM "${kn}" /F`, dir, 10000);
      const o = String((k && k.output) || '');
      if (/access denied|odep[řr]en/i.test(o)) { deniedKill.add(kn); return 'denied'; }
      if (/SUCCESS|ÚSPĚCH/i.test(o)) return 'killed';
      return 'missing';
    } catch { return 'error'; }
  };
  // tasklist je lokalizovany do cestiny ("Nazev bitove kopie"), takze se na nazvy
  // sloupcu neda spolehnout. CSV format je ale vsude stejny: "jmeno.exe","PID",...
  // POZOR: /FI "IMAGENAME eq ..." se nesmi pouzit — pres cmd.exe /s /c se vnitrni
  // uvozovky rozbiji a tasklist hlasi "Invalid argument/option - 'eq'". Misto toho
  // se vypise vsechno a hleda se v tom (vystup ma par desitek radku).
  const procRunning = async (kn) => {
    // findstr predfiltr: plny tasklist ma pres 12 KB a runCmdLong ho orizne,
    // takze by proces mohl chybet. Filtrovany vypis je maly a vejde se vzdy.
    // Presna shoda se overuje v JS vcetne uvozovek ("x.exe" neni "x Setup 1.0.exe").
    // findstr exit 1 = nenasel nic = proces nebezi (neni to chyba).
    // Jmeno se escapuje pro findstr regex (tecka/zavorky v nazvu exe).
    const esc = String(kn).replace(/([.[\]^$*\\])/g, '\\$1');
    try {
      const t = await runCmdLong(`tasklist /FO CSV /NH | findstr /I /C:"${esc}"`, dir, 15000);
      const out = String((t && t.output) || '');
      if (out.toLowerCase().includes('"' + String(kn).toLowerCase() + '"')) return true;
      if (t && t.ok === false && String(t.code || '') === 'exit 1' && !/\[stderr\]/i.test(out)) return false;
      if (t && t.ok === true) return false;
      return true; // nejiste (timeout/chyba) -> konzervativne "asi bezi"
    } catch { return true; }
  };
  let survivors = [];
  try {
    for (const kn of killNames) {
      try { await taskkillOne(kn); } catch {}
    }
    if (killNames.size) step('Bezici instance ukonceny', true, [...killNames].join(', '));
    await new Promise(r => setTimeout(r, 800));
    for (const kn of killNames) {
      try { if (await procRunning(kn)) survivors.push(kn); } catch {}
    }
    // Proces prezil a system odmitl kill (bezi jako spravce) -> 60s cekani by jen
    // zralo kola modelu. Fail hned, s presnym duvodem.
    const deniedSurv = survivors.filter(n => deniedKill.has(n));
    if (deniedSurv.length) {
      return fail('Beziaci proces ' + deniedSurv.join(', ') + ' se nedal ukoncit (system odmitl pristup — proces bezi jako SPRAVCE). Zavri ho rucne ve Spravci uloh, nebo spust NolimitCoder jako spravce a build_exe zavolej znovu. Cekani by nepomohlo, proto se neceka.');
    }
  } catch (e) { if (String((e && e.message) || '').includes('BUILD SELHAL')) throw e; }
  // --- Pockat na odemceni app.asar (Explorer nahled / antivirus / dobihajici proces) ---
  // Slepy build do zamku jen plytva minutami. Nejdriv probe, pak teprve builder.
  // (Sem se dojde, jen kdyz zadny prezivsi proces nebyl zamitnut — jinak by to uz skoncilo vyse.)
  // outName: normalne "dist", pri trvalem zamku bez procesu nouzove "dist2".
  let outName = 'dist';
  try {
    const lockProbe = [
      path.join(dir, 'dist', 'win-unpacked', 'resources', 'app.asar')
    ];
    for (let li = 0; li < 6; li++) {
      const locked = lockProbe.filter(p => isFileLocked(p));
      if (!locked.length) break;
      if (isCancelled()) return failCancel();
      step('Soubor zamcen', true, path.basename(locked[0]) + ' drzi jiny proces - cekam ' + ((li + 1) * 10) + ' s (pokus ' + (li + 1) + '/6)');
      try { for (const kn of killNames) { try { await taskkillOne(kn); } catch {} } } catch {}
      // 10 s cekani po 1 s, at Stop zabere do sekundy (ne az po deseti).
      for (let s = 0; s < 10; s++) {
        await new Promise(r => setTimeout(r, 1000));
        if (isCancelled()) return failCancel();
        if (!lockProbe.some(p => isFileLocked(p))) break;
      }
      if (li === 5 && lockProbe.some(p => isFileLocked(p))) {
        const still = [];
        try {
          for (const kn of killNames) { try { if (await procRunning(kn)) still.push(kn); } catch {} }
        } catch {}
        // Zadne exe nebezi a zamek drzi dal? Typicky docasny scan (Defender prochazi
        // cerstvy build, indexace) — ten sam prejde. Misto padu a slepeho retry kola
        // modelu (kazdy pokus = nove kolo + npm install) se pocka az 4 minuty v jednom
        // volani. Kola modelu se nezrou a build pak rovnou probehne.
        if (!still.length) {
          let extra = 0;
          for (; extra < 8; extra++) {
            step('Soubor porad zamcen (bez procesu)', true, 'ceka se na uvolneni — ' + ((extra + 1) * 30) + ' s (scan to vetsinou pusti sam)');
            for (let s = 0; s < 30; s++) {
              await new Promise(r => setTimeout(r, 1000));
              if (isCancelled()) return failCancel();
              if (!lockProbe.some(p => isFileLocked(p))) break;
            }
            if (!lockProbe.some(p => isFileLocked(p))) break;
          }
          if (!lockProbe.some(p => isFileLocked(p))) {
            step('Soubor odemcen', true, 'scan skoncil, pokracuje se v buildu');
            break;
          }
        }
        // NOUZOVKA dist2: ani po 5 minutach se nepustil a zadny proces nebezi.
        // Misto padu (a slepeho mazani dist modelem) se postavi vedle do dist2 —
        // exe proste vznikne, jen v jine slozce. Stare dist2 se nejdriv smaze.
        if (!still.length) {
          outName = 'dist2';
          step('dist zamcen bez procesu', true, 'staví se nouzově do dist2 (hlavní dist něco drží)');
          try { fs.rmSync(path.join(dir, 'dist2'), { recursive: true, force: true }); } catch {}
          const d2asar = path.join(dir, 'dist2', 'win-unpacked', 'resources', 'app.asar');
          if (fs.existsSync(d2asar) && isFileLocked(d2asar)) {
            outName = 'dist';
            return fail('Zamcene je i zalozni dist2 — obe slozky neco drzi. Zavri okno Exploreru, pockej na konec scanu antiviru a zavolej build_exe znovu.'
              + ' DULEZITE: chyba NENI v kodu — NEUPRAVUJ zadne soubory (ani index.html), nic to nespravi.');
          }
          try {
            pkg.build = pkg.build || {};
            pkg.build.directories = pkg.build.directories || {};
            pkg.build.directories.output = 'dist2';
            fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
            step('Vystup prepojen', true, 'tento build jde do dist2');
          } catch (e) {
            outName = 'dist';
            return fail('Nouzovy dist2 se nedal nastavit: ' + (e && e.message));
          }
          break;
        }
        return fail('Beziaci proces ' + still.join(', ') + ' se nedal ukoncit — zavri ho rucne ve Spravci uloh a zavolej build_exe znovu.'
          + ' DULEZITE: chyba NENI v kodu — NEUPRAVUJ zadne soubory (ani index.html), nic to nespravi.');
      }
    }
  } catch (e) { if (String((e && e.message) || '').includes('BUILD SELHAL')) throw e; }
  // --- PLNY rebuild (do dist, nouzove do dist2 — viz outName vyse) ---
  const target = String(opts.target || '').toLowerCase();
  // VŽDY lokální binárka z node_modules — holé `npx` by při chybějícím .bin potichu
  // stáhlo CIZÍ major verzi builderu (stalo se: 26.15.3 místo 25.x) a build by padl záhadně.
  const localBuilder = path.join(nmDir, '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  if (target && ['nsis', 'portable', 'dir'].includes(target) && !fs.existsSync(localBuilder)) {
    return fail('Chybí lokální electron-builder (.bin) — spusť nejdřív npm install a pak build_exe znovu. (Schválně se nevolá holé npx, to by stáhlo cizí verzi.)');
  }
  const distCmd = target && ['nsis', 'portable', 'dir'].includes(target)
    ? `"${localBuilder}" --win ${target}`
    : 'npm run dist';
  const t0 = Date.now();
  // Retry pri zamku souboru: kdyz builder nemuze prepsat app.asar, protoze stara
  // instance jeste bezi (uzivatel nebo AI ji prave spustila), ukoncime a zkusime znovu.
  let bld = null, bldAttempt = 0;
  if (isCancelled()) return failCancel();
  while (bldAttempt < 3) {
    bldAttempt++;
    bld = await runCmdLong(distCmd, dir, 900000, dir);
    if (isCancelled()) return failCancel();
    if (bld.ok) break;
    const lockErr = /used by another process|EBUSY|EPERM|app\.asar|cannot access|nemá přístup/i.test(String(bld.output || ''));
    if (!lockErr || bldAttempt >= 3) break;
    step('Build zamcen (bezi stara instance)', true, 'pokus ' + bldAttempt + '/3 - ukoncuji a zkousim znovu');
    try {
      try { for (const e of listExeFiles(path.join(dir, 'dist'))) { try { await runCmdLong(`taskkill /IM "${path.basename(e.path)}" /F`, dir, 10000); } catch {} } } catch {}
      const pn2 = String((pkg.build && pkg.build.productName) || pkg.productName || pkg.name || '').trim();
      if (pn2) { try { await runCmdLong(`taskkill /IM "${pn2}.exe" /F`, dir, 10000); } catch {} }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  // (původní volání nahrazeno retry smyčkou výše)
  // package.json se pro dist2 docasne prepsal (output) — vratit, at v nem nezustane bordel.
  if (outName !== 'dist') { try { fs.writeFileSync(pkgFile, pkgTextNow, 'utf8'); step('package.json vracen', true, 'output zase dist'); } catch {} }
  // Plny vystup builderu do souboru — do hlasky se vejde jen kousek, ale priste
  // chceme vedet PRESNE proc to padlo (stalo se: useknuty log skryl pricinu).
  const dumpBuildLog = () => {
    try {
      const dir0 = require('./errlog').logsDir();
      if (!dir0) return '';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const fp = path.join(dir0, 'build-fail-' + stamp + '.log');
      fs.writeFileSync(fp, 'dir: ' + dir + '\ncmd: ' + distCmd + '\nattempts: ' + bldAttempt + '\n\n' + String((bld && bld.output) || ''), 'utf8');
      return fp;
    } catch { return ''; }
  };
  if (!bld.ok) { const fp = dumpBuildLog(); return fail('Build selhal (' + distCmd + '):\n' + bld.output + (fp ? '\n\nPlny vystup je v souboru: ' + fp : '')); }
  step('Build (' + distCmd + ')', true, Math.round((Date.now() - t0) / 1000) + ' s');
  // --- verifikace vystupu (dist, nouzove dist2) ---
  const distDir = path.join(dir, outName);
  if (!fs.existsSync(distDir)) return fail('Build dobehl, ale slozka ' + outName + '/ nevznikla. Konec vystupu buildu:\n' + String(bld.output).slice(-2000));
  const exes = listExeFiles(distDir);
  if (!exes.length) return fail('V ' + outName + '/ neni zadne .exe. Vystup buildu:\n' + String(bld.output).slice(-2000));
  const fresh = exes.filter(e => e.mtime >= t0 - 120000);
  if (!fresh.length) return fail('EXE v ' + outName + '/ je STARE (build nic noveho nevytvoril). Konec vystupu buildu:\n' + String(bld.output).slice(-2000));
  for (const e of fresh) step('EXE cerstve', true, path.basename(e.path) + ' (' + (e.size / 1048576).toFixed(1) + ' MB)');
  // --- asar obsahuje vsechny soubory? (Electron umi cist asar primo pres fs) ---
  const canAsar = !!(process.versions && process.versions.electron);
  const asarBase = path.join(distDir, 'win-unpacked', 'resources', 'app.asar');
  if (canAsar && fs.existsSync(asarBase)) {
    const need = [entry, 'index.html', ...refs].filter((v, i, a) => a.indexOf(v) === i);
    try { if (fs.existsSync(path.join(dir, 'preload.js'))) need.push('preload.js'); } catch {}
    const missingAsar = [];
    for (const r of need) {
      try { if (!fs.existsSync(path.join(asarBase, r))) missingAsar.push(r); } catch { missingAsar.push(r); }
    }
    if (missingAsar.length) return fail('V app.asar chybi: ' + missingAsar.join(', ') + ' (build.files v package.json je neuplny - opraveno, spust build_exe znovu).');
    step('app.asar kompletni', true, need.length + ' souboru overeno');
  } else {
    step('app.asar kontrola preskocena', true, canAsar ? 'asar nenalezen' : 'mimo Electron');
  }
  // --- launch-test ---
  const testExe = fresh.filter(e => e.unpacked && !/setup|uninstall/i.test(path.basename(e.path)))[0]
    || fresh.filter(e => !/setup|uninstall/i.test(path.basename(e.path)))[0];
  if (isCancelled()) return failCancel();
  if (testExe) {
    step('Launch-test', true, path.basename(testExe.path) + ' se spousti na 4 s...');
    const lt = await launchTestExe(testExe.path);
    if (!lt.tested) log.push('[WARN] Launch-test preskocen: ' + lt.reason);
    else if (!lt.ok) return fail('Aplikace se sama zavrela hned po startu:\n' + lt.output + '\nOprav main.js a spust build_exe znovu.');
    else log.push('[OK] Launch-test: ' + lt.output);
  } else {
    log.push('[WARN] Launch-test preskocen - je jen instalator (Setup.exe). Over win-unpacked rucne.');
  }
  if (dups.length) log.push('[WARN] Duplicitni odkazy v index.html (soubor se nacte 2x): ' + dups.join(', '));
  const main = fresh.filter(e => !/setup/i.test(path.basename(e.path)))[0] || fresh[0];
  try {
    const stExe = (main && main.path) || '';
    let stSize = 0, stMtime = 0;
    try { const sst = fs.statSync(stExe); stSize = sst.size; stMtime = sst.mtimeMs; } catch {}
    fs.writeFileSync(path.join(distDir, BUILD_STATE), JSON.stringify({ hash: curHash, exe: stExe, size: stSize, mtime: stMtime, time: new Date().toISOString() }), 'utf8');
  } catch {}
  log.push('');
  if (outName !== 'dist') log.push('[WARN] Hlavni dist byl zamceny, takze se stavilo do dist2. Aplikace je plnohodnotna, jen lezi jinde. Az hlavni dist odemkne (zavri Explorer/scan), priste se stavi zase tam.');
  log.push('HOTOVO - 100%: ' + main.path + ' (' + (main.size / 1048576).toFixed(1) + ' MB)');
  return { ok: true, output: log.join('\n') };
}

async function execTool({ tool, args = {}, root, fullAccess, fallbackDir, openPathFn, timeoutMs, userDataDir, helperExe, helperArgs }) {
  tool = normToolName(tool);
  // shell = ALWAYS administrator (no prompting in the app; the Windows UAC window pops up by itself)
  if (tool === 'shell_admin') tool = 'shell';
  if (tool === 'read') tool = 'read_file';
  args = canonArgs(tool, args || {});
  const hasRoot = root && fs.existsSync(String(root));
  const base = hasRoot ? String(root) : (fallbackDir || root || process.cwd());
  const need = (k, example) => {
    if (args[k] === undefined || args[k] === null || args[k] === '') {
      const got = Object.keys(args || {});
      throw new Error(`Missing parameter: ${k} (got keys: ${got.length ? got.join(', ') : 'none'}). Send e.g. ${example || `{"${k}": "..."}`}.`);
    }
    return args[k];
  };
  // Safety: without a selected folder, nothing is silently written anywhere
  if (!hasRoot && !fullAccess && ['write_file', 'append_file', 'create_dir', 'move_file', 'copy_file', 'delete_file', 'edit_file', 'download_file', 'shell'].includes(tool)) {
    const hay = JSON.stringify(args || {});
    const folded = hay.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const hasAbs = /([a-zA-Z]:[\\/]|\\\\|\/)[a-zA-Z0-9]/i.test(hay);
    const hasKnown = /(documents|dokumenty|desktop|plocha|downloads|stazene|pictures|obrazky|music|hudba|videos|videa)/.test(folded);
    if (!hasAbs && !hasKnown) return { ok: false, output: 'No folder is selected and the target is unclear. Ask the user via question where to save it.' };
  }
  // Portable tools from previous sessions belong in PATH on EVERY call (even after an app restart),
  // otherwise a scan after restart would report previously installed tools as missing.
  await prependPortableBins(userDataDir);
  dlContext = '';
  try {
    if (tool === 'shell') {
      // Shell runs as a normal user, WITHOUT elevation and WITHOUT Windows popups.
      // Approval happens only in the app (Continue / Always continue buttons).
      const rawCmd = String(args.command ?? '').trim();
      if (!rawCmd) throw new Error('Empty command \u2014 call shell AGAIN with a filled-in command.');
      // Destruktivni mazani systemu (rmdir /s /q na Temp/Windows/profil) = nikdy.
      const dguard = destructiveShellGuard(rawCmd);
      if (dguard) return { ok: false, output: dguard };
      // Zabijeni systemovych procesu (explorer, dwm, konzole, nase appka) = nikdy.
      const cguard = criticalProcGuard(rawCmd);
      if (cguard) return { ok: false, output: cguard };
      // Zápis obsahu souboru přes shell = jistá chyba (limit 8191 zn., here-string terminátor).
      const guard = shellFileWriteGuard(rawCmd);
      if (guard) {
        return {
          ok: false,
          output: 'ZAMÍTNUTO — ' + guard + '\n\n'
            + 'Správně: write_file { "path": "index.html", "content": "<!DOCTYPE html>…" }\n'
            + 'shell používej jen na spuštění příkazů (npm, git, dir, mkdir…).'
        };
      }
      const cmd = rawCmd; // normalization per backend happens in runCmdKind
      let cwd = base;
      if (args.workdir) {
        const w = resolveTarget(base, args.workdir, fullAccess);
        if (!fs.existsSync(w)) throw new Error('workdir does not exist: ' + w);
        cwd = w;
      }
      const tmo = Math.min(Math.max(parseInt(args.timeout) || 120000, 1000), 900000);
      if (!fs.existsSync(cwd)) cwd = os.homedir(); // the folder may have disappeared in the meantime → do not crash
      // DEFINITIVA: žádný segment nesmí spustit neexistující GUI cíl (systémový dialog).
      // Kontroluje se PŘED instalacemi i backendy — nic se nespustí, vrátí se čistá chyba.
      const badSeg = findBadGuiTarget(cmd, cwd);
      if (badSeg) {
        return { ok: false, output: 'Error: file does not exist, not launching (no system dialog): ' + badSeg };
      }
      // Before running, check what the command needs and auto-install what is missing.
      let autoNotes = [];
      if (fullAccess) {
        try {
          const installed = await ensureForShell(cmd, { userDataDir, root: base });
          for (const r of installed) if (r.ok) autoNotes.push(`${r.label || r.id} (${envHow(r)})`);
        } catch {}
      }
      let be = String(args.backend || 'auto').toLowerCase();
      if (!['cmd', 'powershell', 'pwsh', 'auto'].includes(be)) be = 'auto';
      /* Auto = hádat dialekt podle syntaxe. cmd.exe NEROZUMÍ `;` jako oddělovači příkazů
         (to umí PowerShell) → "node -v; if exist …" spadne jako "node: bad option: -v;",
         protože `;` zůstane v argumentu. Stejně `if (…)` je PowerShell a `if exist` je cmd.
         Když příkaz vypadá na jiný shell, dáme mu přednost; jinak zkusí všechny. */
      const order = be === 'auto' ? preferredShellOrder(cmd) : [be];
      const tried = [];
      let last = null;
      for (const kind of order) {
        // Okenní appka: odpojeně, hned zpátky (jinak čekání visí do zavření okna).
        // Cíl musí existovat — jinak by cmd/start ukázal SYSTÉMOVÝ dialog.
        if (kind === 'cmd' && isGuiLaunch(cmd)) {
          const gt = guiTarget(cmd);
          if (gt && !guiTargetExists(gt, cwd)) {
            return { ok: false, output: 'Error: file does not exist, not launching (no system dialog): ' + gt };
          }
          const gd = await runDetached(cmd, cwd);
          gd.output += '\n[backend: cmd — spuštěno odpojeně]';
          if (autoNotes.length) gd.output += '\n[automatically installed before running: ' + autoNotes.join(', ') + ']';
          return gd;
        }
        // Stejná ochrana před SYSTÉMOVÝM dialogem i pro elevovanou cestu
        // (helper spouští holé cmd bez kontrol).
        if (isGuiLaunch(cmd)) {
          const gt0 = guiTarget(cmd);
          if (gt0 && !guiTargetExists(gt0, cwd)) {
            return { ok: false, output: 'Error: file does not exist, not launching (no system dialog): ' + gt0 };
          }
        }
        // Příkazy, co potřebují administrátora (zápis do Windows, služby, registry…)
        // pošleme do elevovaného helperu — jedno UAC při startu, pak už bez otázek.
        if (helperExe && needsElevation(cmd)) {
          try {
            if (await ensureElevatedHelper({ exe: helperExe, extraArgs: helperArgs })) {
              const er = await elevRun(cmd, cwd, tmo);
              if (er && !/^\[helper\]/i.test(String(er.output || ''))) {
                er.output += '\n[run as administrator]';
                if (autoNotes.length) er.output += '\n[automatically installed before running: ' + autoNotes.join(', ') + ']';
                return er;
              }
            }
          } catch {}
        }
        const r = await runCmdKind(kind, cmd, cwd, tmo, base);
        tried.push(kind);
        if (r.launched === false) continue;
        if (!r.incompatible) {
          if (tried.length > 1) r.output += '\n[backend: ' + kind + ' \u2014 switched, it did not work elsewhere]';
          if (autoNotes.length) r.output += '\n[automatically installed before running: ' + autoNotes.join(', ') + ']';
          return r;
        }
        last = r;
      }
      const lr = last || { ok: false, output: 'No terminal is available.' };
      lr.output += '\n[tried: ' + tried.join(', ') + ']';
      if (autoNotes.length) lr.output += '\n[automatically installed before running: ' + autoNotes.join(', ') + ']';
      return lr;
    }
    if (tool === 'write_file') {
      const abs = resolveTarget(base, need('path', '{"path": "file.txt", "content": "..."}'), fullAccess);
      const bjw = backupJunkGuard(abs); if (bjw) return { ok: false, output: 'ZAMÍTNUTO — ' + bjw };
      if (typeof args.content !== 'string') throw new Error('Missing content');
      // Ochrana proti useknutému streamu — KONTROLA PŘED ZÁPISEM:
      // hotový soubor se nesmí přepsat půlkou obsahu (dřív se obsah nejdřív
      // napsal a pak teprve hlásil, takže vznikl rozbitý soubor).
      const cut = truncatedCodeReason(args.content, abs);
      if (cut) {
        const exists = await fs.promises.stat(abs).then(() => true).catch(() => false);
        if (exists) {
          return { ok: false, output: 'ODMÍTNUTO — obsah je NEDOKONČENÝ (' + cut + ') a soubor už existuje, ' +
            'takže původní verze zůstala zachována. Pošli celý obsah ZNOVU, najednou a s uzavřenými ' +
            'závorkami/bloky (v případě HTML s uzavřenou poslední značkou).' };
        }
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, args.content, 'utf-8');
        return { ok: false, output: 'POZOR: soubor byl NEDOKONČENÝ (' + cut + '). Zapsáno jako rozpracované — ' +
          'doplň chybějící závorky/závěrečný blok a přepiš soubor ZNOVU celý, najednou a bez useknutí.' };
      }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, args.content, 'utf-8');
      return { ok: true, output: `OK: wrote ${args.content.length} chars \u2192 ${abs}` };
    }
    if (tool === 'append_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const bja = backupJunkGuard(abs); if (bja) return { ok: false, output: 'ZAMÍTNUTO — ' + bja };
      if (typeof args.content !== 'string') throw new Error('Missing content');
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.appendFile(abs, args.content, 'utf-8');
      return { ok: true, output: `OK: appended ${args.content.length} chars \u2192 ${abs}` };
    }
    if (tool === 'edit_file') {
      // exact edit: oldString must match exactly once (otherwise an error / more context is needed)
      const abs = resolveTarget(base, need('path'), fullAccess);
      const oldS = need('oldString', '{"path": "...", "oldString": "...", "newString": "..."}');
      if (typeof args.newString !== 'string') throw new Error('Missing newString');
      const txt = await fs.promises.readFile(abs, 'utf-8');
      const count = txt.split(oldS).length - 1;
      if (count === 0) throw new Error('oldString not found in the file.');
      if (count > 1 && !args.replaceAll) throw new Error(`oldString found ${count}x \u2014 send more context, or replaceAll: true.`);
      const next = args.replaceAll ? txt.split(oldS).join(args.newString) : txt.replace(oldS, args.newString);
      await fs.promises.writeFile(abs, next, 'utf-8');
      return { ok: true, output: `OK: edited (${args.replaceAll ? count + ' occurrences' : '1 occurrence'}) \u2192 ${abs}`, diff: diffLines(txt, next) };
    }
    if (tool === 'read_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const st = await fs.promises.stat(abs);
      if (st.size > 40000) throw new Error('File is too large (40 KB limit)');
      const content = await fs.promises.readFile(abs, 'utf-8');
      return { ok: true, output: content.slice(0, 40000) };
    }
    if (tool === 'list_dir') {
      const abs = resolveTarget(base, args.path || '.', fullAccess);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const out = entries.slice(0, 200)
        .map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
      return { ok: true, output: out || '(empty folder)' };
    }
    if (tool === 'glob_file') {
      const rx = resolveTarget(base, args.dir || '.', fullAccess);
      const hits = await globWalk(rx, args.pattern || '**', fullAccess);
      return { ok: true, output: hits.length ? hits.join('\n') : '(nothing found)' };
    }
    if (tool === 'create_dir') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const bjc = backupJunkGuard(abs); if (bjc) return { ok: false, output: 'ZAMÍTNUTO — ' + bjc };
      await fs.promises.mkdir(abs, { recursive: true });
      return { ok: true, output: `OK: folder created \u2192 ${abs}` };
    }
    if (tool === 'move_file') {
      const from = resolveTarget(base, need('from'), fullAccess);
      const to = resolveTarget(base, need('to'), fullAccess);
      const bjcm = backupJunkGuard(to); if (bjcm) return { ok: false, output: 'ZAMÍTNUTO — ' + bjcm };
      if (!fs.existsSync(from)) throw new Error('Source does not exist: ' + from);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      const bjcp = backupJunkGuard(to); if (bjcp) return { ok: false, output: 'ZAMÍTNUTO — ' + bjcp };
      await fs.promises.rename(from, to);
      return { ok: true, output: `OK: moved ${from} \u2192 ${to}` };
    }
    if (tool === 'copy_file') {
      const from = resolveTarget(base, need('from'), fullAccess);
      const to = resolveTarget(base, need('to'), fullAccess);
      if (!fs.existsSync(from)) throw new Error('Source does not exist: ' + from);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(from, to);
      return { ok: true, output: `OK: copied ${from} \u2192 ${to}` };
    }
    if (tool === 'delete_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (!fs.existsSync(abs)) throw new Error('Does not exist: ' + abs);
      await fs.promises.rm(abs, { recursive: false, force: true });
      return { ok: true, output: `OK: deleted ${abs}` };
    }
    if (tool === 'file_info') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const st = await fs.promises.stat(abs);
      return { ok: true, output: `${abs}\ntype: ${st.isDirectory() ? 'folder' : 'file'}\nsize: ${st.size} B\nmodified: ${st.mtime.toLocaleString('en-US')}` };
    }
    if (tool === 'search_files') {
      const pat = String(need('pattern'));
      const start = resolveTarget(base, args.dir || '.', fullAccess);
      const ext = args.ext ? '.' + String(args.ext).replace(/^\./, '').toLowerCase() : null;
      const hits = [];
      let scanned = 0;
      const walk = async (dir) => {
        if (hits.length > 40 || scanned > 300) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length > 40 || scanned > 300) return;
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          try {
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name)) continue;
              await walk(full);
            } else if (e.isFile()) {
              if (ext && path.extname(e.name).toLowerCase() !== ext) continue;
              if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
              // ASYNC — na sitovem disku (Z: WebDAV) syncRead souboru = stovky ms.
              // 300 souboru po synchronnim cteni = 39 sekund zamrzleho okna.
              const st = await fs.promises.stat(full);
              if (st.size > 100000) continue;
              scanned++;
              const txt = await fs.promises.readFile(full, 'utf-8');
              txt.split('\n').forEach((ln, i) => {
                if (hits.length < 40 && ln.toLowerCase().includes(pat.toLowerCase())) {
                  hits.push(`${path.relative(start, full)}:${i + 1}: ${ln.trim().slice(0, 160)}`);
                }
              });
            }
          } catch {}
        }
      };
      await walk(start);
      return { ok: true, output: hits.length ? hits.join('\n') : '(nothing found)' };
    }
    if (tool === 'open_path') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (!fs.existsSync(abs)) throw new Error('Does not exist: ' + abs);
      if (openPathFn) openPathFn(abs);
      return { ok: true, output: `OK: opened in system \u2192 ${abs}` };
    }
    if (tool === 'show_panel') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (!fs.existsSync(abs)) throw new Error('Does not exist: ' + abs);
      return { ok: true, output: `OK: show in side panel \u2192 ${abs}` };
    }
    if (tool === 'scaffold_electron') {
      // A reliable Electron project start: a working FRAMELESS skeleton (package.json + main.js + preload.js + index.html).
      // No native Windows frame/menu — custom titlebar in index.html. The model then writes the code,
      // runs npm install (timeout!) and build — see the EXE recipe in the prompt.
      const dir = resolveTarget(base, need('dir', '{"dir": "my-app", "name": "My App"}'), fullAccess);
      const name = String(args.name || 'My App').slice(0, 60);
      const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-app';
      fs.mkdirSync(dir, { recursive: true });
      const pkg = {
        name: slug, version: '1.0.0', description: name, main: 'main.js',
        scripts: { start: 'electron .', dist: 'electron-builder --win --dir' },
        devDependencies: { electron: '^33.0.0', 'electron-builder': '^25.0.0' },
        build: { appId: `com.nolimit.${slug}`, productName: name, directories: { output: 'dist' }, files: ['main.js', 'preload.js', 'index.html'], win: { target: 'dir' } }
      };
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dir, 'main.js'),
        `const { app, BrowserWindow, Menu, ipcMain } = require('electron');\nconst path = require('path');\nlet w;\napp.whenReady().then(() => {\n  w = new BrowserWindow({ width: 1000, height: 700, backgroundColor: '#101010', frame: false, titleBarStyle: 'hidden', autoHideMenuBar: true, webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });\n  w.loadFile(path.join(__dirname, 'index.html'));\n});\nMenu.setApplicationMenu(null);\nipcMain.on('win:min', () => { try { w.minimize(); } catch {} });\nipcMain.on('win:max', () => { try { w.isMaximized() ? w.unmaximize() : w.maximize(); } catch {} });\nipcMain.on('win:close', () => { try { w.close(); } catch {} });\napp.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });\n`, 'utf-8');
      fs.writeFileSync(path.join(dir, 'preload.js'),
        `const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('win', {\n  min: () => ipcRenderer.send('win:min'),\n  max: () => ipcRenderer.send('win:max'),\n  close: () => ipcRenderer.send('win:close')\n});\n`, 'utf-8');
      fs.writeFileSync(path.join(dir, 'index.html'),
        `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>${name}</title><style>\n.titlebar{-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;background:#0b0b0e;color:#eee;font:600 12px sans-serif;letter-spacing:.08em}\n.titlebar .sp{flex:1}\n.titlebar button{-webkit-app-region:no-drag;background:transparent;border:none;color:#eee;font-size:13px;width:34px;height:26px;border-radius:6px;cursor:pointer}\n.titlebar button:hover{background:#ffffff22}\n</style></head>\n<body style="background:#101010;color:#eee;font-family:sans-serif;margin:0">\n<div class="titlebar"><span>${name}</span><span class="sp"></span><button id="tbMin">_</button><button id="tbMax">\u25a1</button><button id="tbClose">\u2715</button></div>\n<div style="padding:16px"><h1>${name}</h1>\n<p>App ready.</p></div>\n<script>\ntbMin.onclick=()=>window.win.min();tbMax.onclick=()=>window.win.max();tbClose.onclick=()=>window.win.close();\n</script>\n</body>\n</html>\n`, 'utf-8');
      return { ok: true, output: `OK: frameless skeleton "${name}" in ${dir}\nFiles: package.json, main.js, preload.js, index.html (no native Windows frame, custom titlebar)\nNext step: shell "npm install" (timeout 600000), then "npm run dist" (timeout 600000).` };
    }
    if (tool === 'build_exe') {
      // Kompletni pipeline EXE: inventura -> oprava package.json -> npm install -> PLNY rebuild -> verifikace -> launch-test.
      // Vzdy se vsechno prebuildi, dist se vytvori automaticky, kdyz chybi.
      const dir = base;
      const target = String(args.target || '').toLowerCase();
      if (target && !['nsis', 'portable', 'dir'].includes(target)) throw new Error('target musi byt nsis, portable nebo dir (nebo vynechat).');
      // Token pro kooperativni Stop (build_exe ma faze bez child procesu). tools:cancel ho nastavi.
      const btok = { cancelled: false };
      try { buildCancelTokens.set(String(dir), btok); } catch {}
      try {
        return await execBuildExe(dir, { target, cancelled: () => { try { return !!btok.cancelled; } catch { return false; } } });
      } finally {
        try { if (buildCancelTokens.get(String(dir)) === btok) buildCancelTokens.delete(String(dir)); } catch {}
      }
    }
if (tool === 'web_fetch') {
      if (!/^https?:\/\//i.test(String(args.url || ''))) throw new Error('URL must start with http(s)://');
      return await fetchText(args.url, timeoutMs || 15000);
    }
    if (tool === 'web_search') {
      const q = String(need('query', '{"query": "nodejs download"}')).trim();
      if (!q) throw new Error('Empty query');
      const html = await fetchHtml('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), 20000);
      if (!html) throw new Error('Search failed (network).');
      const out = [];
      const re = /<a[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*class='result-link'>([^<]{3,120})<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 8) {
        let url;
        try { url = decodeURIComponent(m[1]); } catch { continue; }
        const title = m[2].replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        out.push(`${out.length + 1}. ${title}\n   ${url}`);
      }
      if (!out.length) throw new Error('Nothing found.');
      return { ok: true, output: out.join('\n') };
    }
    if (tool === 'download_file') {
      const url = String(need('url', '{"url": "https://\u2026", "to": "file.zip"}'));
      if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://');
      const toRaw = args.to || args.path || ('downloaded-' + Date.now() + '.bin');
      const abs = resolveTarget(base, toRaw, fullAccess);
      const bjdl = backupJunkGuard(abs); if (bjdl) return { ok: false, output: 'ZAMÍTNUTO — ' + bjdl };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const dl = await downloadFile(url, abs, 300000);
      if (!dl.ok) {
        try { fs.rmSync(abs, { force: true }); } catch {}
        throw new Error(`Download failed (${dl.error})`);
      }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      return { ok: true, output: `OK: downloaded (${(size / 1048576).toFixed(1)} MB) \u2192 ${abs}` };
    }
    if (tool === 'env_check' || tool === 'env_scan') {
      const req = String(args.request || args.text || args.what || '');
      const scan = await scanEnv({ root: base, request: req, force: !!(args.rescan || args.force) });
      return { ok: true, output: envReportShort(scan), data: scan };
    }
    if (tool === 'env_prepare') {
      const req = String(args.request || args.text || args.what || '');
      const before = await scanEnv({ root: base, request: req, force: !!(args.rescan || args.force) });
      const wanted = [];
      if (Array.isArray(args.ids)) wanted.push(...args.ids);
      if (args.id) wanted.push(String(args.id));
      const todo = wanted.length ? wanted : before.missing;
      if (!todo.length) {
        return { ok: true, output: envReportShort(before) + '\n\nEverything needed is already on this PC \u2014 installing nothing.', data: { before, after: before, results: [], missing: [] } };
      }
      const results = await ensureTools(todo, { userDataDir, heavy: !!args.heavy, dryRun: !!args.dryRun });
      const after = await scanEnv({ root: base, request: req, force: true });
      const failed = results.filter(r => !r.ok && !r.already && !r.manual);
      return { ok: after.missing.length === 0 && failed.length === 0, output: (args.dryRun ? 'PLAN (preview only, nothing is installed):\n' : '') + envActionReport(after, results), data: { before, after, results, tools: after.tools, missing: after.missing } };
    }
    if (tool === 'env_install') {
      const rawIds = [];
      if (Array.isArray(args.ids)) rawIds.push(...args.ids);
      if (typeof args.id === 'string') rawIds.push(...args.id.split(/[,;\s]+/));
      if (!rawIds.length && Array.isArray(args.tools)) rawIds.push(...args.tools);
      const list = rawIds.length ? rawIds : Object.keys(TOOLCHAINS);
      if (!fullAccess) throw new Error('Installation needs Full PC access (Settings).');
      const results = await ensureTools(list, { userDataDir, heavy: !!args.heavy, dryRun: !!args.dryRun });
      const after = await scanEnv({ root: base, force: true });
      const failed = results.filter(r => !r.ok && !r.already && !r.manual);
      return { ok: failed.length === 0, output: (args.dryRun ? 'PLAN (preview only, nothing is installed):\n' : '') + envActionReport(after, results), data: { results, tools: after.tools, missing: after.missing } };
    }
    return { ok: false, output: `I do not have this tool. Use: shell, write_file, append_file, edit_file, read_file, list_dir, glob_file, create_dir, move_file, copy_file, delete_file, file_info, search_files, open_path, show_panel, close_app, web_fetch, env_scan, env_prepare, env_install.` };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

// ===== Persistent elevated helper: 1x UAC per session, then quiet =====
// Instead of UAC on every command, one elevated instance runs (our own exe
// with --elevated-helper), connected to the app via a pipe and executing shells.
const elev = { server: null, sock: null, seq: 0, pending: new Map(), connecting: null };
function elevPipeName() {
  return '\\\\.\\pipe\\nl-elev-' + process.pid + '-' + Math.floor(Math.random() * 1e9).toString(36);
}
function elevSend(obj) {
  try {
    if (elev.sock && !elev.sock.destroyed) elev.sock.write(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') + '\n');
  } catch {}
}
function elevKill() {
  try { if (elev.sock) elev.sock.destroy(); } catch {}
  try { if (elev.server) elev.server.close(); } catch {}
  elev.sock = null;
  elev.server = null;
  for (const [, p] of elev.pending) { try { p.resolve({ ok: false, output: 'Elevated helper has ended.' }); } catch {} }
  elev.pending.clear();
}
async function ensureElevatedHelper({ exe, extraArgs }) {
  if (elev.sock && !elev.sock.destroyed) return true;
  if (elev.connecting) return elev.connecting;
  elev.connecting = (async () => {
    try {
      const pipeName = elevPipeName();
      const connected = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        const server = net.createServer((sock) => {
          elev.sock = sock;
          let buf = '';
          sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let msg = null;
              try { msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8')); } catch { continue; }
              if (msg && msg.hello) { done(true); continue; }
              const p = msg && elev.pending.get(msg.id);
              if (p) { elev.pending.delete(msg.id); try { p.resolve({ ok: !!msg.ok, output: String(msg.output || '') }); } catch {} }
            }
          });
          sock.on('close', () => { if (elev.sock === sock) elev.sock = null; });
          sock.on('error', () => {});
        });
        server.on('error', () => done(false));
        elev.server = server;
        server.listen(pipeName, () => {
          const esc = (s) => String(s).replace(/'/g, "''");
          // own exe elevated with the helper flag (1x UAC); no windows
          const al = [...(extraArgs || []), '--elevated-helper', pipeName].map(a => `'${esc(a)}'`).join(',');
          execFile('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
              `Start-Process -FilePath '${esc(exe)}' -ArgumentList ${al} -Verb RunAs -WindowStyle Hidden`],
            { windowsHide: true }, () => {});
          setTimeout(() => done(!!(elev.sock && !elev.sock.destroyed)), 60000);
        });
      });
      if (!connected) { elevKill(); return false; }
      return true;
    } catch { elevKill(); return false; }
    finally { elev.connecting = null; }
  })();
  return elev.connecting;
}
function elevRun(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    if (!elev.sock || elev.sock.destroyed) { resolve({ ok: false, output: 'Helper is not running.' }); return; }
    const id = ++elev.seq;
    const to = setTimeout(() => {
      elev.pending.delete(id);
      resolve({ ok: false, output: 'Elevated command timeout.' });
    }, Math.min(Math.max(parseInt(timeoutMs) || 120000, 1000), 900000) + 15000);
    elev.pending.set(id, { resolve: (r) => { clearTimeout(to); resolve(r); } });
    elevSend({ id, cmd: String(cmd), cwd: String(cwd), timeout: timeoutMs });
  });
}
// Smart shell: via the helper without UAC windows, otherwise via the legacy path (UAC per command)
async function runShellSmart({ cmd, cwd, timeoutMs, helperExe, helperArgs }) {
  if (helperExe) {
    try {
      if (await ensureElevatedHelper({ exe: helperExe, extraArgs: helperArgs })) return await elevRun(cmd, cwd, timeoutMs);
    } catch {}
  }
  return await runCmdAdmin(cmd, cwd, timeoutMs);
}
function helperState() {
  return !!(elev.sock && !elev.sock.destroyed);
}
module.exports = {
  BLOCKED_PREFIXES, SKIP_DIRS, TEXT_EXT, COMPILERS, TOOLCHAINS, TOOL_GROUPS, TOOL_ALIAS, CMD_TOOL,
  normToolName, foldKey, knownFolders, resolveTarget, canonArgs, splitArgs, normalizeShell, preferredShellOrder,
  runCmd, runArgv, runCmdAdmin, globWalk, fetchText, diffLines, execTool, cancelToolsFor, killOwnOrphans, hashProjectState,
  scanEnv, envReport, ensureTools, ensureForShell, detectProject, detectIntent, requiredForCommand, resolveNeed, installTool,
  setProgressHook, cancelDownload, dbgLog,
  execBuildExe, collectHtmlRefs, findHtmlDuplicates, launchTestExe, listExeFiles, runCmdLong,
  ensureElevatedHelper, elevRun, runShellSmart, helperState, truncatedCodeReason
};
