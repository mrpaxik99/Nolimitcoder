import { db, ensureSchema } from '../_db.js';
import { requireAdmin } from '../_auth.js';
import { del } from '@vercel/blob';

async function listVersions(sql) {
  return sql`SELECT version, download_url, notes, blocked, is_latest, released_at
    FROM app_versions ORDER BY released_at DESC`;
}

async function dropBlobFile(url) {
  try {
    if (url && /blob\.vercel-storage\.com/i.test(url)) await del(url);
  } catch {}
}

// Správa verzí aplikace — drží se max 2, nejnovější je vždy Latest a nejde zastavit.
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
      return res.status(200).json({ ok: true, versions: await listVersions(sql) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const b = body || {};
    const v = String(b.version || '').slice(0, 32);

    if (b.action === 'upsert') {
      if (!v) return res.status(400).json({ ok: false, error: 'Zadej verzi.' });
      const url = String(b.download_url || '').slice(0, 1000);
      if (!url) return res.status(400).json({ ok: false, error: 'Nejdřív nahraj .exe z počítače.' });
      const notes = String(b.notes || '').slice(0, 2000);
      await sql`INSERT INTO app_versions (version, download_url, notes, released_at)
        VALUES (${v}, ${url}, ${notes}, NOW())
        ON CONFLICT (version) DO UPDATE SET download_url = EXCLUDED.download_url, notes = EXCLUDED.notes`;
      // Nová verze = automaticky Latest (stará tím pádem přestává platit)
      await sql`UPDATE app_versions SET is_latest = (version = ${v})`;
      // Rolling okno max 2 — nejstarší (kromě právě nahrané) se smaže i se souborem
      const rows = await sql`SELECT version, download_url FROM app_versions
        WHERE version <> ${v} ORDER BY released_at ASC`;
      if (rows.length > 1) {
        const victims = rows.slice(0, rows.length - 1);
        for (const vic of victims) {
          await sql`DELETE FROM app_versions WHERE version = ${vic.version}`;
          await dropBlobFile(vic.download_url);
        }
      }
    } else if (b.action === 'block' || b.action === 'unblock') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      if (b.action === 'block') {
        const cur = await sql`SELECT is_latest FROM app_versions WHERE version = ${v}`;
        if (cur[0] && cur[0].is_latest) {
          return res.status(400).json({ ok: false, error: 'Nejnovější verzi nelze zastavit — zastavit jde jen starší.' });
        }
        // Blokace verze, co ještě nemá řádek (např. z Hlášení aplikací) → řádek se vytvoří
        await sql`INSERT INTO app_versions (version, blocked) VALUES (${v}, TRUE)
          ON CONFLICT (version) DO UPDATE SET blocked = TRUE`;
      } else {
        await sql`UPDATE app_versions SET blocked = FALSE WHERE version = ${v}`;
      }
    } else if (b.action === 'setLatest') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      await sql`UPDATE app_versions SET is_latest = (version = ${v})`;
    } else if (b.action === 'remove') {
      if (!v) return res.status(400).json({ ok: false, error: 'Missing version.' });
      const gone = await sql`DELETE FROM app_versions WHERE version = ${v} RETURNING download_url, is_latest`;
      if (gone[0]) await dropBlobFile(gone[0].download_url);
      // Když zmizela Latest, povýší se nejnovější zbývající (app-status nikdy nevrací prázdno)
      if (gone[0] && gone[0].is_latest) {
        await sql`UPDATE app_versions SET is_latest = TRUE
          WHERE version = (SELECT version FROM app_versions ORDER BY released_at DESC LIMIT 1)`;
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    }
    return res.status(200).json({ ok: true, versions: await listVersions(sql) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
