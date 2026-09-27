// Proxy manager — ProxyScrape free list + automatická rotace při quota limitu.
// Zdroj: https://proxyscrape.com (v4 public API, bez klíče) + přibalená složka proxies/.
// Umí: načíst všechny proxy, stáhnout čerstvé, tahat random proxy,
// detekovat quota/rate-limit z odpovědi brány opencode a jet přes proxy tunel
// (HTTP CONNECT + SOCKS4/5 + TLS) pro https://opencode.ai.
// Bez externích závislostí (čistý node: net + tls + https).
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const http = require('http');

const API_TMPL = (proto) =>
  `https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=${proto}&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&limit=2000`;

// Přibalené listy (ve zdroji i v buildu): src/main -> ../../proxies
function bundledDir() {
  return path.join(__dirname, '..', '..', 'proxies');
}

// Stav rotace
const state = {
  http: [], socks4: [], socks5: [],
  loadedAt: 0,
  // quota tracking — "blížím se limitu" vyhodnocení
  quotaHits: 0,          // kolikrát jsme narazili na 429/quota celkem
  lastQuotaAt: 0,        // timestamp posledního quota zásahu
  lastRetryAfterMs: 0,   // Retry-After z poslední 429
  consecutive429: 0,     // po sobě jdoucí 429 (resetuje úspěch)
  proxyActive: false,    // právě jedeme přes proxy?
  current: null,         // aktuální proxy {type,host,port,str}
  switches: 0,           // kolikrát se přepnulo
  bad: new Map(),        // proxyStr -> failCount (dočasně vynechat)
  okCount: 0,
  cacheDir: '',
};
function dbg() { try { require('./tools').dbgLog('proxy', arguments[0]); } catch {} }

/* ---------- načtení ---------- */
function parseLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  // povolíme "http://ip:port" i holé "ip:port"
  const m = s.match(/^(?:(https?|socks4|socks5):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9.-]+):(\d{1,5})$/);
  if (!m) return null;
  const port = parseInt(m[3], 10);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[2], port };
}
function readTxt(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const out = [];
    const seen = new Set();
    for (const ln of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const p = parseLine(ln);
      if (!p) continue;
      const key = p.host + ':' + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  } catch { return []; }
}
function loadProxies(cacheDir) {
  if (cacheDir) state.cacheDir = cacheDir;
  const dirs = [];
  if (state.cacheDir) { dirs.push(state.cacheDir); }
  dirs.push(bundledDir());
  let http = [], s4 = [], s5 = [];
  for (const d of dirs) {
    try {
      const h = readTxt(path.join(d, 'http.txt'));
      const a = readTxt(path.join(d, 'socks4.txt'));
      const b = readTxt(path.join(d, 'socks5.txt'));
      if (h.length > http.length) http = h;
      if (a.length > s4.length) s4 = a;
      if (b.length > s5.length) s5 = b;
    } catch {}
    if (http.length && s4.length && s5.length) break;
  }
  // nouzově: all.txt (s prefixy)
  if (!http.length && !s4.length && !s5.length) {
    for (const d of dirs) {
      try {
        const f = path.join(d, 'all.txt');
        if (!fs.existsSync(f)) continue;
        for (const ln of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) {
          const s = ln.trim();
          if (!s) continue;
          if (s.startsWith('http://') || s.startsWith('https://')) { const p = parseLine(s); if (p) http.push(p); }
          else if (s.startsWith('socks4://')) { const p = parseLine(s); if (p) s4.push(p); }
          else if (s.startsWith('socks5://')) { const p = parseLine(s); if (p) s5.push(p); }
        }
      } catch {}
    }
  }
  state.http = http; state.socks4 = s4; state.socks5 = s5;
  state.loadedAt = Date.now();
  return counts();
}
function counts() {
  return { http: state.http.length, socks4: state.socks4.length, socks5: state.socks5.length, total: state.http.length + state.socks4.length + state.socks5.length };
}

/* ---------- stažení čerstvých ze ProxyScrape ---------- */
function fetchUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'NolimitCoder-proxy-refresh' } }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 4 * 1024 * 1024) { try { req.destroy(); } catch {} resolve(''); } });
        res.on('end', () => resolve(d));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(timeoutMs || 30000, () => { try { req.destroy(); } catch {} resolve(''); });
    } catch { resolve(''); }
  });
}
async function refreshProxies(cacheDir) {
  if (cacheDir) state.cacheDir = cacheDir;
  const out = {};
  for (const proto of ['http', 'socks4', 'socks5']) {
    const raw = await fetchUrl(API_TMPL(proto), 30000);
    const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const clean = [];
    const seen = new Set();
    for (const ln of lines) {
      const p = parseLine(ln);
      if (!p) continue;
      const k = p.host + ':' + p.port;
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(p);
      if (clean.length >= 2000) break;
    }
    out[proto] = clean;
  }
  // uložit jen když něco přišlo (jinak držet staré)
  const gotAny = (out.http.length + out.socks4.length + out.socks5.length) > 0;
  if (gotAny) {
    state.http = out.http.length ? out.http : state.http;
    state.socks4 = out.socks4.length ? out.socks4 : state.socks4;
    state.socks5 = out.socks5.length ? out.socks5 : state.socks5;
    state.loadedAt = Date.now();
    state.bad.clear();
    // persist do cache (userData/proxies) + pokus i do bundled (dev)
    for (const d of [state.cacheDir, bundledDir()]) {
      if (!d) continue;
      try {
        fs.mkdirSync(d, { recursive: true });
        const w = (name, arr) => {
          try { fs.writeFileSync(path.join(d, name), arr.map((p) => p.host + ':' + p.port).join('\n') + '\n'); } catch {}
        };
        w('http.txt', state.http); w('socks4.txt', state.socks4); w('socks5.txt', state.socks5);
        try {
          const all = [
            ...state.http.map((p) => `http://${p.host}:${p.port}`),
            ...state.socks4.map((p) => `socks4://${p.host}:${p.port}`),
            ...state.socks5.map((p) => `socks5://${p.host}:${p.port}`),
          ];
          fs.writeFileSync(path.join(d, 'all.txt'), all.join('\n') + '\n');
          fs.writeFileSync(path.join(d, 'proxies.json'), JSON.stringify({ updated: new Date().toISOString(), source: 'proxyscrape-v4', counts: counts() }, null, 2));
        } catch {}
      } catch {}
    }
  }
  try { dbg({ act: 'refresh', counts: counts(), gotAny }); } catch {}
  return { ok: gotAny, counts: counts() };
}

/* ---------- random výběr ---------- */
function isBad(key) {
  const n = state.bad.get(key) || 0;
  return n >= 3; // po 3 pádech dočasně vynechat
}
function pickRandom(arr, excludeKey) {
  if (!arr.length) return null;
  for (let i = 0; i < 12; i++) {
    const p = arr[Math.floor(Math.random() * arr.length)];
    const k = p.host + ':' + p.port;
    if (k === excludeKey) continue;
    if (isBad(k)) continue;
    return p;
  }
  // nouzově i špatnou (lepší než nic)
  const p = arr[Math.floor(Math.random() * arr.length)];
  return p || null;
}
// Preferujeme HTTP (nejrychlejší na https CONNECT), pak SOCKS5, pak SOCKS4.
function getRandomProxy(excludeStr) {
  const excl = String(excludeStr || '');
  let p = pickRandom(state.http, excl);
  if (p) return { type: 'http', host: p.host, port: p.port, str: `http://${p.host}:${p.port}` };
  p = pickRandom(state.socks5, excl);
  if (p) return { type: 'socks5', host: p.host, port: p.port, str: `socks5://${p.host}:${p.port}` };
  p = pickRandom(state.socks4, excl);
  if (p) return { type: 'socks4', host: p.host, port: p.port, str: `socks4://${p.host}:${p.port}` };
  return null;
}
function markBad(proxy) {
  try {
    const k = typeof proxy === 'string' ? proxy.replace(/^\w+:\/\//, '') : (proxy.host + ':' + proxy.port);
    state.bad.set(k, (state.bad.get(k) || 0) + 1);
    if (state.bad.size > 500) { // rotace mapy
      const first = state.bad.keys().next().value;
      state.bad.delete(first);
    }
  } catch {}
}
function markGood() { state.okCount++; state.consecutive429 = 0; }

/* ---------- quota detekce z brány opencode ---------- */
function isQuotaBody(s) {
  return /quota|rate[\s_-]*limit|free[\s_-]*usage[\s_-]*limit|too many requests|capacity|overloaded|try again later|429|FreeUsageLimit|usage[\s_-]*exceeded|limit[\s_-]*exceeded|insufficient[\s_-]*quota/i.test(String(s || ''));
}
function isQuotaStatus(status, body) {
  if (status === 429) return true;
  if (status === 402 || status === 503) return isQuotaBody(body);
  if (status === 403) return /quota|rate|limit/i.test(String(body || '')); // geo-ban (RegionError) NE — ten proxy neřeší
  return false;
}
function isGeoBlockedBody(s) {
  return /RegionError|not available in your country/i.test(String(s || ''));
}
function onQuotaHit(retryAfterMs) {
  state.quotaHits++;
  state.lastQuotaAt = Date.now();
  state.consecutive429++;
  if (retryAfterMs > 0) state.lastRetryAfterMs = Math.min(retryAfterMs, 300000);
  try { dbg({ act: 'quota-hit', hits: state.quotaHits, consec: state.consecutive429 }); } catch {}
}
// "Blížím se limitu" — další request radši rovnou přes proxy (rychlé přepnutí bez čekání na další 429).
function shouldUseProxyFirst() {
  if (!counts().total) return false;
  const sinceQuota = Date.now() - (state.lastQuotaAt || 0);
  if (state.consecutive429 >= 1 && sinceQuota < 5 * 60 * 1000) return true; // čerstvá 429 → jeď přes proxy
  if (state.proxyActive && sinceQuota < 10 * 60 * 1000) return true;        // už jedeme přes proxy → držet
  return false;
}
function onProxySwitch(proxy) {
  state.proxyActive = true;
  state.current = proxy ? proxy.str : null;
  state.switches++;
  try { dbg({ act: 'switch', proxy: state.current, switches: state.switches }); } catch {}
}
function onDirectOk() {
  // úspěch napřímo po odeznění quota → vrátit se na direct (rychlejší než free proxy)
  if (state.proxyActive && (Date.now() - state.lastQuotaAt) > 10 * 60 * 1000) {
    state.proxyActive = false; state.current = null;
  }
}

/* ---------- tunely ---------- */
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => { clearTimeout(t); resolve(s); });
    s.on('error', (e) => { clearTimeout(t); try { s.destroy(); } catch {} reject(e); });
    const t = setTimeout(() => { try { s.destroy(); } catch {} reject(new Error('proxy connect timeout')); }, timeoutMs || 8000);
    s.on('close', () => clearTimeout(t));
  });
}
function viaHttpProxy(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await tcpConnect(proxyHost, proxyPort, timeoutMs); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('proxy CONNECT timeout')); }, timeoutMs || 8000);
    const onErr = (e) => { clearTimeout(t); try { sock.destroy(); } catch {} reject(e); };
    sock.once('error', onErr);
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(t);
        sock.removeListener('error', onErr);
        if (/^HTTP\/1\.[01] 200/i.test(buf)) resolve(sock);
        else { try { sock.destroy(); } catch {} reject(new Error('proxy CONNECT refused: ' + buf.split('\r\n')[0].slice(0, 80))); }
      }
      if (buf.length > 8192) { clearTimeout(t); try { sock.destroy(); } catch {} reject(new Error('proxy CONNECT bad reply')); }
    });
    sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\nConnection: Keep-Alive\r\n\r\n`);
  });
}
function viaSocks5(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await tcpConnect(proxyHost, proxyPort, timeoutMs); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('socks5 timeout')); }, timeoutMs || 8000);
    const fail = (m) => { clearTimeout(t); try { sock.destroy(); } catch {} reject(new Error(m)); };
    // handshake: VER(05) NMETHODS(01) METHOD(00=no auth)
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    let step = 0;
    sock.on('data', (c) => {
      try {
        if (step === 0) {
          if (c.length < 2 || c[0] !== 0x05 || c[1] !== 0x00) return fail('socks5 auth refused');
          // request: VER(05) CMD(01=connect) RSV(00) ATYP(03=domain) LEN + host + port
          const hb = Buffer.from(targetHost, 'utf-8');
          const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]);
          step = 1;
          sock.write(req);
        } else if (step === 1) {
          if (c.length < 2 || c[0] !== 0x05 || c[1] !== 0x00) return fail('socks5 connect refused');
          clearTimeout(t);
          sock.removeAllListeners('data');
          resolve(sock);
        }
      } catch (e) { fail('socks5 error'); }
    });
    sock.once('error', fail);
  });
}
function viaSocks4(proxyHost, proxyPort, targetHost, targetPort, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await tcpConnect(proxyHost, proxyPort, timeoutMs); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('socks4 timeout')); }, timeoutMs || 8000);
    const fail = (m) => { clearTimeout(t); try { sock.destroy(); } catch {} reject(new Error(m)); };
    // SOCKS4: VER(04) CMD(01) PORT(2) IP(4) USERID(00). IP musí být číselná → hostname neumí, zkusit DNS předem.
    const doConnect = (ipStr) => {
      const parts = String(ipStr).split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return fail('socks4 needs IPv4 target');
      const req = Buffer.from([0x04, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff, parts[0], parts[1], parts[2], parts[3], 0x00]);
      sock.once('data', (c) => {
        if (c.length >= 2 && c[0] === 0x00 && c[1] === 0x5a) { clearTimeout(t); sock.removeAllListeners('data'); resolve(sock); }
        else fail('socks4 refused');
      });
      sock.write(req);
    };
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(targetHost)) doConnect(targetHost);
    else {
      // přeložit hostname → IPv4 (opencode.ai)
      require('dns').lookup(targetHost, { family: 4 }, (err, addr) => {
        if (err || !addr) return fail('socks4 dns fail');
        doConnect(addr);
      });
    }
    sock.once('error', fail);
  });
}
async function tunnelSocket(proxy, targetHost, targetPort, timeoutMs) {
  if (proxy.type === 'socks5') return viaSocks5(proxy.host, proxy.port, targetHost, targetPort, timeoutMs);
  if (proxy.type === 'socks4') return viaSocks4(proxy.host, proxy.port, targetHost, targetPort, timeoutMs);
  return viaHttpProxy(proxy.host, proxy.port, targetHost, targetPort, timeoutMs);
}

/* ---------- POST stream přes proxy (https cíl) ----------
   Použití pro bránu opencode: POST https://opencode.ai/zen/v1/...
   Volá cb {onHead(status,headers), onChunk(str), onEnd(), onError(err)}.
   Vrací {abort()} pro zrušení. */
function postStreamViaProxy(targetUrl, opts, cb) {
  const o = opts || {};
  const c = cb || {};
  const u = new URL(targetUrl);
  const isHttps = u.protocol === 'https:';
  const targetPort = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
  const proxy = o.proxy;
  let dead = false;
  let sock = null;
  let tlsSock = null;
  let req = null;
  const api = { abort() { dead = true; try { req && req.destroy(); } catch {} try { tlsSock && tlsSock.destroy(); } catch {} try { sock && sock.destroy(); } catch {} } };
  (async () => {
    try {
      sock = await tunnelSocket(proxy, u.hostname, targetPort, o.connectTimeout || 8000);
      if (dead) { try { sock.destroy(); } catch {} return; }
      const doRequest = (stream) => {
        const mod = isHttps ? https : http;
        const reqOpts = {
          host: u.hostname, port: targetPort, path: u.pathname + (u.search || ''),
          method: o.method || 'POST',
          headers: o.headers || {},
          createConnection: () => stream,
          servername: isHttps ? u.hostname : undefined,
        };
        try {
          req = mod.request(reqOpts, (res) => {
            try { c.onHead && c.onHead(res.statusCode, res.headers); } catch {}
            res.on('data', (ch) => { try { c.onChunk && c.onChunk(ch.toString()); } catch {} });
            res.on('end', () => { try { c.onEnd && c.onEnd(); } catch {} });
            res.on('close', () => { try { c.onEnd && c.onEnd(); } catch {} });
            res.on('error', (e) => { try { c.onError && c.onError(e); } catch {} });
          });
          req.on('error', (e) => { try { c.onError && c.onError(e); } catch {} });
          req.setTimeout(o.timeout || 60000, () => {
            try { req.destroy(new Error('timeout 60s (proxy)')); } catch {}
            try { c.onError && c.onError(new Error('timeout 60s (proxy)')); } catch {}
          });
          if (o.body) req.write(o.body);
          req.end();
        } catch (e) { try { c.onError && c.onError(e); } catch {} }
      };
      if (isHttps) {
        tlsSock = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: true });
        tlsSock.once('error', (e) => { try { c.onError && c.onError(e); } catch {} });
        tlsSock.once('secureConnect', () => doRequest(tlsSock));
        setTimeout(() => { if (!tlsSock.authorized && !tlsSock.encrypted) { try { tlsSock.destroy(); } catch {} try { c.onError && c.onError(new Error('tls timeout (proxy)')); } catch {} } }, o.connectTimeout || 8000);
      } else doRequest(sock);
    } catch (e) { try { c.onError && c.onError(e); } catch {} }
  })();
  return api;
}

/* ---------- jednoduchý GET/POST přes proxy (ne-stream, např. /models) ---------- */
function fetchViaProxy(targetUrl, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    let status = 0, headers = {}, body = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const api = postStreamViaProxy(targetUrl, {
      method: o.method || 'GET', headers: o.headers || {}, body: o.body || null,
      proxy: o.proxy, connectTimeout: o.connectTimeout || 8000, timeout: o.timeout || 12000,
    }, {
      onHead: (st, h) => { status = st; headers = h || {}; },
      onChunk: (ch) => { body += ch; if (body.length > 2 * 1024 * 1024) { try { api.abort(); } catch {} done({ ok: false, error: 'too large' }); } },
      onEnd: () => done({ ok: status >= 200 && status < 300, status, headers, body }),
      onError: (e) => done({ ok: false, error: String((e && e.message) || e) }),
    });
    setTimeout(() => done({ ok: false, error: 'timeout' }), (o.timeout || 12000) + 2000);
  });
}

function status() {
  return {
    counts: counts(), loadedAt: state.loadedAt,
    quotaHits: state.quotaHits, consecutive429: state.consecutive429,
    lastQuotaAt: state.lastQuotaAt, lastRetryAfterMs: state.lastRetryAfterMs,
    proxyActive: state.proxyActive, current: state.current, switches: state.switches,
    preferProxy: shouldUseProxyFirst(),
  };
}

module.exports = {
  loadProxies, refreshProxies, counts, status,
  getRandomProxy, markBad, markGood,
  isQuotaBody, isQuotaStatus, isGeoBlockedBody,
  onQuotaHit, onProxySwitch, onDirectOk, shouldUseProxyFirst,
  postStreamViaProxy, fetchViaProxy,
  bundledDir,
};
