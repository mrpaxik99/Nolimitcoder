import { db, ensureSchema } from './_db.js';
import { currentRelease } from './_releases.js';

// Veřejné stahování: GET /api/download → 302 na instalátor z repa
// mrpaxik99/NolimitCoder-Download (GitHub). Je to ta samá verze, která jediná
// v aplikaci funguje — viz /api/app-status.
export default async function handler(req, res) {
  try {
    const cur = await currentRelease();
    if (!cur || !cur.url) return res.status(404).send('No version published yet.');
    try {
      await ensureSchema();
      const sql = db();
      await sql`INSERT INTO visits (email, path) VALUES (NULL, '/api/download')`;
    } catch {}
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, cur.url);
  } catch (e) {
    return res.status(503).send('Download unavailable.');
  }
}
