import { currentRelease, cmpVer } from './_releases.js';

function normVer(s) {
  return String(s || '').trim().toLowerCase().replace(/^[v=\s]+/, '');
}

// Veřejný endpoint pro desktopovou aplikaci: GET /api/app-status?version=1.0.0
//
// Pravidlo: funguje JEN verze, která je právě ve složce NolimitWebsite/Downloads
// Updates — bere se ta samá verze, kterou posílá i /api/download. Cokoliv jiného
// je zablokované a aplikace ukáže důvod + tlačítko Aktualizovat (stáhne a tiše
// přeinstaluje novou verzi).
//
// Žádné ruční přepínače — kill-switch ani minimální povolená verze neexistují.
// Fail-open: výpadek GitHubu, prázdná složka nebo chyba = nikdo se neblokuje.
export default async function handler(req, res) {
  const version = String((req.query && req.query.version) || '').slice(0, 32);
  const nv = normVer(version);
  try {
    const cur = await currentRelease();
    const allowed = cur && cur.version ? normVer(cur.version) : '';
    const blocked = !!(allowed && nv && cmpVer(nv, allowed) !== 0);
    const reason = blocked
      ? 'A newer version is required (minimum ' + cur.version + '). Please download the latest version.'
      : '';
    return res.status(200).json({
      ok: true,
      blocked,
      reason,
      minVersion: allowed,
      latest: cur ? {
        version: cur.version,
        notes: cur.name,
        download_url: cur.url,
        size_bytes: cur.size,
        is_latest: true
      } : null,
      checkedVersion: version
    });
  } catch (e) {
    return res.status(200).json({ ok: false, blocked: false, reason: '', minVersion: '', latest: null, checkedVersion: version });
  }
}
