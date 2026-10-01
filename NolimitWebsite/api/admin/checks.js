import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// Hlášení aplikací (Developer sekce).
// GET  → posledních 50 hlášení (jaké verze se reálně hlásí). U každého řádku
//        `versionBlocked` = jestli je ta konkrétní verze zablokovaná v app_versions
//        (samotný badge blocked může být i kvůli kill-switchi nebo minimální verzi).
// POST { action, version }:
//        unblock → odblokuje verzi (sekce Developer / Updates)
//        delete  → smaže VŠECHNA hlášení této verze a zároveň ji odblokuje;
//                  verze, která vznikla jen blokací (žádný nahraný soubor),
//                  se smaže i z app_versions, ať nezůstává v seznamu Updates
async function listChecks(sql) {
  const rows = await sql`SELECT version, blocked, ts FROM app_checks
    ORDER BY ts DESC LIMIT 50`;
  const vers = await sql`SELECT version, blocked FROM app_versions`;
  const blockedMap = {};
  for (const v of vers) blockedMap[String(v.version)] = !!v.blocked;
  return rows.map(r => ({ ...r, versionBlocked: !!blockedMap[String(r.version)] }));
}

export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, checks: await listChecks(sql) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const b = body || {};
    const v = String(b.version || '').trim().slice(0, 32);
    if (!v || v === '(none)') return res.status(400).json({ ok: false, error: 'Chybí verze.' });

    if (b.action === 'unblock') {
      await sql`UPDATE app_versions SET blocked = FALSE WHERE version = ${v}`;
    } else if (b.action === 'delete') {
      await sql`DELETE FROM app_checks WHERE version = ${v}`;
      await sql`UPDATE app_versions SET blocked = FALSE WHERE version = ${v}`;
      // řádek vytvořený jen blokací (bez nahraného .exe) — pryč, ať nezůstává v Updates
      await sql`DELETE FROM app_versions
        WHERE version = ${v} AND (download_url IS NULL OR download_url = '') AND is_latest = FALSE`;
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    }
    return res.status(200).json({ ok: true, checks: await listChecks(sql) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
