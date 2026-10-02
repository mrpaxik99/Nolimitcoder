import { currentRelease, cmpVer, listVersions, liveWarning } from './_releases.js';

function normVer(s) {
  return String(s || '').trim().toLowerCase().replace(/^[v=\s]+/, '');
}

// Veřejný endpoint pro desktopovou aplikaci: GET /api/app-status?version=1.1.0
//
// Pravidlo: funguje JEN nejvyšší verze, která je právě v repu
// mrpaxik99/NolimitCoder-Download — bere se ta samá verze, kterou posílá i
// /api/download. Cokoliv jiného je zablokované a aplikace ukáže důvod +
// tlačítko Aktualizovat (stáhne a tiše přeinstaluje novou verzi).
//
// Žádné ruční přepínače — kill-switch ani minimální povolená verze neexistují.
// Fail-open: výpadek GitHubu, prázdný repo nebo chyba = nikdo se neblokuje.
// Pravidlo (LIVE z GitHubu, kontroluje se pri kazdem dotazu):
//  - v repu neni zadny .exe = aplikace je momentalne nedostupna (blocked + unavailable)
//  - moje verze je ta nejvyssi v repu = jede (blocked: false)
//  - moje verze v repu vubec neni, nebo neni nejvyssi = zablokovano + tlacitko Aktualizovat
// Warning se taky snima live z WARNING.md v repu a posila se s kazdou odpovedi.
// Fail-open: chyba GitHubu = nikdo se neblokuje (blocked: false).
export default async function handler(req, res) {
  const version = String((req.query && req.query.version) || '').slice(0, 32);
  const nv = normVer(version);
  try {
    const cur = await currentRelease();
    let warning = '';
    try { warning = await liveWarning(); } catch {}
    // V repu vubec nic neni -> nedostupne (ne "zastarle", ale "neni co spustit").
    if (!cur || !cur.version) {
      let versions = [];
      try { versions = await listVersions(); } catch {}
      return res.status(200).json({
        ok: true,
        blocked: true,
        unavailable: true,
        reason: 'Aplikace je momentálně nedostupná. Zkuste to prosím později.',
        warning,
        minVersion: '',
        versions,
        latest: null,
        checkedVersion: version
      });
    }
    const allowed = normVer(cur.version);
    const blocked = !!(allowed && nv && cmpVer(nv, allowed) !== 0);
    let versions = [];
    try { versions = await listVersions(); } catch {}
    const reason = blocked
      ? 'A newer version is required (minimum ' + cur.version + '). Please download the latest version.'
      : '';
    return res.status(200).json({
      ok: true,
      blocked,
      unavailable: false,
      reason,
      warning,
      minVersion: allowed,
      versions,
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
    return res.status(200).json({ ok: false, blocked: false, unavailable: false, reason: '', warning: '', minVersion: '', versions: [], latest: null, checkedVersion: version });
  }
}
