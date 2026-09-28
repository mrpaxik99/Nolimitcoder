import { handleUpload } from '@vercel/blob/client';
import { requireAdmin } from '../_auth.js';

// Token pro přímý upload .exe z prohlížeče do Vercel Blob (obchází 4,5MB limit funkcí).
// Klient volá: /api/admin/blob-token?token=<Google ID token>
export default async function handler(req, res) {
  const rawToken = (req.query && req.query.token) || '';
  const reqWithAuth = {
    ...req,
    headers: { ...(req.headers || {}), authorization: 'Bearer ' + rawToken }
  };
  const a = await requireAdmin(reqWithAuth);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const resp = await handleUpload({
      body: body || {},
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          'application/x-msdownload',
          'application/x-dosexec',
          'application/octet-stream',
          'binary/octet-stream',
          'application/x-msdos-program'
        ],
        maximumSizeInBytes: 300 * 1024 * 1024, // 300 MB rezerva (exe má ~82 MB)
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ by: a.email })
      }),
      onUploadCompleted: async () => {}
    });
    return res.status(200).json(resp);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
