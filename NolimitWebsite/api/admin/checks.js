import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// GET /api/admin/checks — posledních 50 hlášení aplikací (jaké verze se reálně hlásí).
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    const rows = await sql`SELECT version, blocked, ts FROM app_checks
      ORDER BY ts DESC LIMIT 50`;
    return res.status(200).json({ ok: true, checks: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
