// NolimitCoder — Error Log (dist/Error Log.txt)
// Každá chyba v aplikaci (AI stream, nástroj, renderer, main) sem dopadne.
// Cíl: dist/Error Log.txt vedle instalátoru, aby šel chyba poslat vývojáři.
// Rotace na 5 MB. Vše v try/catch — logování nikdy nesmí nic rozbít.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let errFile = '';
let writes = 0;

function errFilePath() {
  if (errFile) return errFile;
  // BEZPEČNOST: logy patří do uživatelského profilu (Roaming), NE vedle instalace —
  // instalační složku může číst každý a logy nesou i to, co uživatel psal AI.
  try {
    const e = require('electron');
    if (e && e.app) {
      const dir = path.join(e.app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      errFile = path.join(dir, 'Error Log.txt');
      return errFile;
    }
  } catch {}
  const dirs = [];
  // dev: src/main -> root/NolimitCoder, pak dist/
  try {
    const here = String(__dirname || '');
    if (!/app\.asar/i.test(here)) dirs.push(path.join(here, '..', '..'));
  } catch {}
  // balené bez userData: exe leží v dist/win-unpacked, takže logs o úroveň výš
  try {
    const e = require('electron');
    if (e && e.app && e.app.isPackaged) dirs.push(path.dirname(process.execPath));
  } catch {}
  try { dirs.push(process.cwd()); } catch {}
  for (const d of dirs) {
    try {
      const dir = path.join(d, 'dist');
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.etest');
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe, { force: true });
      errFile = path.join(dir, 'Error Log.txt');
      break;
    } catch {}
  }
  if (!errFile) { try { errFile = path.join(os.tmpdir(), 'Error Log.txt'); } catch {} }
  return errFile;
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

function header() {
  return '='.repeat(78) + '\r\n'
    + 'NolimitCoder — Error Log\r\n'
    + 'Spuštěno: ' + new Date().toLocaleString('cs-CZ') + '\r\n'
    + 'Aplikace: ' + (function () { try { return require('electron').app.getVersion(); } catch { return 'n/a'; } })() + '\r\n'
    + '='.repeat(78) + '\r\n';
}

// where: kde se chyba stala (aistream / tool / renderer / main …)
function logError(where, err, extra) {
  try {
    const f = errFilePath();
    if (!f) return;
    if (writes === 0) {
      try { fs.writeFileSync(f, header(), 'utf8'); } catch {}
    }
    if (++writes % 25 === 0) {
      try {
        if (fs.statSync(f).size > 5 * 1048576) {
          try { fs.rmSync(f + '.old', { force: true }); } catch {}
          try { fs.renameSync(f, f + '.old'); } catch {}
          try { fs.writeFileSync(f, header(), 'utf8'); } catch {}
        }
      } catch {}
    }
    const msg = (() => {
      if (!err) return 'neznámá chyba';
      if (typeof err === 'string') return err;
      if (err.message) return err.message;
      try { return JSON.stringify(err).slice(0, 2000); } catch { return String(err); }
    })();
    const stack = (err && err.stack) ? String(err.stack) : '';
    let block = '\r\n[' + new Date().toISOString() + '] [' + String(where || 'error') + ']\r\n';
    block += '  Chyba:  ' + String(msg).replace(/\r?\n/g, '\n          ') + '\r\n';
    if (extra) {
      const ex = typeof extra === 'string' ? extra : (() => { try { return JSON.stringify(extra); } catch { return String(extra); } })();
      block += '  Detail: ' + String(ex).slice(0, 3000).replace(/\r?\n/g, '\n          ') + '\r\n';
    }
    if (stack) block += '  Stack:\r\n          ' + stack.slice(0, 3000).replace(/\r?\n/g, '\r\n          ') + '\r\n';
    fs.appendFileSync(f, scrubSecrets(block), 'utf8');
  } catch {}
}

function readLog(maxBytes) {
  try {
    const f = errFilePath();
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
  try { const f = errFilePath(); if (f && fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {}
  try { writes = 0; } catch {}
  return { ok: true };
}

module.exports = { logError, readLog, clearLog, errFilePath };
