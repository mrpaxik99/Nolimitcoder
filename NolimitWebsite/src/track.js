// Tichý tracking návštěv + heartbeat "online" (Neon přes /api/track).
// Web nikdy nerozbije — chyby se ignorují. Importují ho všechny stránky.
(function () {
  function user() {
    try { return JSON.parse(localStorage.getItem('nolimit_user')); } catch (e) { return null; }
  }
  function send() {
    try {
      const u = user() || {};
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: String(location.pathname || '').slice(0, 200),
          email: u.email || '',
          name: u.name || ''
        }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }
  send();
  setInterval(send, 60000); // heartbeat → sekce Analytics / online uživatelé
})();
