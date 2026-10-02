import https from 'https';

// ===== Instalátory: github.com/mrpaxik99/NolimitCoder-Download =====
// Repozitář je veřejný, takže odkazy fungují pro kohokoliv. Jediný zdroj pravdy:
// co je v kořeni tohoto repa, to se stahuje přes /api/download a to jediné
// v aplikaci funguje. Nová verze = auto-push zkopíruje .exe z distu do
// D:\DEVELOPER\Download New Version a pushne ho — nic víc.
//   nejvyšší číslo verze v názvu .exe = verze, která jede
const OWNER = 'mrpaxik99';
const REPO = 'NolimitCoder-Download';
const REF = 'main';
const DIR = ''; // kořen repa
const DIR_ENC = DIR ? DIR.split('/').map(encodeURIComponent).join('/') : '';
const API_URL = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents' + (DIR_ENC ? '/' + DIR_ENC : '') + '?ref=' + REF;
const RAW_BASE = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + REF + '/' + (DIR_ENC ? DIR_ENC + '/' : '');
const FOLDER_URL = 'https://github.com/' + OWNER + '/' + REPO + '/tree/' + REF + (DIR_ENC ? '/' + DIR_ENC : '');

const CACHE_MS = 60 * 1000; // LIVE: hlida se prubezne. GitHub limit 60 req/h se necerpa diky ETag (304 se nepocita)
let cache = { at: 0, etag: '', files: null };
let warnCache = { at: 0, text: '' };
const WARN_FILES = ['WARNING.md', 'warning.md', 'WARNING.txt', 'warning.txt'];

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      if (res.statusCode === 304) { res.resume(); return resolve({ status: 304, etag: '' }); }
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        const next = /^https?:\/\//i.test(String(loc)) ? String(loc) : new URL(loc, url).toString();
        resolve(get(next, headers));
        return;
      }
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.length > 2e6) { try { res.destroy(); } catch {} reject(new Error('Odpoved je moc velka.')); }
      });
      res.on('end', () => resolve({ status: res.statusCode, body: d, etag: res.headers.etag || '' }));
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('timeout')); });
  });
}

// "NolimitCoder New Setup 1.0.0.exe" → "1.0.0" (poslední číslo v názvu)
export function verOf(name) {
  const m = String(name || '').match(/\d+(?:\.\d+)+/g);
  return m ? m[m.length - 1] : '';
}

export function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function listFiles() {
  if (cache.files && Date.now() - cache.at < CACHE_MS) return cache.files;
  const headers = { 'User-Agent': 'nolimitcoder-site', Accept: 'application/vnd.github+json' };
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  const r = await get(API_URL, headers);
  if (r.status === 304 && cache.files) { cache.at = Date.now(); return cache.files; }
  if (r.status !== 200) throw new Error('GitHub HTTP ' + r.status);
  let data;
  try { data = JSON.parse(r.body); } catch { data = []; }
  const files = (Array.isArray(data) ? data : [])
    .filter((f) => f && f.type === 'file' && /\.exe$/i.test(String(f.name)))
    .map((f) => ({
      name: String(f.name),
      size: Number(f.size) || 0,
      version: verOf(f.name),
      url: RAW_BASE + encodeURIComponent(String(f.name))
    }));
  cache = { at: Date.now(), etag: r.etag || '', files };
  return files;
}

// Nejvyšší verze ve složce = ta, která jediná funguje a která se stahuje.
export async function currentRelease() {
  const files = await listFiles();
  if (!files.length) return null;
  let best = null;
  for (const f of files) {
    if (!f.version) continue;
    if (!best || cmpVer(f.version, best.version) > 0) best = f;
  }
  return best || files[0];
}

// Vsechny verze v repu (pro live kontrolu: je moje verze vubec zverejnena?)
export async function listVersions() {
  const files = await listFiles();
  const out = [];
  for (const f of files) if (f.version) out.push(f.version);
  return out;
}

// LIVE warning z GitHubu: text ze souboru WARNING.md v koreni repa.
// Kdyz tam neni, vrati ''. Cte se pres raw, s vlastni 60s cache.
export async function liveWarning() {
  if (warnCache.text && Date.now() - warnCache.at < CACHE_MS) return warnCache.text;
  for (const name of WARN_FILES) {
    try {
      const r = await get(RAW_BASE + encodeURIComponent(name), { 'User-Agent': 'nolimitcoder-site' });
      if (r.status === 200 && r.body) {
        const t = String(r.body).replace(/\r/g, '').trim().slice(0, 500);
        if (t) { warnCache = { at: Date.now(), text: t }; return t; }
      }
    } catch {}
  }
  warnCache = { at: Date.now(), text: '' };
  return '';
}

export function folderUrl() {
  return FOLDER_URL;
}
