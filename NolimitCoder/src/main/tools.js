// NolimitCoder tools — kompletní sada nástrojů (bash/read/write/edit/glob/grep/env)
// Cisty node modul bez electron závislostí (testovatelný). Volá ho main.js pres IPC.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const net = require('net');

/* ===== AI debug log (dist/ai-debug.log) — diagnostika chování agenta =====
   Píše se sem každé kolo smyčky, každý nástroj, každý request na AI.
   Soubor rotuje při 8 MB. Vše v try/catch — logování nikdy nesmí nic rozbít. */
let dbgFile = '';
let dbgWrites = 0;
function dbgFilePath() {
  if (dbgFile) return dbgFile;
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
    fs.appendFileSync(f, `[${new Date().toISOString()}] [${tag}] ${json}\n`);
  } catch {}
}

const BLOCKED_PREFIXES = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', '/etc/', '/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
const TEXT_EXT = new Set(['.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.json', '.py', '.html', '.css', '.c', '.cpp', '.h', '.java', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.ps1', '.vue', '.svelte']);

// Kompilátory/runtime: najdi v PATH i mimo něj, a když chybí,
// doinstaluj přes winget, jinak portable z internetu do userData/tools.
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
const TOOL_GROUPS = { cpp: { label: 'C/C++ kompilátor', prefer: ['msvc', 'gcc'], install: ['gcc'] } };
// Balíčkové manažery jako druhá instance (některá PC nemá winget, ale má choco/scoop)
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
function resolveTarget(root, p, fullAccess) {
  const raw = String(p || '');
  let abs;
  if (path.isAbsolute(raw)) {
    abs = path.normalize(raw);
  } else {
    const segs = raw.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
    const hit = segs.length ? knownFolders()[foldKey(segs[0])] : null;
    abs = hit ? path.join(hit, ...segs.slice(1)) : path.resolve(root, raw);
  }
  const low = abs.toLowerCase();
  if (BLOCKED_PREFIXES.some(b => low === b.replace(/\/$/, '') || low.startsWith(b))) {
    throw new Error('Systémová složka je zakázaná: ' + abs);
  }
  if (!fullAccess) {
    const r = path.resolve(root);
    const inProj = abs === r || abs.startsWith(r + path.sep);
    if (!inProj) {
      const userOk = Object.entries(knownFolders()).some(([k, v]) => {
        if (k === 'home' || k === 'domu') return false;
        const kr = path.resolve(v);
        return abs === kr || abs.startsWith(kr + path.sep);
      });
      if (!userOk) throw new Error('Mimo složku projektu (povoleny jsou ještě Dokumenty/Plocha/Stažené…, nebo zapni Full přístup v Nastavení): ' + abs);
    }
  }
  return abs;
}
// Model občas pošle parametr pod jiným jménem (file, filename…) — sjednoť
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
// Modely často píšou unixové příkazy i na Windows + chytré uvozovky/pomlčky.
// Přelož na cmd.exe ekvivalenty, ať to funguje bez chyby.
function normalizeShell(cmd, light) {
  let c = String(cmd || '');
  c = c.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-').replace(/ /g, ' ');
  if (light || process.platform !== 'win32') return c;
  const parts = c.split(/(\s*&&\s*|\s*\|\|\s*|;\s*)/);
  const map1 = { pwd: 'cd', clear: 'cls', ls: 'dir', cat: 'type', cp: 'copy', mv: 'move', touch: 'type nul >' };
  return parts.map(seg => {
    if (/^\s*(&&|\|\||;)\s*$/.test(seg)) return seg;
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
// Konzole píše česky v OEM (cp852) — Node to neumí dekódovat, takže vlastní tabulka (empiricky ověřeno).
const OEM_CZ = {0xa0:'á',0x9f:'č',0xd4:'ď',0x82:'é',0xd8:'ě',0xa1:'í',0xe5:'ň',0xa2:'ó',0xfd:'ř',0xe7:'š',0x9c:'ť',0xa3:'ú',0x85:'ů',0xec:'ý',0xa7:'ž',0xb5:'Á',0xac:'Č',0xd2:'Ď',0x90:'É',0xb7:'Ě',0xd6:'Í',0xd5:'Ň',0xe0:'Ó',0xfc:'Ř',0xe6:'Š',0x9b:'Ť',0xe9:'Ú',0xde:'Ů',0xed:'Ý',0xa6:'Ž'};
function decodeConsole(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  let s = '';
  for (const byte of b) s += byte < 0x80 ? String.fromCharCode(byte) : (OEM_CZ[byte] || String.fromCharCode(byte));
  return s;
}
function runCmd(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = execFile(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        let out = decodeConsole(stdout);
        const errS = decodeConsole(stderr);
        if (errS) out += (out ? '\n[stderr]\n' : '') + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + '\n… (výstup zkrácen)';
        if (err) {
          const code = typeof err.code === 'number' ? `exit ${err.code}` : String(err.code || 'error');
          resolve({ ok: err.killed ? false : false, output: `${out}\n[${code}${err.killed ? ', timeout' : ''}]`.trim() });
        } else {
          resolve({ ok: true, output: (out.trim() || '(bez výstupu)') + '\n[exit 0]' });
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
// Spuštění bez shellu (žádné parsování uvozovek): pro tar/7z, kde cmd /s /c rozbíjí cesty v uvozovkách.
function runArgv(exe, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(exe, args || [],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        let out = decodeSmart(stdout);
        const errS = decodeSmart(stderr);
        if (errS) out += (out ? '\n[stderr]\n' : '') + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + '\n… (výstup zkrácen)';
        if (err) {
          const code = typeof err.code === 'number' ? `exit ${err.code}` : String(err.code || 'error');
          resolve({ ok: false, output: `${out}\n[${code}${err.killed ? ', timeout' : ''}]`.trim() });
        } else resolve({ ok: true, output: (out.trim() || '(bez výstupu)') + '\n[exit 0]' });
      });
    void child;
  });
}
function runCmdKind(kind, cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const lite = kind === "powershell" || kind === "pwsh";
    const c2 = normalizeShell(cmd, lite);
    const spec = kind === "powershell"
      ? { exe: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", c2] }
      : kind === "pwsh"
        ? { exe: "pwsh.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", c2] }
        : { exe: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: process.platform === "win32" ? ["/d", "/s", "/c", c2] : ["-c", c2] };
    const child = execFile(spec.exe, spec.args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) => {
        if (err && (err.code === "ENOENT" || /not found/i.test(err.message || ""))) { resolve({ ok: false, output: "", launched: false }); return; }
        let out = decodeSmart(stdout);
        const errS = decodeSmart(stderr);
        if (errS) out += (out ? "\n[stderr]\n" : "") + errS;
        if (out.length > 20000) out = out.slice(0, 20000) + "\n… (výstup zkrácen)";
        const incompatible = kind === "cmd"
          ? /is not recognized as an internal or external command|není rozpoznán|neni rozpoznan/i.test(out)
          : /is not recognized as the name of a cmdlet|není rozpoznán|neni rozpoznan/i.test(out);
        if (err && err.killed) { resolve({ ok: false, output: (out + "\n[timeout]").trim(), launched: true, incompatible: false }); return; }
        if (err && typeof err.code === "number") { resolve({ ok: false, output: (out + "\n[exit " + err.code + "]").trim(), launched: true, incompatible }); return; }
        if (err) { resolve({ ok: false, output: (out + "\n[" + String(err.code || "error") + "]").trim(), launched: true, incompatible }); return; }
        resolve({ ok: true, output: (out.trim() || "(bez výstupu)") + "\n[exit 0]", launched: true, incompatible });
      });
    void child;
  });
}
// Vždy zakázané (rozbití PC). Kontroluje se JEN název příkazu (první token),
// aby to neblokovalo nevinné věci jako "npm run format".
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
const SANDBOX_BLOCKED_CMD = /\b(shutdown|restart|reg\s+(delete|add)|takeown|icacls|cacls|net\s+(user|localgroup)|sc\s+(delete|create|stop)|schtasks|wmic|runas)\b/i;
function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('windows-1250').decode(buf); } catch { return buf.toString('utf-8'); }
  }
}
function globWalk(root, pattern, fullAccess) {
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
  (function walk(dir, si, rel) {
    if (out.length >= 200) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
            walk(full, si, rp); // ** žere libovolně hluboko
            if (si + 1 < segs.length) walk(full, si + 1, rp);
            else out.push(rp + '/');
          } else if (segRx(segs[si]).test(e.name)) {
            if (last) out.push(rp + '/');
            else walk(full, si + 1, rp);
          }
        } else if (e.isFile()) {
          const seg = segs[si];
          let hit = false;
          if (seg === '**') {
            // ** samotné bere vše; ** /x bere shodu s dalším segmentem (i v kořenu)
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
    // "**/x": prohledej i vnořené adresáře se stejným vzorem
    if (segs[si] !== '**') {
      for (const e of entries) {
        if (out.length >= 200) return;
        try {
          if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
            walk(path.join(dir, e.name), si, rel ? rel + '/' + e.name : e.name);
          }
        } catch {}
      }
    }
  })(root, 0, '');
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
        resolve({ ok: true, output: txt.slice(0, 15000) || '(prázdná stránka)' });
      });
    });
    req.on('error', e => resolve({ ok: false, output: 'Chyba: ' + e.message }));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); resolve({ ok: false, output: 'Timeout' }); });
  });
}

// Portable nástroje (když winget selže): stáhni z netu do userData/tools a přidej do PATH,
// aby je shell hned našel — bez admin práv.
function toolsBinDirs(userDataDir) {
  const out = [];
  if (!userDataDir) return out;
  const base = path.join(String(userDataDir), 'tools');
  const regFile = path.join(base, '.bins.json');
  try {
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
    for (const id of Object.keys(reg || {})) for (const d of reg[id] || []) if (fs.existsSync(d)) out.push(d);
  } catch {}
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (/^node-v\d/i.test(e.name) && fs.existsSync(path.join(full, 'node.exe'))) { out.push(full); continue; }
          if (fs.existsSync(path.join(full, 'cmd', 'git.exe'))) { out.push(path.join(full, 'cmd')); continue; }
          if (fs.existsSync(path.join(full, 'git.exe'))) { out.push(full); continue; }
          if (/^python-/i.test(e.name) && fs.existsSync(path.join(full, 'python.exe'))) { out.push(full); continue; }
          walk(full, depth + 1);
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
function prependPortableBins(userDataDir) {
  try {
    const sep = path.delimiter;
    const cur = String(process.env.PATH || '').split(sep);
    for (const d of toolsBinDirs(userDataDir)) {
      if (!cur.some(p => p.toLowerCase() === d.toLowerCase())) cur.unshift(d);
    }
    process.env.PATH = cur.join(sep);
  } catch {}
}
// Progress stahování/instalací pro download widget v UI (vlevo dole).
// main.js zaregistruje hook, který eventy přeposílá do rendereru.
let progressHook = null;
function setProgressHook(fn) { progressHook = (typeof fn === 'function') ? fn : null; }
function dlEvent(ev) { try { if (progressHook) progressHook(Object.assign({ t: Date.now() }, ev)); } catch {} }
// Aktuální popisek stahovaného (nastavuje installTool, aby downloadFile věděl, co to je).
let dlContext = '';
// Registr běžících stahování pro zrušení z UI (Stop / Zrušit vše).
const dlControllers = new Map(); // id(dest) -> { cancelled, reqs:Set }
function cancelDownload(id) {
  const ids = id ? [String(id)] : [...dlControllers.keys()];
  let hit = false;
  for (const k of ids) {
    const c = dlControllers.get(k);
    if (!c) continue;
    hit = true;
    c.cancelled = true;
    for (const r of c.reqs || []) { try { r.destroy(new Error('Zrušeno uživatelem')); } catch {} }
  }
  return hit;
}
// HEAD: velikost + podpora Range (pro segmentové stahování). Vrací {url,size,ranges} nebo null.
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
const DL_SEGS = 6; // paralelních proudů u velkých souborů
const DL_SEG_MIN = 8 * 1048576; // segmentovat až soubory > 8 MB
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
        dlEvent({ kind: 'dl', id, label, phase: 'error', percent: -1, error: 'Zrušeno uživatelem' });
        return resolve({ ok: false, error: 'Zrušeno uživatelem' });
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
    // ---- jeden proud (i fallback) ----
    const single = () => {
      restarting = false;
      const go = (u, left, expected) => {
        if (done || ctrl.cancelled) return fail('Zrušeno uživatelem');
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
          res.on('aborted', () => fail(ctrl.cancelled ? 'Zrušeno uživatelem' : 'Spojení přerušeno uprostřed stahování'));
          res.pipe(ws);
          ws.on('finish', () => ws.close(() => {
            if (done) return;
            let size = 0;
            try { size = fs.statSync(dest).size; } catch {}
            if (!size) return fail('Staženo 0 B');
            if (expected && size < expected) return fail(`Neúplné stažení (${(size / 1048576).toFixed(1)} z ${(expected / 1048576).toFixed(1)} MB)`);
            finishOk(size, expected);
          }));
          ws.on('error', e => fail(e.message));
        });
        ctrl.reqs.add(req);
        const unreg = () => ctrl.reqs.delete(req);
        req.on('error', e => { unreg(); fail((e && e.message) || 'Chyba sítě'); });
        req.on('close', unreg);
        req.setTimeout(timeoutMs || 120000, () => { try { req.destroy(new Error(ctrl.cancelled ? 'Zrušeno uživatelem' : 'Timeout stahování')); } catch {} });
      };
      go(url, 4, 0);
    };
    // ---- jeden segment paralelního stahování ----
    const segDownload = (u, start, end, partFile, shared) => new Promise((res, rej) => {
      const go = (uu, left) => {
        if (done || ctrl.cancelled) return rej(new Error('Zrušeno uživatelem'));
        const mod = String(uu).startsWith('https:') ? https : http;
        const req = mod.get(String(uu), { headers: { 'User-Agent': 'NolimitCoder/2.0', Range: `bytes=${start}-${end}` } }, (rs) => {
          if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && left > 0) {
            rs.resume();
            return go(new URL(rs.headers.location, uu).toString(), left - 1);
          }
          if (rs.statusCode !== 206) { rs.resume(); return rej(new Error(rs.statusCode === 200 ? 'no-range' : 'HTTP ' + rs.statusCode)); }
          const ws = fs.createWriteStream(partFile);
          rs.on('data', c => { shared.received += c.length; prog(shared.received, shared.total); });
          rs.on('aborted', () => rej(new Error('Spojení přerušeno')));
          rs.pipe(ws);
          ws.on('finish', () => ws.close(() => res(true)));
          ws.on('error', e => rej(e));
        });
        ctrl.reqs.add(req);
        const unreg = () => ctrl.reqs.delete(req);
        req.on('error', e => { unreg(); rej(e); });
        req.on('close', unreg);
        req.setTimeout(timeoutMs || 300000, () => { try { req.destroy(new Error(ctrl.cancelled ? 'Zrušeno uživatelem' : 'Timeout stahování')); } catch {} });
      };
      go(u, 4);
    });
    // ---- paralelní stahování + složení ----
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
        if (done || ctrl.cancelled) return fail('Zrušeno uživatelem');
        try {
          const ws = fs.createWriteStream(dest);
          for (let i = 0; i < jobs.length; i++) {
            if (done || ctrl.cancelled) { try { ws.destroy(); } catch {} return fail('Zrušeno uživatelem'); }
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
          if (!sz) return fail('Staženo 0 B');
          if (sz < size) return fail(`Neúplné stažení (${(sz / 1048576).toFixed(1)} z ${(size / 1048576).toFixed(1)} MB)`);
          finishOk(sz, size);
        } catch (e) { fail((e && e.message) || 'Chyba skládání'); }
      }).catch((e) => {
        if (done || restarting) return;
        if (ctrl.cancelled) return fail('Zrušeno uživatelem');
        if (String((e && e.message) || e) === 'no-range') { stage = 'single'; restarting = true; cleanupParts(); return single(); }
        fail((e && e.message) || 'Chyba stahování');
      });
    };
    // ---- start: nejdřív zkusit segmenty, jinak jeden proud ----
    (async () => {
      try {
        const info = await headInfo(url, 20000);
        if (done || ctrl.cancelled) return fail('Zrušeno uživatelem');
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
  if (!userDataDir) throw new Error('Chybí userData');
  dlContext = 'Node.js';
  const toolsDir = path.join(String(userDataDir), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  // najdi nejnovější LTS verzi (žádné hardcodování)
  const index = await fetchJson('https://nodejs.org/dist/index.json', 20000);
  const lts = Array.isArray(index) ? index.find(v => v && v.lts) : null;
  const ver = (lts && lts.version) || 'v22.14.0';
  const existing = path.join(toolsDir, `node-${ver}-win-x64`, 'node.exe');
  if (fs.existsSync(existing)) {
    prependPortableBins(userDataDir);
    return { ok: true, output: `Node.js ${ver} už je stažený v ${path.dirname(existing)} a je v PATH.` };
  }
  const zipUrl = `https://nodejs.org/dist/${ver}/node-${ver}-win-x64.zip`;
  const zipDest = path.join(toolsDir, `node-${ver}-win-x64.zip`);
  const dl = await downloadFile(zipUrl, zipDest, 300000);
  if (!dl.ok) {
    try { fs.rmSync(zipDest, { force: true }); } catch {}
    throw new Error(`Stažení selhalo (${dl.error}). Ručně: https://nodejs.org/`);
  }
  const ps = await runCmd(`powershell -NoProfile -Command "Expand-Archive -Force '${zipDest}' '${toolsDir}'"`, toolsDir, 300000);
  try { fs.rmSync(zipDest, { force: true }); } catch {}
  if (!fs.existsSync(existing)) throw new Error(`Rozbalení se nepovedlo (${ps.output.slice(-300)}). Ručně: https://nodejs.org/`);
  prependPortableBins(userDataDir);
  return { ok: true, output: `Node.js ${ver} stažen z internetu do ${path.dirname(existing)} a přidán do PATH.` };
}
// Portable Git (MinGit) — když winget selže: zjisti nejnovější verzi přes GitHub API,
// stáhni MinGit-*-64-bit.zip do userData/tools a přidej cmd/ do PATH. Bez admina.
async function installPortableGit(userDataDir) {
  if (!userDataDir) throw new Error('Chybí userData');
  dlContext = 'Git';
  const toolsDir = path.join(String(userDataDir), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const already = toolsBinDirs(userDataDir).some(() => true);
  if (already) {
    const probe = await new Promise((resolve) => {
      execFile('git', ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
        resolve(!err && /git version/i.test(String(stdout || '')));
      });
    });
    if (probe) return { ok: true, output: 'Git už je k dispozici v PATH.' };
  }
  const rel = await fetchJson('https://api.github.com/repos/git-for-windows/git/releases/latest', 20000);
  const assets = (rel && rel.assets) || [];
  const mg = assets.find(a => /MinGit-.*-64-bit\.zip$/i.test(a.name || '')) || assets.find(a => /MinGit.*64.*\.zip$/i.test(a.name || ''));
  if (!mg || !mg.browser_download_url) throw new Error('Nenašel jsem MinGit ke stažení. Ručně: https://git-scm.com/downloads');
  const destDir = path.join(toolsDir, 'mingit');
  const zipDest = path.join(toolsDir, 'mingit.zip');
  const dl = await downloadFile(mg.browser_download_url, zipDest, 300000);
  if (!dl.ok) {
    try { fs.rmSync(zipDest, { force: true }); } catch {}
    throw new Error(`Stažení selhalo (${dl.error}). Ručně: https://git-scm.com/downloads`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  await runCmd(`powershell -NoProfile -Command "Expand-Archive -Force '${zipDest}' '${destDir}'"`, toolsDir, 300000);
  try { fs.rmSync(zipDest, { force: true }); } catch {}
  const gitExe = path.join(destDir, 'cmd', 'git.exe');
  if (!fs.existsSync(gitExe)) throw new Error('Rozbalení se nepovedlo. Ručně: https://git-scm.com/downloads');
  prependPortableBins(userDataDir);
  return { ok: true, output: `Git (${mg.name}) stažen z internetu do ${destDir} a přidán do PATH.` };
}

// ===== DETEKCE PROSTŘEDÍ: co už je v PC (i mimo PATH) =====
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

function detectProject(root) {
  const out = { root: root || '', kind: 'žádný projekt', needs: [], files: [] };
  if (!root || !fs.existsSync(String(root))) return out;
  const needs = [];
  const add = (ids) => { for (const i of ids || []) if (!needs.includes(i)) needs.push(i); };
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 2 || files.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name !== 'assets') walk(full, depth + 1); continue; }
      const low = e.name.toLowerCase();
      if (files.length < 200) files.push(path.relative(root, full).replace(/\\/g, '/'));
      if (MANIFEST_NEEDS[low]) add(MANIFEST_NEEDS[low]);
      if (/\.(csproj|fsproj|vbproj|sln)$/i.test(low)) add(['dotnet']);
      const ext = path.extname(low);
      if (EXT_NEEDS[ext]) add(EXT_NEEDS[ext]);
    }
  };
  walk(String(root), 0);
  const names = files.map(f => path.basename(f).toLowerCase());
  let kind = '';
  if (names.includes('package.json')) {
    let pkgTxt = '';
    try { pkgTxt = fs.readFileSync(path.join(String(root), 'package.json'), 'utf-8').slice(0, 20000).toLowerCase(); } catch {}
    kind = /electron-builder|"electron"/.test(pkgTxt) ? 'Electron aplikace'
      : /"next"/.test(pkgTxt) ? 'Next.js web'
      : /"vite"/.test(pkgTxt) ? 'Vite web'
      : /"nuxt"/.test(pkgTxt) ? 'Nuxt web'
      : 'Node.js/npm projekt';
  } else if (names.includes('cargo.toml')) kind = 'Rust projekt';
  else if (names.includes('go.mod')) kind = 'Go projekt';
  else if (names.includes('requirements.txt') || names.includes('pyproject.toml')) kind = 'Python projekt';
  else if (names.some(n => n.endsWith('.csproj') || n.endsWith('.sln'))) kind = '.NET projekt';
  else if (names.includes('pom.xml')) kind = 'Java (Maven)';
  else if (names.some(n => n.startsWith('build.gradle'))) kind = 'Java/Kotlin (Gradle)';
  else if (names.includes('cmakelists.txt')) kind = 'C/C++ (CMake)';
  else if (names.includes('makefile')) kind = 'C/C++ (Make)';
  else if (names.includes('dockerfile')) kind = 'Docker projekt';
  else if (names.includes('composer.json')) kind = 'PHP projekt';
  else if (names.includes('gemfile')) kind = 'Ruby projekt';
  else if (names.some(n => /\.(cpp|cc|cxx|c)$/.test(n))) kind = 'C/C++ zdrojáky';
  else if (names.some(n => n.endsWith('.py'))) kind = 'Python zdrojáky';
  else if (names.includes('index.html')) kind = 'statický web';
  if (needs.includes('cpp') && !needs.includes('msvc') && !needs.includes('gcc')) { /* group resolution later */ }
  out.kind = kind || 'kód';
  out.needs = needs;
  out.files = files.slice(0, 120);
  return out;
}

const INTENT_RULES = [
  [/\bc\+\+|\bcpp\b|\bg\+\+|\.cpp\b|\.hpp\b|\.cc\b|\.cxx\b|sfml|raylib|allegro|opengl|vulkan|\bsdl2?\b|pdcurses|conio/i, ['cpp']],
  [/\bmsvc\b|visual studio/i, ['msvc']],
  [/\bc#\b|csharp|dotnet|\.cs\b|\.csproj\b|wpf|blazor|maui/i, ['dotnet']],
  [/\bpython|\bpy\b|\.py\b|flask|django|fastapi|pandas|numpy|selenium|pygame|tkinter|pyqt|discord bot|telegram bot/i, ['python']],
  [/\bnode\b|nodejs|node\.js|\bnpm\b|\bnpx\b|electron|\breact\b|next\.?js|\bvue\b|angular|svelte|nestjs|express|typescript|javascript|tailwind|three\.?js|webov|web app|stránk|\bhtml\b|\bcss\b/i, ['node']],
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
  const project = detectProject(o.root);
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

// Krátká verze pro MODEL (plnou tabulku má panel v Nastavení z data.tools).
// Důvod: slabý model se v 22řádkové tabulce ztrácí a pak volá nástroje s prázdnými argumenty.
function envReportShort(s) {
  const lines = [];
  const pkg = Object.entries(s.packages || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'žádný';
  lines.push(`PC: ${s.os} · balíčkové manažery: ${pkg}`);
  lines.push(`Projekt${s.project.root ? ' ' + s.project.root : ''}: ${s.project.kind}`);
  if (s.intent.text) lines.push(`Objednávka: "${s.intent.text}" → potřeba: ${s.intent.needs.join(', ') || 'nic specifického'}`);
  const lbl = (i) => (TOOLCHAINS[i] || {}).label || i;
  if (s.needed.length) {
    lines.push('Stav potřebných:');
    for (const i of s.needed) {
      const t = (s.tools || {})[i] || {};
      if (t.ok) lines.push(`  ✓ ${lbl(i)} (${t.version || 'nalezeno'})`);
      else {
        const how = t.manual ? 'jen ručně: ' + (t.url || '') : t.heavy ? 'velký toolchain (heavy: true)' : 'doinstaluje env_prepare';
        lines.push(`  ✗ ${lbl(i)} — chybí (${how})`);
      }
    }
  } else lines.push('Potřeba pro tuto práci: zatím nic');
  lines.push(`Chybí celkem: ${s.missing.length ? s.missing.map(lbl).join(', ') : 'nic — všechno je tu'}`);
  return lines.join('\n');
}
function envReport(s) {
  const lines = [];
  const pkg = Object.entries(s.packages || {}).map(([k, v]) => `${k} ${v ? '✓' : '✗'}`).join(', ');
  lines.push(`PC: ${s.os} · uživatel ${s.user} · balíčkové manažery: ${pkg}`);
  lines.push('Nástroje v PC:');
  for (const t of Object.values(s.tools)) {
    if (t.ok) lines.push(`  ✓ ${t.label} — ${t.version || 'nalezeno'}${t.dir ? ' · ' + t.dir : ''}${t.source === 'FOUND' ? ' (bylo mimo PATH, přidáno do PATH)' : ''}`);
    else lines.push(`  ✗ ${t.label} — chybí${t.heavy ? ' · velký toolchain' : ''}${t.winget ? ' · winget ' + t.winget : ''}${t.manual ? ' · jen ručně' : ''}${t.url ? ' · ' + t.url : ''}`);
  }
  lines.push(`Projekt${s.project.root ? ' ' + s.project.root : ''}: ${s.project.kind}`);
  if (s.intent.text) lines.push(`Objednávka uživatele: "${s.intent.text}" → potřeba: ${s.intent.needs.join(', ') || 'nic specifického'}`);
  lines.push(`Potřeba pro tuto práci: ${s.needed.length ? s.needed.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ') : 'zatím nic'}`);
  lines.push(`Chybí a doinstaluje se: ${s.missing.length ? s.missing.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ') : 'nic — všechno je tu'}`);
  return lines.join('\n');
}
function envHow(r) {
  return r.how === 'winget' ? 'winget' : r.how === 'choco' ? 'Chocolatey' : r.how === 'scoop' ? 'Scoop' : 'staženo z internetu';
}
function envActionReport(after, results) {
  const lines = [envReportShort(after), '', 'Akce:'];
  for (const r of results || []) {
    if (r.already) lines.push(`  ✓ ${r.label} — už byla v PC (${r.version || 'nalezeno'})`);
    else if (r.ok) lines.push(`  ✓ ${r.label} — doinstalováno (${envHow(r)})`);
    else if (r.missing) lines.push(`  ⓘ ${r.label} — chybí, instalace by se spustila${r.heavy ? ' (velký toolchain, chce heavy: true)' : ''}`);
    else if (r.manual) lines.push(`  ⓘ ${r.label} — nedá se doinstalovat automaticky: ${String(r.output || '').replace(/^.*Odkaz: /, '')}`);
    else lines.push(`  ✗ ${r.label} — ${String(r.output || 'selhalo').split('\n').slice(0, 2).join(' ')}`);
  }
  lines.push(after.missing.length ? `\nPo této akci ještě chybí: ${after.missing.map(i => (TOOLCHAINS[i] || {}).label || i).join(', ')}` : '\nVšechno potřebné je připravené — pokračuj v práci.');
  return lines.join('\n');
}

// ===== Portable instalace (winget fallback): všechny stažitelné toolchainy =====
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
function findFileRe(root, re, maxDepth) {
  const rx = re instanceof RegExp ? re : new RegExp(re, 'i');
  let best = '';
  const walk = (dir, depth) => {
    if (depth > (maxDepth || 4) || best) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { if (best) return; if (e.isFile() && rx.test(e.name)) { best = path.join(dir, e.name); return; } }
    for (const e of entries) { if (best) return; if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1); }
  };
  walk(root, 0);
  return best;
}
const PORTABLE_INSTALLERS = {
  async node(ud) { return installPortableNode(ud); },
  async git(ud) { return installPortableGit(ud); },
  async python(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('astral-sh/python-build-standalone', /^cpython-3\.(12|13).*-x86_64-pc-windows-msvc-install_only\.tar\.gz$/i);
    if (!a) throw new Error('Portable Python se nepodařilo najít.');
    const f = path.join(d, 'python.tar.gz');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'python');
    await untarTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^python\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení Pythonu se nepovedlo.');
    rememberToolDir(ud, 'python', path.dirname(exe));
    rememberToolDir(ud, 'python', path.join(path.dirname(exe), 'Scripts'));
    prependPortableBins(ud);
    return { output: `Python stažen z internetu (${a.name}).` };
  },
  async gcc(ud) {
    const d = await toolsDirFor(ud);
    const has7z = (await whereBin('7z')).ok;
    const a = await ghAsset('brechtsanders/winlibs_mingw', has7z
      ? /^winlibs-x86_64-.*gcc.*\.7z$/i
      : /^winlibs-x86_64-.*gcc.*\.zip$/i);
    if (!a) throw new Error('WinLibs GCC se nepodařilo najít.');
    const f = path.join(d, 'winlibs' + (has7z ? '.7z' : '.zip'));
    const dl = await downloadFile(a.browser_download_url, f, 900000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'gcc');
    const okx = has7z ? await sevenZTo(f, out) : await unzipTo(f, out);
    if (!okx) throw new Error('Rozbalení GCC se nepovedlo.');
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^(gcc|g\+\+)\.exe$/i, 5);
    if (!exe) throw new Error('Rozbalení GCC se nepovedlo.');
    rememberToolDir(ud, 'gcc', path.dirname(exe));
    prependPortableBins(ud);
    return { output: `GCC stažen z internetu (${a.name}).` };
  },
  async cmake(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('Kitware/CMake', /^(?:cmake-[\d.]+-)?windows-x86_64\.zip$/i);
    if (!a) throw new Error('CMake release se nepodařilo najít.');
    const f = path.join(d, 'cmake.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'cmake');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^cmake\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení CMake se nepovedlo.');
    rememberToolDir(ud, 'cmake', path.dirname(exe));
    prependPortableBins(ud);
    return { output: `CMake stažen z internetu (${a.name}).` };
  },
  async go(ud) {
    const d = await toolsDirFor(ud);
    const idx = await fetchJson('https://go.dev/dl/?mode=json', 25000);
    const rel = Array.isArray(idx) ? idx.find(v => v && v.stable) : null;
    const files = (rel && rel.files) || [];
    const f64 = files.find(x => x.os === 'windows' && x.arch === 'amd64' && x.kind === 'archive') || null;
    if (!f64) throw new Error('Go release se nepodařilo najít.');
    const f = path.join(d, 'go.zip');
    const dl = await downloadFile('https://go.dev/dl/' + f64.filename, f, 900000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'go');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^go\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení Go se nepovedlo.');
    rememberToolDir(ud, 'go', path.dirname(exe));
    prependPortableBins(ud);
    return { output: `Go ${rel.version} stažen z internetu.` };
  },
  async java(ud) {
    const d = await toolsDirFor(ud);
    const f = path.join(d, 'jdk.zip');
    const dl = await downloadFile('https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse', f, 900000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'java');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^javac\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení JDK se nepovedlo.');
    rememberToolDir(ud, 'java', path.dirname(exe));
    prependPortableBins(ud);
    return { output: 'JDK 21 stažen z internetu (Adoptium).' };
  },
  async dotnet(ud) {
    const d = await toolsDirFor(ud);
    const ps1 = path.join(d, 'dotnet-install.ps1');
    const dl = await downloadFile('https://dot.net/v1/dotnet-install.ps1', ps1, 120000);
    if (!dl.ok) throw new Error('Stažení skriptu selhalo: ' + dl.error);
    const target = path.join(d, 'dotnet');
    const r = await runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -Channel 9.0 -InstallDir "${target}" -NoPath`, d, 900000);
    if (!r.ok || !fs.existsSync(path.join(target, 'dotnet.exe'))) throw new Error('Instalace .NET SDK selhala: ' + r.output.slice(-300));
    rememberToolDir(ud, 'dotnet', target);
    prependPortableBins(ud);
    return { output: '.NET SDK 9 stažen z internetu do aplikace.' };
  },
  async rust(ud) {
    const d = await toolsDirFor(ud);
    const exe = path.join(d, 'rustup-init.exe');
    const dl = await downloadFile('https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe', exe, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const r = await runCmd(`"${exe}" -y --profile minimal --default-toolchain stable --no-modify-path`, d, 900000);
    const cargoDir = path.join(os.homedir(), '.cargo', 'bin');
    if (!r.ok || !fs.existsSync(path.join(cargoDir, 'cargo.exe'))) throw new Error('Instalace Rustu selhala: ' + r.output.slice(-300));
    rememberToolDir(ud, 'rust', cargoDir);
    prependPortableBins(ud);
    return { output: 'Rust (cargo) stažen z internetu (rustup).' };
  },
  async bun(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('oven-sh/bun', /^bun-windows-x64\.zip$/i);
    if (!a) throw new Error('Bun release se nepodařilo najít.');
    const f = path.join(d, 'bun.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'bun');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^bun\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení Bun se nepovedlo.');
    rememberToolDir(ud, 'bun', path.dirname(exe));
    prependPortableBins(ud);
    return { output: `Bun stažen z internetu (${a.name}).` };
  },
  async deno(ud) {
    const d = await toolsDirFor(ud);
    const a = await ghAsset('denoland/deno', /^deno-x86_64-pc-windows-msvc\.zip$/i);
    if (!a) throw new Error('Deno release se nepodařilo najít.');
    const f = path.join(d, 'deno.zip');
    const dl = await downloadFile(a.browser_download_url, f, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'deno');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^deno\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení Deno se nepovedlo.');
    rememberToolDir(ud, 'deno', path.dirname(exe));
    prependPortableBins(ud);
    return { output: `Deno stažen z internetu (${a.name}).` };
  },
  async php(ud) {
    const d = await toolsDirFor(ud);
    const f = path.join(d, 'php.zip');
    const dl = await downloadFile('https://windows.php.net/downloads/releases/latest/php-8.4-nts-Win32-vs17-x64-latest.zip', f, 600000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    const out = path.join(d, 'php');
    await unzipTo(f, out);
    try { fs.rmSync(f, { force: true }); } catch {}
    const exe = findFileRe(out, /^php\.exe$/i, 4);
    if (!exe) throw new Error('Rozbalení PHP se nepovedlo.');
    rememberToolDir(ud, 'php', path.dirname(exe));
    prependPortableBins(ud);
    return { output: 'PHP 8.4 stažen z internetu.' };
  },
  async sevenzip(ud) {
    const d = await toolsDirFor(ud);
    const sub = path.join(d, '7zip');
    fs.mkdirSync(sub, { recursive: true });
    const exe = path.join(sub, '7zr.exe');
    const dl = await downloadFile('https://www.7-zip.org/a/7zr.exe', exe, 300000);
    if (!dl.ok) throw new Error('Stažení selhalo: ' + dl.error);
    try { fs.copyFileSync(exe, path.join(sub, '7z.exe')); } catch {}
    rememberToolDir(ud, 'sevenzip', sub);
    prependPortableBins(ud);
    return { output: '7-Zip stažen z internetu.' };
  }
};

async function installTool(id, opts) {
  const o = opts || {};
  const def = TOOLCHAINS[id];
  if (!def) return { ok: false, output: 'Neznámý toolchain: ' + id };
  if (def.manual) return { ok: false, manual: true, heavy: !!def.heavy, output: `${def.label} se nedá automaticky doinstalovat. Odkaz: ${def.url || ''}` };
  if (def.heavy && !o.heavy) return { ok: false, heavy: true, output: `${def.label} je velký toolchain (GB) — potřebuje potvrzení uživatele (heavy: true). Ručně: ${def.url || ''}` };
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
    if (!o.only && !(await whereBin(a.how)).ok) { notes.push(`${a.how} na tomto PC není — přeskočeno.`); continue; }
    dlContext = def.label;
    dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'install', percent: -1, how: a.how });
    const r = await runCmd(a.cmd, H, 900000);
    envState.dirs = []; envState.dirsAt = 0;
    const det = await detectTool(id);
    if (det.ok) {
      rememberToolDir(o.userDataDir, id, det.dir);
      prependPortableBins(o.userDataDir);
      dlContext = '';
      dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'done', percent: 100, how: a.how, ok: true });
      return { ok: true, how: a.how, output: `${def.label} nainstalován přes ${a.how} (${a.pkg}): ${det.version || 'hotovo'}${det.dir ? ' → ' + det.dir : ''}. Dostupné v dalších příkazach.` };
    }
    dlEvent({ kind: 'dl', id: 'pkg:' + id + ':' + a.how, label: def.label, phase: 'error', percent: -1, how: a.how, ok: false });
    dlContext = '';
    if (r.ok) notes.push(`${a.how} (${a.pkg}) nahlásil úspěch, ale binárku neumím najít — zkusím jinak.`);
    else notes.push(`${a.how} (${a.pkg}) selhal: ${String(r.output || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  }
  if (def.portable && o.userDataDir) {
    dlContext = def.label;
    try {
      const p = await PORTABLE_INSTALLERS[def.portable](o.userDataDir);
      const det = await detectTool(id);
      if (det.ok) {
        rememberToolDir(o.userDataDir, id, det.dir);
        prependPortableBins(o.userDataDir);
        dlContext = '';
        dlEvent({ kind: 'dl', id: 'portable:' + id, label: def.label, phase: 'done', percent: 100, how: 'portable', ok: true });
        return { ok: true, how: 'portable', output: `${def.label} stažen z internetu do aplikace: ${det.version || 'hotovo'}${det.dir ? ' → ' + det.dir : ''}.${p && p.output ? ' ' + p.output : ''}` };
      }
      notes.push(`portální varianta se nainstalovala, ale binárku neumím najít: ${(p && p.output) || ''}`);
    } catch (e) { notes.push('portable stažení selhalo: ' + e.message); }
    dlContext = '';
    dlEvent({ kind: 'dl', id: 'portable:' + id, label: def.label, phase: 'error', percent: -1, how: 'portable', ok: false });
  } else if (def.portable) {
    notes.push('bez userData cesty nelze portable varianta');
  }
  return { ok: false, output: `Automatická instalace ${def.label} selhala.${notes.length ? '\n' + notes.join('\n') : ''}\nRučně: ${def.url || 'https://winget.run/'}` };
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
    if (!def) { results.push({ id, label: id, ok: false, output: 'Neznámý toolchain' }); continue; }
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
// Shell jako administrátor: Windows UAC dialog + výstup přes dočasné soubory.
// Volá se, jen když normální cesta selže na právech (instalace apod.).
function runCmdAdmin(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const tag = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const outFile = path.join(os.tmpdir(), `nl-admin-${tag}.out`);
    const errFile = path.join(os.tmpdir(), `nl-admin-${tag}.err`);
    // Přesměrování dělá SAMOTNÉ cmd uvnitř (> soubor) — Start-Process redirect s UAC je nespolehlivý.
    // Vše jde do single-quoted PS řetězců: ' → ''
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
        resolve({ ok: false, output: `Admin shell se vůbec nespustil (${why || 'UAC zamítnuto'}).` });
        return;
      }
      const m = text.match(/EXIT:(-?\d+)/);
      let combined = String(out || '');
      if (errT) combined += (combined ? '\n[stderr]\n' : '') + String(errT);
      if (combined.length > 20000) combined = combined.slice(0, 20000) + '\n… (výstup zkrácen)';
      if (err) {
        resolve({ ok: false, output: `${combined}\n[admin shell selhal: ${err.killed ? 'timeout' : err.message}]`.trim() });
        return;
      }
      if (!m) {
        resolve({ ok: false, output: `${combined}\n[admin shell nevrátil exit kód ani výstup — příkaz asi neběžel.]`.trim() });
        return;
      }
      const code = parseInt(m[1], 10);
      resolve({ ok: code === 0, output: `${combined}\n[exit ${code}]`.trim() });
    });
  });
}
// Řádkový diff (zelená + / červená -) pro edit_file
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
async function execTool({ tool, args = {}, root, fullAccess, fallbackDir, openPathFn, timeoutMs, userDataDir, helperExe, helperArgs }) {
  tool = normToolName(tool);
  // shell = VŽDY administrátor (bez dotazování v aplikaci; UAC okno Windows vyskočí samo)
  if (tool === 'shell_admin') tool = 'shell';
  if (tool === 'read') tool = 'read_file';
  args = canonArgs(tool, args || {});
  const hasRoot = root && fs.existsSync(String(root));
  const base = hasRoot ? String(root) : (fallbackDir || root || process.cwd());
  const need = (k, example) => {
    if (args[k] === undefined || args[k] === null || args[k] === '') {
      const got = Object.keys(args || {});
      throw new Error(`Chybí parametr: ${k} (mám klíče: ${got.length ? got.join(', ') : 'žádné'}). Pošli např. ${example || `{"${k}": "..."}`}.`);
    }
    return args[k];
  };
  // Pojistka: bez vybrané složky se nikam potichu nezapisuje
  if (!hasRoot && !fullAccess && ['write_file', 'append_file', 'create_dir', 'move_file', 'copy_file', 'delete_file', 'edit_file', 'download_file', 'shell'].includes(tool)) {
    const hay = JSON.stringify(args || {});
    const folded = hay.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const hasAbs = /([a-zA-Z]:[\\/]|\\\\|\/)[a-zA-Z0-9]/i.test(hay);
    const hasKnown = /(documents|dokumenty|desktop|plocha|downloads|stazene|pictures|obrazky|music|hudba|videos|videa)/.test(folded);
    if (!hasAbs && !hasKnown) return { ok: false, output: 'Není vybrána žádná složka a cíl je nejasný. Zeptej se uživatele přes question, kam to uložit.' };
  }
  // Portable nástroje z minulých session patří do PATH při KAŽDÉM volání (i po restartu appky),
  // jinak by scan po restartu hlásil dříve doinstalované nástroje jako chybějící.
  prependPortableBins(userDataDir);
  dlContext = '';
  try {
    if (tool === 'shell') {
      // Shell běží jako normální uživatel, BEZ elevace a BEZ oken od Windows.
      // Schvalování je jen v aplikaci (tlačítka Pokračovat / Pokračovat vždy).
      const rawCmd = String(args.command ?? '').trim();
      if (!rawCmd) throw new Error('Prázdný příkaz — zavolej shell ZNOVU s vyplněným command.');
      const cmd = rawCmd; // normalizace podle backendu proběhne v runCmdKind
      let cwd = base;
      if (args.workdir) {
        const w = resolveTarget(base, args.workdir, fullAccess);
        if (!fs.existsSync(w)) throw new Error('workdir neexistuje: ' + w);
        cwd = w;
      }
      const tmo = Math.min(Math.max(parseInt(args.timeout) || 120000, 1000), 900000);
      if (isAlwaysBlocked(cmd)) throw new Error('Tenhle příkaz je vždy zakázaný (ochrana systému).');
      if (!fullAccess && SANDBOX_BLOCKED_CMD.test(cmd)) throw new Error('Tenhle příkaz je zakázaný.');
      if (!fs.existsSync(cwd)) cwd = os.homedir(); // složka mezitím zmizela → nespadnout
      // Před spuštěním se podívá, co příkaz potřebuje, a co chybí, samo doinstaluje.
      let autoNotes = [];
      if (fullAccess) {
        try {
          const installed = await ensureForShell(cmd, { userDataDir, root: base });
          for (const r of installed) if (r.ok) autoNotes.push(`${r.label || r.id} (${envHow(r)})`);
        } catch {}
      }
      let be = String(args.backend || 'auto').toLowerCase();
      if (!['cmd', 'powershell', 'pwsh', 'auto'].includes(be)) be = 'auto';
      const order = be === 'auto' ? ['cmd', 'powershell', 'pwsh'] : [be];
      const tried = [];
      let last = null;
      for (const kind of order) {
        const r = await runCmdKind(kind, cmd, cwd, tmo);
        tried.push(kind);
        if (r.launched === false) continue;
        if (!r.incompatible) {
          if (tried.length > 1) r.output += '\n[backend: ' + kind + ' — přepnuto, jinde to nešlo]';
          if (autoNotes.length) r.output += '\n[automaticky doinstalováno před spuštěním: ' + autoNotes.join(', ') + ']';
          return r;
        }
        last = r;
      }
      const lr = last || { ok: false, output: 'Žádný terminál není k dispozici.' };
      lr.output += '\n[zkoušeno: ' + tried.join(', ') + ']';
      if (autoNotes.length) lr.output += '\n[automaticky doinstalováno před spuštěním: ' + autoNotes.join(', ') + ']';
      return lr;
    }
    if (tool === 'write_file') {
      const abs = resolveTarget(base, need('path', '{"path": "soubor.txt", "content": "..."}'), fullAccess);
      if (typeof args.content !== 'string') throw new Error('Chybí content');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content, 'utf-8');
      return { ok: true, output: `OK: zapsáno ${args.content.length} znaků → ${abs}` };
    }
    if (tool === 'append_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (typeof args.content !== 'string') throw new Error('Chybí content');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, args.content, 'utf-8');
      return { ok: true, output: `OK: připsáno ${args.content.length} znaků → ${abs}` };
    }
    if (tool === 'edit_file') {
      // přesná editace: oldString musí sedět 1x (jinak chyba / je potřeba větší kontext)
      const abs = resolveTarget(base, need('path'), fullAccess);
      const oldS = need('oldString', '{"path": "...", "oldString": "...", "newString": "..."}');
      if (typeof args.newString !== 'string') throw new Error('Chybí newString');
      const txt = fs.readFileSync(abs, 'utf-8');
      const count = txt.split(oldS).length - 1;
      if (count === 0) throw new Error('oldString v souboru nenalezen.');
      if (count > 1 && !args.replaceAll) throw new Error(`oldString nalezen ${count}x — pošli větší kontext, nebo replaceAll: true.`);
      const next = args.replaceAll ? txt.split(oldS).join(args.newString) : txt.replace(oldS, args.newString);
      fs.writeFileSync(abs, next, 'utf-8');
      return { ok: true, output: `OK: upraveno (${args.replaceAll ? count + ' výskytů' : '1 výskyt'}) → ${abs}`, diff: diffLines(txt, next) };
    }
    if (tool === 'read_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const st = fs.statSync(abs);
      if (st.size > 40000) throw new Error('Soubor je moc velký (40 KB limit)');
      return { ok: true, output: readTextFile(abs).slice(0, 40000) };
    }
    if (tool === 'list_dir') {
      const abs = resolveTarget(base, args.path || '.', fullAccess);
      const out = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200)
        .map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
      return { ok: true, output: out || '(prázdná složka)' };
    }
    if (tool === 'glob_file') {
      const rx = resolveTarget(base, args.dir || '.', fullAccess);
      const hits = globWalk(rx, args.pattern || '**', fullAccess);
      return { ok: true, output: hits.length ? hits.join('\n') : '(nic nenalezeno)' };
    }
    if (tool === 'create_dir') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      fs.mkdirSync(abs, { recursive: true });
      return { ok: true, output: `OK: složka vytvořena → ${abs}` };
    }
    if (tool === 'move_file') {
      const from = resolveTarget(base, need('from'), fullAccess);
      const to = resolveTarget(base, need('to'), fullAccess);
      if (!fs.existsSync(from)) throw new Error('Zdroj neexistuje: ' + from);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { ok: true, output: `OK: přesunuto ${from} → ${to}` };
    }
    if (tool === 'copy_file') {
      const from = resolveTarget(base, need('from'), fullAccess);
      const to = resolveTarget(base, need('to'), fullAccess);
      if (!fs.existsSync(from)) throw new Error('Zdroj neexistuje: ' + from);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return { ok: true, output: `OK: zkopírováno ${from} → ${to}` };
    }
    if (tool === 'delete_file') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (!fs.existsSync(abs)) throw new Error('Neexistuje: ' + abs);
      fs.rmSync(abs, { recursive: false, force: true });
      return { ok: true, output: `OK: smazáno ${abs}` };
    }
    if (tool === 'file_info') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      const st = fs.statSync(abs);
      return { ok: true, output: `${abs}\ntyp: ${st.isDirectory() ? 'složka' : 'soubor'}\nvelikost: ${st.size} B\nzměněno: ${st.mtime.toLocaleString('cs-CZ')}` };
    }
    if (tool === 'search_files') {
      const pat = String(need('pattern'));
      const start = resolveTarget(base, args.dir || '.', fullAccess);
      const ext = args.ext ? '.' + String(args.ext).replace(/^\./, '').toLowerCase() : null;
      const hits = [];
      let scanned = 0;
      (function walk(dir) {
        if (hits.length > 40 || scanned > 300) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length > 40 || scanned > 300) return;
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          try {
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name)) continue;
              walk(full);
            } else if (e.isFile()) {
              if (ext && path.extname(e.name).toLowerCase() !== ext) continue;
              if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
              const st = fs.statSync(full);
              if (st.size > 100000) continue;
              scanned++;
              const lines = fs.readFileSync(full, 'utf-8').split('\n');
              lines.forEach((ln, i) => {
                if (hits.length < 40 && ln.toLowerCase().includes(pat.toLowerCase())) {
                  hits.push(`${path.relative(start, full)}:${i + 1}: ${ln.trim().slice(0, 160)}`);
                }
              });
            }
          } catch {}
        }
      })(start);
      return { ok: true, output: hits.length ? hits.join('\n') : '(nic nenalezeno)' };
    }
    if (tool === 'open_path') {
      const abs = resolveTarget(base, need('path'), fullAccess);
      if (!fs.existsSync(abs)) throw new Error('Neexistuje: ' + abs);
      if (openPathFn) openPathFn(abs);
      return { ok: true, output: `OK: otevřeno v systému → ${abs}` };
    }
    if (tool === 'scaffold_electron') {
      // Jistý start Electron projektu: funkční FRAMELESS kostra (package.json + main.js + preload.js + index.html).
      // Žádný nativní Windows rám/menu — vlastní titlebar v index.html. Model pak dopíše kód,
      // spustí npm install (timeout!) a build — viz EXE recept v promptu.
      const dir = resolveTarget(base, need('dir', '{"dir": "moje-app", "name": "Moje App"}'), fullAccess);
      const name = String(args.name || 'Moje App').slice(0, 60);
      const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'moje-app';
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
        `<!DOCTYPE html>\n<html lang="cs">\n<head><meta charset="UTF-8"><title>${name}</title><style>\n.titlebar{-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;background:#0b0b0e;color:#eee;font:600 12px sans-serif;letter-spacing:.08em}\n.titlebar .sp{flex:1}\n.titlebar button{-webkit-app-region:no-drag;background:transparent;border:none;color:#eee;font-size:13px;width:34px;height:26px;border-radius:6px;cursor:pointer}\n.titlebar button:hover{background:#ffffff22}\n</style></head>\n<body style="background:#101010;color:#eee;font-family:sans-serif;margin:0">\n<div class="titlebar"><span>${name}</span><span class="sp"></span><button id="tbMin">_</button><button id="tbMax">□</button><button id="tbClose">✕</button></div>\n<div style="padding:16px"><h1>${name}</h1>\n<p>Aplikace hotová.</p></div>\n<script>\ntbMin.onclick=()=>window.win.min();tbMax.onclick=()=>window.win.max();tbClose.onclick=()=>window.win.close();\n</script>\n</body>\n</html>\n`, 'utf-8');
      return { ok: true, output: `OK: frameless kostra "${name}" v ${dir}\nSoubory: package.json, main.js, preload.js, index.html (bez nativního Windows rámu, vlastní titlebar)\nDalší krok: shell "npm install" (timeout 600000), pak "npm run dist" (timeout 600000).` };
    }
    if (tool === 'web_fetch') {
      if (!/^https?:\/\//i.test(String(args.url || ''))) throw new Error('URL musí začínat http(s)://');
      return await fetchText(args.url, timeoutMs || 15000);
    }
    if (tool === 'web_search') {
      const q = String(need('query', '{"query": "nodejs download"}')).trim();
      if (!q) throw new Error('Prázdný dotaz');
      const html = await fetchHtml('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q), 20000);
      if (!html) throw new Error('Vyhledávání selhalo (síť).');
      const out = [];
      const re = /<a[^>]*href="[^"]*uddg=([^"&]+)[^"]*"[^>]*class='result-link'>([^<]{3,120})<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 8) {
        let url;
        try { url = decodeURIComponent(m[1]); } catch { continue; }
        const title = m[2].replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        out.push(`${out.length + 1}. ${title}\n   ${url}`);
      }
      if (!out.length) throw new Error('Nic nenalezeno.');
      return { ok: true, output: out.join('\n') };
    }
    if (tool === 'download_file') {
      const url = String(need('url', '{"url": "https://…", "to": "soubor.zip"}'));
      if (!/^https?:\/\//i.test(url)) throw new Error('URL musí začínat http(s)://');
      const toRaw = args.to || args.path || ('stazeno-' + Date.now() + '.bin');
      const abs = resolveTarget(base, toRaw, fullAccess);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const dl = await downloadFile(url, abs, 300000);
      if (!dl.ok) {
        try { fs.rmSync(abs, { force: true }); } catch {}
        throw new Error(`Stažení selhalo (${dl.error})`);
      }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      return { ok: true, output: `OK: staženo (${(size / 1048576).toFixed(1)} MB) → ${abs}` };
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
        return { ok: true, output: envReportShort(before) + '\n\nVšechno potřebné je už v PC — nic neinstaluji.', data: { before, after: before, results: [], missing: [] } };
      }
      const results = await ensureTools(todo, { userDataDir, heavy: !!args.heavy, dryRun: !!args.dryRun });
      const after = await scanEnv({ root: base, request: req, force: true });
      const failed = results.filter(r => !r.ok && !r.already && !r.manual);
      return { ok: after.missing.length === 0 && failed.length === 0, output: (args.dryRun ? 'PLÁN (pouze náhled, nic se neinstaluje):\n' : '') + envActionReport(after, results), data: { before, after, results, tools: after.tools, missing: after.missing } };
    }
    if (tool === 'env_install') {
      const rawIds = [];
      if (Array.isArray(args.ids)) rawIds.push(...args.ids);
      if (typeof args.id === 'string') rawIds.push(...args.id.split(/[,;\s]+/));
      if (!rawIds.length && Array.isArray(args.tools)) rawIds.push(...args.tools);
      const list = rawIds.length ? rawIds : Object.keys(TOOLCHAINS);
      if (!fullAccess) throw new Error('Instalace potřebuje Full přístup k PC (Nastavení).');
      const results = await ensureTools(list, { userDataDir, heavy: !!args.heavy, dryRun: !!args.dryRun });
      const after = await scanEnv({ root: base, force: true });
      const failed = results.filter(r => !r.ok && !r.already && !r.manual);
      return { ok: failed.length === 0, output: (args.dryRun ? 'PLÁN (pouze náhled, nic se neinstaluje):\n' : '') + envActionReport(after, results), data: { results, tools: after.tools, missing: after.missing } };
    }
    return { ok: false, output: `Tenhle nástroj nemám. Použij: shell, write_file, append_file, edit_file, read_file, list_dir, glob_file, create_dir, move_file, copy_file, delete_file, file_info, search_files, open_path, web_fetch, env_scan, env_prepare, env_install.` };
  } catch (e) {
    return { ok: false, output: `Chyba: ${e.message}` };
  }
}

// ===== Persistentní zvýšený pomocník: 1× UAC za session, pak ticho =====
// Místo UAC u každého příkazu běží jedna zvýšená instance (naše vlastní exe
// s --elevated-helper), která je s appkou spojená rourou a vykonává shelly.
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
  for (const [, p] of elev.pending) { try { p.resolve({ ok: false, output: 'Zvýšený pomocník skončil.' }); } catch {} }
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
          // vlastní exe zvýšeně s příznakem pomocníka (1× UAC); bez oken
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
    if (!elev.sock || elev.sock.destroyed) { resolve({ ok: false, output: 'Pomocník neběží.' }); return; }
    const id = ++elev.seq;
    const to = setTimeout(() => {
      elev.pending.delete(id);
      resolve({ ok: false, output: 'Timeout zvýšeného příkazu.' });
    }, Math.min(Math.max(parseInt(timeoutMs) || 120000, 1000), 900000) + 15000);
    elev.pending.set(id, { resolve: (r) => { clearTimeout(to); resolve(r); } });
    elevSend({ id, cmd: String(cmd), cwd: String(cwd), timeout: timeoutMs });
  });
}
// Chytrý shell: přes pomocníka bez UAC oken, jinak legacy cestou (UAC na příkaz)
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
  normToolName, foldKey, knownFolders, resolveTarget, canonArgs, splitArgs, normalizeShell,
  runCmd, runArgv, runCmdAdmin, globWalk, fetchText, diffLines, execTool,
  scanEnv, envReport, ensureTools, ensureForShell, detectProject, detectIntent, requiredForCommand, resolveNeed, installTool,
  setProgressHook, cancelDownload, dbgLog,
  ensureElevatedHelper, elevRun, runShellSmart, helperState
};
