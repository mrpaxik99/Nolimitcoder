import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// GET /api/admin/analytics — návštěvnost, online, prodeje.
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    const tot = await sql`SELECT COUNT(*)::int AS visits,
      COUNT(DISTINCT email) FILTER (WHERE email IS NOT NULL)::int AS visitors
      FROM visits`;
    const perDay = await sql`SELECT TO_CHAR(DATE_TRUNC('day', ts), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS visits,
      COUNT(DISTINCT email) FILTER (WHERE email IS NOT NULL)::int AS visitors
      FROM visits WHERE ts > NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1`;
    const perWeek = await sql`SELECT TO_CHAR(DATE_TRUNC('week', ts), 'YYYY-MM-DD') AS week,
      COUNT(*)::int AS visits
      FROM visits WHERE ts > NOW() - INTERVAL '12 weeks'
      GROUP BY 1 ORDER BY 1`;
    const perMonth = await sql`SELECT TO_CHAR(DATE_TRUNC('month', ts), 'YYYY-MM') AS month,
      COUNT(*)::int AS visits
      FROM visits WHERE ts > NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1`;
    const sums = await sql`SELECT
      COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours')::int AS d1,
      COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '7 days')::int AS w1,
      COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '30 days')::int AS m1
      FROM visits`;
    const online = await sql`SELECT email, name, last_seen FROM presence
      WHERE last_seen > NOW() - INTERVAL '3 minutes' ORDER BY last_seen DESC LIMIT 100`;
    const onlineCount = await sql`SELECT COUNT(*)::int AS c FROM presence
      WHERE last_seen > NOW() - INTERVAL '3 minutes'`;
    const sales = await sql`SELECT
      COUNT(*) FILTER (WHERE status = 'paid')::int AS count,
      COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS revenue_cents,
      TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month
      FROM orders GROUP BY 3 ORDER BY 3 DESC LIMIT 12`;
    const salesTot = await sql`SELECT COUNT(*) FILTER (WHERE status = 'paid')::int AS count,
      COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint AS revenue_cents,
      COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid' AND created_at > NOW() - INTERVAL '30 days'), 0)::bigint AS revenue30d
      FROM orders`;
    return res.status(200).json({
      ok: true,
      total: tot[0], sums: sums[0],
      perDay, perWeek, perMonth,
      online: online, onlineCount: onlineCount[0].c,
      sales, salesTotal: salesTot[0]
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
