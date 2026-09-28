import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// Správa verzí aplikace.
// GET → list. POST { action, ... }:
//   upsert { version, download_url, notes } · block { version } · unblock { version }
//   setLatest { version } · remove { version }
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    if (req.method === 'GET') {
      const rows = await sql`SELECT version, download_url, notes, blocked, is_latest, released_at
        FROM app_versions ORDER BY released_at DESC`;
      return res.status(200).json({ ok: true, versions: rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const b = body || {};
    const v = String(b.version || '').slice(0, 32);
    if (b.action === 'upsert') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      const url = String(b.download_url || '').slice(0, 500);
      const notes = String(b.notes || '').slice(0, 2000);
      await sql`INSERT INTO app_versions (version, download_url, notes)
        VALUES (${v}, ${url}, ${notes})
        ON CONFLICT (version) DO UPDATE SET download_url = EXCLUDED.download_url, notes = EXCLUDED.notes`;
      // První verze se automaticky stane latest
      const c = await sql`SELECT COUNT(*)::int AS c FROM app_versions WHERE is_latest`;
      if (c[0].c === 0) await sql`UPDATE app_versions SET is_latest = (version = ${v})`;
    } else if (b.action === 'block' || b.action === 'unblock') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      await sql`UPDATE app_versions SET blocked = ${b.action === 'block'} WHERE version = ${v}`;
    } else if (b.action === 'setLatest') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      await sql`UPDATE app_versions SET is_latest = (version = ${v})`;
    } else if (b.action === 'remove') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      await sql`DELETE FROM app_versions WHERE version = ${v}`;
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    }
    const rows = await sql`SELECT version, download_url, notes, blocked, is_latest, released_at
      FROM app_versions ORDER BY released_at DESC`;
    return res.status(200).json({ ok: true, versions: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
