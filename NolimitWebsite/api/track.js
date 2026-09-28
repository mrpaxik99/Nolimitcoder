import { db, ensureSchema, markSchemaStale } from './_db.js';

// Veřejný endpoint: pageview + heartbeat + upsert uživatele.
// Nikdy nerozbije web — při jakékoliv chybě vrací ok:false s HTTP 200.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const b = body || {};
    const path = String(b.path || '').slice(0, 200);
    const email = String(b.email || '').toLowerCase().slice(0, 160) || null;
    const name = String(b.name || '').slice(0, 120);

    const run = async () => {
      const sql = db();
      if (email) {
        await sql`INSERT INTO users (email, name, last_seen)
          VALUES (${email}, ${name}, NOW())
          ON CONFLICT (email) DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
            last_seen = NOW()`;
        await sql`INSERT INTO presence (email, name, last_seen)
          VALUES (${email}, ${name}, NOW())
          ON CONFLICT (email) DO UPDATE SET
            last_seen = NOW(),
            name = COALESCE(NULLIF(EXCLUDED.name, ''), presence.name)`;
      }
      await sql`INSERT INTO visits (email, path) VALUES (${email}, ${path})`;
    };

    try {
      await run();
    } catch (e) {
      if (markSchemaStale(e)) { await ensureSchema(); await run(); }
      else throw e;
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}
