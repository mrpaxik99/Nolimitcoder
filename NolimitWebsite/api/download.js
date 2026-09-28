import { db, ensureSchema, markSchemaStale } from './_db.js';

// Veřejné stahování aktuální verze: GET /api/download → 302 na download_url Latest verze.
// Tlačítka „Stáhnout" na webu vedou sem, takže vždy tahají nejnovější build.
export default async function handler(req, res) {
  try {
    await ensureSchema();
    const sql = db();
    const run = () => sql`SELECT version, download_url FROM app_versions
      ORDER BY is_latest DESC, released_at DESC LIMIT 1`;
    let rows;
    try {
      rows = await run();
    } catch (e) {
      if (markSchemaStale(e)) { await ensureSchema(); rows = await run(); }
      else throw e;
    }
    const latest = rows && rows[0];
    if (!latest || !latest.download_url) {
      return res.status(404).send('No version published yet.');
    }
    try {
      await sql`INSERT INTO visits (email, path) VALUES (NULL, '/api/download')`;
    } catch {}
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, latest.download_url);
  } catch (e) {
    return res.status(500).send('Download unavailable.');
  }
}
