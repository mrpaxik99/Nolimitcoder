import { db, ensureSchema } from './_db.js';

function normVer(s) {
  return String(s || '').trim().toLowerCase().replace(/^[v=\s]+/, '');
}

// Číselné srovnání verzí — "1.0" se rovná "1.0.0" (odpovídá tomu, co hlásí Electron).
function cmpVer(a, b) {
  const pa = normVer(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = normVer(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Veřejný endpoint pro desktopovou aplikaci: GET /api/app-status?version=1.0.0
//
// Pravidlo: funguje JEN verze, která je právě v Downloads — bere se ta samá
// řádka, kterou posílá i /api/download. Cokoliv jiného je zablokované a
// aplikace ukáže důvod + tlačítko Aktualizovat (stáhne a tiše přeinstaluje
// novou verzi).
//
// Žádné ruční přepínače — kill-switch ani minimální povolená verze už
// neexistují. Fail-open: když není publikovaná žádná verze, nebo vypadne
// síť/DB, nikdo se neblokuje.
export default async function handler(req, res) {
  const version = String((req.query && req.query.version) || '').slice(0, 32);
  const nv = normVer(version);
  try {
    await ensureSchema();
    const sql = db();
    const rows = await sql`SELECT version, download_url, notes, is_latest, released_at
      FROM app_versions ORDER BY is_latest DESC, released_at DESC LIMIT 1`;
    const latest = rows && rows[0] ? rows[0] : null;
    const blocked = !!(latest && nv && cmpVer(nv, latest.version) !== 0);
    const reason = blocked
      ? 'A newer version is required (minimum ' + latest.version + '). Please download the latest version.'
      : '';
    return res.status(200).json({
      ok: true,
      blocked,
      reason,
      minVersion: latest ? normVer(latest.version) : '',
      latest,
      checkedVersion: version
    });
  } catch (e) {
    return res.status(200).json({ ok: false, blocked: false });
  }
}
