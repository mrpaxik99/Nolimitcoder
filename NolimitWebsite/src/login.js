import '../style.css';
import './track.js';

// Google Client ID comes from the VITE_GOOGLE_CLIENT_ID env variable
// (.env locally, Vercel → Project Settings → Environment Variables).
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
}

function onGoogleLogin(resp) {
  const profile = parseJwt(resp.credential) || {};
  try {
    // ID token pro admin API (sessionStorage — po zavření záložky zmizí)
    try { sessionStorage.setItem('nolimit_cred', resp.credential); } catch (e) {}
    localStorage.setItem('nolimit_user', JSON.stringify({
      name: profile.name || 'User',
      email: profile.email || '',
      picture: profile.picture || ''
    }));
  } catch (e) {}
  location.href = './index.html';
}

window.onGoogleLogin = onGoogleLogin;

window.addEventListener('load', () => {
  const note = document.getElementById('loginNote');
  if (!CLIENT_ID) {
    if (note) note.style.display = '';
    return;
  }
  if (note) note.style.display = 'none';
  if (!window.google || !window.google.accounts) return;
  window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onGoogleLogin });
  const target = document.getElementById('googleBtn');
  if (target) {
    window.google.accounts.id.renderButton(target, {
      type: 'standard', shape: 'pill', theme: 'filled_black',
      size: 'large', text: 'continue_with', logo_alignment: 'left'
    });
  }
});
