import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client();

// Server-side pravda o tom, kdo je admin. Klientské schovávání tlačítek je jen UX,
// tohle je skutečné zabezpečení — každý admin endpoint tímto prochází.
export function adminEmails() {
  const raw = process.env.ADMIN_EMAILS || 'tomaskonarik1977@gmail.com';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function requireAdmin(req) {
  try {
    const hdr = (req.headers && req.headers.authorization) || '';
    const m = String(hdr).match(/^Bearer\s+(.+)$/i);
    if (!m) return { ok: false, status: 401, error: 'Missing token — log in again.' };
    const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || undefined;
    const ticket = await client.verifyIdToken({ idToken: m[1], audience: clientId });
    const p = ticket.getPayload() || {};
    const email = String(p.email || '').toLowerCase();
    if (!email) return { ok: false, status: 401, error: 'Invalid token.' };
    if (!adminEmails().includes(email)) return { ok: false, status: 403, error: 'Not an admin.' };
    return { ok: true, email, name: p.name || '' };
  } catch (e) {
    return { ok: false, status: 401, error: 'Invalid or expired token — log in again.' };
  }
}
