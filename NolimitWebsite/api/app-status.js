import { db, ensureSchema } from './_db.js';

function normVer(s) {
  return String(s || '').trim().toLowerCase().replace(/^[v=\s]+/, '');
}
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Veřejný endpoint pro desktopovou aplikaci: GET /api/app-status?version=3.0.13
// Fail-open: při výpadku se aplikace nezastaví, blokuje jen explicitní příkaz z adminu.
export default async function handler(req, res) {
  const version = String((req.query && req.query.version) || '').slice(0, 32);
  try {
    await ensureSchema();
    const sql = db();
    const flags = await sql`SELECT key, value FROM app_flags WHERE key IN ('kill_switch', 'min_version')`;
    const map = Object.fromEntries(flags.map((f) => [f.key, f.value || {}]));
    const kill = map.kill_switch || {};
    const minV = String((map.min_version && map.min_version.version) || '');
    const rows = await sql`SELECT version, download_url, notes, blocked, is_latest, released_at
      FROM app_versions ORDER BY released_at DESC`;
    const latest = rows.find((r) => r.is_latest) || rows[0] || null;
    const mine = version ? rows.find((r) => r.version === version) : null;

    let blocked = false;
    let reason = '';
    if (kill.blocked) {
      blocked = true;
      reason = String(kill.message || 'This app version has been stopped by the developer. Please download the latest version.');
    } else if (mine && mine.blocked) {
      blocked = true;
      reason = 'This version is no longer supported. Please download the latest version.';
    } else if (minV && version && cmpVer(version, minV) < 0) {
      blocked = true;
      reason = 'A newer version is required (minimum ' + minV + '). Please download the latest version.';
    }
    return res.status(200).json({ ok: true, blocked, reason, minVersion: minV, latest });
  } catch (e) {
    return res.status(200).json({ ok: false, blocked: false });
  }
}
