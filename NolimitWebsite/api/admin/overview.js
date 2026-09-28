import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// GET /api/admin/overview — zákazníci, plány, tržby.
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    const users = await sql`SELECT email, name, first_seen, last_seen, plan, plan_status, total_paid_cents
      FROM users ORDER BY last_seen DESC LIMIT 500`;
    const counts = await sql`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE plan_status = 'active')::int AS paid,
      COUNT(*) FILTER (WHERE plan = 'trial' OR plan_status = 'trial')::int AS trial,
      COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours')::int AS active24h
      FROM users`;
    const rev = await sql`SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS revenue_cents,
      COUNT(*) FILTER (WHERE status = 'paid')::int AS sales
      FROM orders`;
    const orders = await sql`SELECT id, email, amount_cents, currency, status, note, created_at
      FROM orders ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ ok: true, users, counts: counts[0], revenue: rev[0], orders });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
