import { requireAdmin } from '../_auth.js';
import { listFiles, currentRelease, folderUrl } from '../_releases.js';

// Co je zrovna ve složce NolimitWebsite/Downloads Updates (GitHub) — jen pro čtení.
// Instalátory se do složky neposílají přes admin, ale zkopírováním + gitem.
export default async function handler(req, res) {
  const a = await requireAdmin(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  try {
    const files = await listFiles();
    const cur = await currentRelease();
    return res.status(200).json({ ok: true, current: cur, files, folderUrl: folderUrl() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
}
