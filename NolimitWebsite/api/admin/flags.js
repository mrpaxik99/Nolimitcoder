import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';

// Kill-switch + minimální verze.
// GET → { kill_switch: {blocked,message}, min_version: {version} }
// POST { key: 'kill_switch'|'min_version', value: {...} }
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    await ensureSchema();
    const sql = db();
    if (req.method === 'GET') {
      const rows = await sql`SELECT key, value FROM app_flags WHERE key IN ('kill_switch', 'min_version')`;
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value || {}]));
      return res.status(200).json({
        ok: true,
        kill_switch: map.kill_switch || { blocked: false, message: '' },
        min_version: map.min_version || { version: '' }
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const b = body || {};
    if (!['kill_switch', 'min_version'].includes(b.key)) {
      return res.status(400).json({ ok: false, error: 'Unknown key.' });
    }
    await sql`INSERT INTO app_flags (key, value) VALUES (${b.key}, ${JSON.stringify(b.value || {})}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
