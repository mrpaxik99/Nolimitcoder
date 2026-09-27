// AI commercial video → MP4 export using local machine power.
// Hidden window renders the ad HTML at the exact resolution, frames are grabbed
// with capturePage() and encoded with a portable ffmpeg (downloaded once).
// No external npm dependencies (pure node + electron).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');

const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function toolsDir(userDataDir) {
  const d = path.join(userDataDir, 'tools');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function ffmpegExePath(userDataDir) {
  return path.join(toolsDir(userDataDir), 'ffmpeg', 'ffmpeg.exe');
}
function ffmpegOk(userDataDir) {
  try {
    const p = ffmpegExePath(userDataDir);
    return fs.existsSync(p) && fs.statSync(p).size > 1000000;
  } catch { return false; }
}

function fetchToFile(url, dest, onProg, redirects) {
  redirects = redirects == null ? 5 : redirects;
  return new Promise((resolve) => {
    const mod = String(url).startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'NolimitCoder-ffmpeg' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchToFile(next, dest, onProg, redirects - 1).then(resolve);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        try { res.resume(); } catch {}
        resolve({ ok: false, error: 'HTTP ' + res.statusCode });
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let got = 0, last = 0;
      const ws = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        try {
          if (total && Date.now() - last > 500) {
            last = Date.now();
            onProg && onProg({ phase: 'ffmpeg', percent: Math.min(99, Math.round(got / total * 100)) });
          }
        } catch {}
      });
      res.pipe(ws);
      ws.on('finish', () => resolve({ ok: true, bytes: got }));
      ws.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(120000);
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
  });
}

function findFfmpegExe(dir) {
  // walk max 3 levels for bin/ffmpeg.exe
  const out = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      try {
        const p = path.join(d, e.name);
        if (e.isFile() && /^ffmpeg(\.exe)?$/i.test(e.name)) out.push(p);
        else if (e.isDirectory()) walk(p, depth + 1);
      } catch {}
    }
  })(dir, 0);
  return out[0] || null;
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve) => {
    // Windows ships bsdtar (tar.exe) which handles .zip — no extra tools needed.
    execFile('tar', ['-xf', zipPath, '-C', destDir], { timeout: 300000, windowsHide: true }, (err) => {
      if (!err) return resolve({ ok: true, via: 'tar' });
      // fallback: PowerShell Expand-Archive
      const ps = 'powershell.exe';
      execFile(ps, ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
        { timeout: 300000, windowsHide: true }, (err2) => {
          if (!err2) resolve({ ok: true, via: 'expand' });
          else resolve({ ok: false, error: String((err2 && err2.message) || err2) });
        });
    });
  });
}

// Portable ffmpeg, downloaded once into userData/tools/ffmpeg.
async function ensureFfmpeg(userDataDir, onProg) {
  if (ffmpegOk(userDataDir)) return { ok: true, path: ffmpegExePath(userDataDir), cached: true };
  try { onProg && onProg({ phase: 'ffmpeg', percent: -1 }); } catch {}
  const tmp = path.join(os.tmpdir(), 'nolimitcoder');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch {}
  const zip = path.join(tmp, 'ffmpeg-essentials.zip');
  const dl = await fetchToFile(FFMPEG_ZIP_URL, zip, onProg);
  if (!dl.ok) return { ok: false, error: 'ffmpeg download failed: ' + dl.error };
  const exDir = path.join(tmp, 'ffmpeg-ex');
  try { fs.rmSync(exDir, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(exDir, { recursive: true }); } catch {}
  const ex = await extractZip(zip, exDir);
  try { fs.rmSync(zip, { force: true }); } catch {}
  if (!ex.ok) return { ok: false, error: 'ffmpeg extract failed: ' + ex.error };
  const found = findFfmpegExe(exDir);
  if (!found) return { ok: false, error: 'ffmpeg.exe not found in archive' };
  const targetDir = path.join(toolsDir(userDataDir), 'ffmpeg');
  try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
  const target = path.join(targetDir, 'ffmpeg.exe');
  try {
    try { fs.rmSync(target, { force: true }); } catch {}
    fs.copyFileSync(found, target);
  } catch (e) { return { ok: false, error: 'ffmpeg install failed: ' + e.message }; }
  try { fs.rmSync(exDir, { recursive: true, force: true }); } catch {}
  if (!ffmpegOk(userDataDir)) return { ok: false, error: 'ffmpeg verify failed' };
  return { ok: true, path: target };
}

function loadHidden(url, width, height) {
  const { BrowserWindow } = require('electron');
  return new Promise((resolve, reject) => {
    let win = null;
    try {
      win = new BrowserWindow({
        width, height, useContentSize: true, show: false,
        backgroundColor: '#000000',
        webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: false }
      });
    } catch (e) { return reject(e); }
    const to = setTimeout(() => { try { win && win.destroy(); } catch {} reject(new Error('page load timeout')); }, 45000);
    win.webContents.once('did-finish-load', () => {
      // let animations/fonts settle, then go
      setTimeout(() => { clearTimeout(to); resolve(win); }, 1500);
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(to);
      try { win.destroy(); } catch {}
      reject(new Error('page load failed: ' + desc));
    });
    win.loadURL(url).catch((e) => {
      clearTimeout(to);
      try { win.destroy(); } catch {}
      reject(e);
    });
  });
}

// Record the page: fps PNG frames for durationSec, then encode to MP4.
async function exportVideo(opts) {
  const o = opts || {};
  const url = String(o.url || '');
  const width = Math.min(Math.max(parseInt(o.width) || 1920, 160), 3840);
  const height = Math.min(Math.max(parseInt(o.height) || 1080, 160), 2160);
  const durationSec = Math.min(Math.max(parseInt(o.durationSec) || 30, 1), 300);
  const fps = Math.min(Math.max(parseInt(o.fps) || 30, 10), 60);
  const outPath = String(o.outPath || '');
  const onProg = o.onProg;
  if (!url || !outPath) return { ok: false, error: 'missing url/outPath' };
  const framesDir = path.join(os.tmpdir(), 'nolimitcoder', 'frames-' + Date.now().toString(36));
  try { fs.mkdirSync(framesDir, { recursive: true }); } catch (e) { return { ok: false, error: 'tmp failed: ' + e.message }; }
  const total = durationSec * fps;
  const stepMs = Math.round(1000 / fps);
  let win = null;
  try {
    win = await loadHidden(url, width, height);
  } catch (e) { return { ok: false, error: e.message }; }
  try {
    for (let i = 0; i < total; i++) {
      const t0 = Date.now();
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(framesDir, 'frame' + String(i + 1).padStart(4, '0') + '.png'), img.toPNG());
      } catch (e) { return { ok: false, error: 'capture failed: ' + e.message }; }
      try { onProg && onProg({ phase: 'frames', done: i + 1, total }); } catch {}
      const wait = stepMs - (Date.now() - t0);
      if (wait > 0 && i + 1 < total) await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    try { win && win.destroy(); } catch {}
    win = null;
  }
  try { onProg && onProg({ phase: 'encode' }); } catch {}
  const ff = ffmpegExePath(o.userDataDir);
  const args = ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', outPath];
  const code = await new Promise((resolve) => {
    const cp = spawn(ff, args, { windowsHide: true, timeout: 600000 });
    cp.on('error', () => resolve(-1));
    cp.on('close', (c) => resolve(c == null ? -1 : c));
  });
  try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
  if (code !== 0 || !fs.existsSync(outPath)) return { ok: false, error: 'ffmpeg encode failed (code ' + code + ')' };
  return { ok: true, path: outPath };
}

module.exports = { ensureFfmpeg, exportVideo, ffmpegOk, ffmpegExePath };
