// NolimitCoder — Error Log (složka Logs, soubory errors-AAAA-MM-DD.txt)
// Každá chyba v aplikaci (AI stream, nástroj, renderer, main) sem dopadne.
// Složka se volí v pořadí — první zapisovatelná vyhrává:
//   1) config.json → logsDir          (vývojářský stroj míří na repo\NolimitCoder\Logs)
//   2) <repo>/NolimitCoder/Logs       (dev build spuštěný přímo z repozitáře)
//   3) %APPDATA%\…\NolimitCoder\logs  (instalace u zákazníka — výchozí)
// Jeden textový soubor na den: errors-2026-10-01.txt (starší než 30 dní se mažou),
// rotace 5 MB. Vše v try/catch — logování nikdy nesmí nic rozbít.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let errDir = '';
let errFile = '';
let errDay = '';
let writes = 0;
const DAY_RE = /^errors-\d{4}-\d{2}-\d{2}\.txt$/;

function writable(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
    const probe = path.join(d, '.etest');
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

// Složka, do které patří všechny logy (Error Log + ai-debug.log).
function logsDir() {
  if (errDir) return errDir;
  const cands = [];
  // 1) explicitní cesta z config.json (na vývojářském stroji je to repo Logs)
  try {
    const e = require('electron');
    if (e && e.app) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(e.app.getPath('userData'), 'config.json'), 'utf8'));
        if (j && typeof j.logsDir === 'string' && j.logsDir.trim()) cands.push(j.logsDir.trim());
      } catch {}
    }
  } catch {}
  // 2) dev: src/main -> NolimitCoder/Logs (v app.asar psát nejde, tam přeskočí)
  try {
    const here = String(__dirname || '');
    if (!/app\.asar/i.test(here)) cands.push(path.resolve(here, '..', '..', 'Logs'));
  } catch {}
  // 3) profil uživatele — instalace u zákazníka
  try {
    const e = require('electron');
    if (e && e.app) cands.push(path.join(e.app.getPath('userData'), 'logs'));
  } catch {}
  try { cands.push(path.join(os.tmpdir(), 'NolimitCoder logs')); } catch {}
  for (const d of cands) { if (d && writable(d)) { errDir = d; break; } }
  return errDir;
}

function today() { return new Date().toISOString().slice(0, 10); }

// Zápis jde vždy do dnešního souboru.
function errFilePath() {
  const dir = logsDir();
  if (!dir) return '';
  const day = today();
  if (errFile && errDay === day) return errFile;
  errDay = day;
  errFile = path.join(dir, 'errors-' + day + '.txt');
  try { cleanup(dir); } catch {}
  return errFile;
}

// Co se ukáže v Nastavení → Error Log: dnešní soubor, jinak nejnovější existující.
function currentLogFile() {
  const f = errFilePath();
  try {
    if (f && fs.existsSync(f)) return f;
    const dir = path.dirname(f);
    const list = fs.readdirSync(dir).filter((n) => DAY_RE.test(n)).sort();
    if (list.length) return path.join(dir, list[list.length - 1]);
  } catch {}
  return f;
}

// Starší než 30 dní zahodíme — logů se za rok nastřádá hromada.
function cleanup(dir) {
  const limit = Date.now() - 30 * 24 * 3600 * 1000;
  for (const n of fs.readdirSync(dir)) {
    if (!DAY_RE.test(n)) continue;
    try {
      const p = path.join(dir, n);
      if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
    } catch {}
  }
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

// Detail nesmí do logu kopírovat celé soubory — tool volání posílá své argumenty
// (u write_file je v nich obsah souboru klidně za 15 kB) a z Error Logu pak
// byla jen hromada kódu místo čitelné chyby. Dlouhé hodnoty se zkrátí.
function shrink(v, d) {
  if (typeof v === 'string') {
    return v.length > 300 ? v.slice(0, 300) + ' …[+' + (v.length - 300) + ' znaků]' : v;
  }
  if (Array.isArray(v)) {
    if (d >= 4) return '[… ' + v.length + ' položek]';
    const a = v.slice(0, 20).map((x) => shrink(x, d + 1));
    if (v.length > 20) a.push('…');
    return a;
  }
  if (v && typeof v === 'object') {
    if (d >= 4) return '[…]';
    const o = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (++n > 40) { o['…'] = 'další klíče'; break; }
      try { o[k] = shrink(v[k], d + 1); } catch { o[k] = '[…]'; }
    }
    return o;
  }
  return v;
}

function header() {
  return '='.repeat(78) + '\r\n'
    + 'NolimitCoder — Error Log\r\n'
    + 'Spuštěno: ' + new Date().toLocaleString('cs-CZ') + '\r\n'
    + 'Aplikace: ' + (function () { try { return require('electron').app.getVersion(); } catch { return 'n/a'; } })() + '\r\n'
    + 'Složka:   ' + (logsDir() || '(neznámá)') + '\r\n'
    + '='.repeat(78) + '\r\n';
}

// where: kde se chyba stala (aistream / tool / renderer / main …)
function logError(where, err, extra) {
  try {
    const f = errFilePath();
    if (!f) return;
    try {
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) fs.writeFileSync(f, header(), 'utf8');
    } catch {}
    // Rotace: 5 MB. Hlídáme pokaždé (zápisů není moc a statSync je levný) —
    // dřív se kontrolovalo jen každý 25. zápis, takže soubor mohl růst dál.
    writes++;
    try {
      if (fs.statSync(f).size > 5 * 1048576) {
        try { fs.rmSync(f + '.old', { force: true }); } catch {}
        try { fs.renameSync(f, f + '.old'); } catch {}
        try { fs.writeFileSync(f, header(), 'utf8'); } catch {}
      }
    } catch {}
    const msg = (() => {
      if (!err) return 'neznámá chyba';
      if (typeof err === 'string') return err;
      if (err.message) return err.message;
      try { return JSON.stringify(err).slice(0, 2000); } catch { return String(err); }
    })();
    const stack = (err && err.stack) ? String(err.stack) : '';
    let block = '\r\n[' + new Date().toISOString() + '] [' + String(where || 'error') + ']\r\n';
    block += '  Chyba:  ' + String(msg).slice(0, 2000).replace(/\r?\n/g, '\n          ') + '\r\n';
    if (extra) {
      // Objekt (typicky argumenty nástroje) se zkrátí — do logu se nedostane
      // obsah celého souboru, jen jeho popis (viz shrink).
      const ex = typeof extra === 'string' ? extra
        : (() => { try { return JSON.stringify(shrink(extra, 0)); } catch { return String(extra); } })();
      block += '  Detail: ' + String(ex).slice(0, 3000).replace(/\r?\n/g, '\n          ') + '\r\n';
    }
    if (stack) block += '  Stack:\r\n          ' + stack.slice(0, 3000).replace(/\r?\n/g, '\r\n          ') + '\r\n';
    fs.appendFileSync(f, scrubSecrets(block), 'utf8');
  } catch {}
}

function readLog(maxBytes) {
  try {
    const f = currentLogFile();
    if (!f || !fs.existsSync(f)) return { ok: false, path: f || '', text: '(log zatím neexistuje)' };
    const st = fs.statSync(f);
    const cap = maxBytes || 200 * 1024;
    let text;
    if (st.size > cap) {
      // posledních N bajtů — začínáme na celém řádku
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, st.size - cap);
      fs.closeSync(fd);
      text = '…(zkráceno, ukázán posledních ' + Math.round(cap / 1024) + ' KB)…\r\n\r\n' + buf.toString('utf8');
    } else {
      text = fs.readFileSync(f, 'utf8');
    }
    return { ok: true, path: f, size: st.size, text };
  } catch (e) { return { ok: false, path: '', text: 'Chyba čtení logu: ' + (e && e.message) }; }
}

function clearLog() {
  try { const f = currentLogFile(); if (f && fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {}
  try { writes = 0; } catch {}
  return { ok: true };
}

module.exports = { logError, readLog, clearLog, errFilePath, currentLogFile, logsDir };
