import '../style.css';
import './track.js';

// Admin panel. Klient jen zobrazuje — skutečná kontrola práv je na serveru
// (každý /api/admin/* ověřuje Google ID token + e-mail).
function getUser() {
  try { return JSON.parse(localStorage.getItem('nolimit_user')); } catch (e) { return null; }
}
function cred() {
  try { return sessionStorage.getItem('nolimit_cred') || ''; } catch (e) { return ''; }
}
function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}
function fmtTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const user = getUser();
const token = cred();
if (!user || !token) {
  location.href = './login.html';
}

if (user) {
  if (user.picture) document.getElementById('adAva').innerHTML = '<img src="' + user.picture + '" alt="">';
  document.getElementById('adName').textContent = user.name || 'Admin';
  document.getElementById('adMail').textContent = user.email || '';
  document.getElementById('adLogout').addEventListener('click', () => {
    try { localStorage.removeItem('nolimit_user'); sessionStorage.removeItem('nolimit_cred'); } catch (e) {}
    location.href = './index.html';
  });
}

function showErr(m) {
  const e = document.getElementById('adErr');
  e.textContent = m; e.style.display = m ? '' : 'none';
}
function showOk(m) {
  const e = document.getElementById('adOk');
  e.textContent = m; e.style.display = m ? '' : 'none';
  if (m) setTimeout(() => { e.style.display = 'none'; }, 4000);
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({}, opts || {}, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {},
      { Authorization: 'Bearer ' + token })
  }));
  if (r.status === 401) { location.href = './login.html'; throw new Error('expired'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Error((j && j.error) || 'Not an admin.');
  if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

// Levý panel — sekce
document.querySelectorAll('#adNav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#adNav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.pf-sec').forEach((s) => {
      s.style.display = s.getAttribute('data-spage') === b.getAttribute('data-sec') ? '' : 'none';
    });
  });
});

// ---------- Downloads: instalátory ze složky NolimitWebsite/Downloads Updates ----------
// Nová verze = zkopíruješ .exe do téhle složky a pushneš na GitHub. Nic se neuploaduje.
// Ve složce je vždycky jen to, co se stahuje — a jen ta verze v aplikaci funguje.
async function loadReleases() {
  try {
    const j = await api('/api/admin/releases');
    const cur = j.current;
    const box = document.getElementById('dlCur');
    if (box) {
      box.innerHTML = cur
        ? '<b>Právě jede: ' + esc(cur.version || '(verze v názvu nenalezena)') + '</b>' +
          '<div class="muted">' + esc(cur.name) + ' · ' + Math.round((cur.size || 0) / 1048576) +
          ' MB · jediná verze, která funguje</div>'
        : '<b>Ve složce zatím není žádný instalátor.</b>' +
          '<div class="muted">Zkopíruj .exe do NolimitWebsite/Downloads Updates a pushni na GitHub.</div>';
    }
    const fb = document.getElementById('dlFolder');
    if (fb && j.folderUrl) fb.href = j.folderUrl;
    const files = j.files || [];
    const tb = document.getElementById('dlList');
    if (tb) {
      tb.innerHTML = files.length ? files.map((f) =>
        '<tr><td class="mono">' + esc(f.name) + '</td>' +
        '<td class="mono">' + (f.version ? esc(f.version) : '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + Math.round((f.size || 0) / 1048576) + ' MB</td></tr>'
      ).join('') : '<tr><td colspan="3" class="muted">Složka je prázdná.</td></tr>';
    }
  } catch (e) { /* ticho — sekce není kritická */ }
}

// ---------- Customers ----------
let allUsers = [];
let userFilter = 'all';
let userQuery = '';

function isPaidUser(u) {
  return (u && u.plan_status) === 'active';
}
function renderUsers() {
  const tb = document.getElementById('cuList');
  if (!tb) return;
  const q = (userQuery || '').trim().toLowerCase();
  let list = allUsers.slice();
  if (userFilter === 'paid') list = list.filter(isPaidUser);
  else if (userFilter === 'free') list = list.filter((u) => !isPaidUser(u));
  if (q) list = list.filter((u) =>
    String(u.email || '').toLowerCase().includes(q) ||
    String(u.name || '').toLowerCase().includes(q));
  const nPaid = allUsers.filter(isPaidUser).length;
  const nFree = allUsers.length - nPaid;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ? '(' + v + ')' : ''; };
  set('cuNAll', allUsers.length);
  set('cuNFree', nFree);
  set('cuNPaid', nPaid);
  const cc = document.getElementById('cuModalCount');
  if (cc) cc.textContent = String(list.length);
  tb.innerHTML = list.length ? list.map((u) =>
    '<tr><td class="mono">' + esc(u.email) + '</td><td>' + esc(u.name || '') + '</td>' +
    '<td>' + esc(u.plan || 'free') + '</td>' +
    '<td>' + ((u.plan_status === 'active')
      ? '<span class="badge green">paid</span>'
      : '<span class="badge">' + esc(u.plan_status || 'none') + '</span>') + '</td>' +
    '<td>' + money(u.total_paid_cents) + '</td>' +
    '<td class="muted">' + fmtTs(u.first_seen) + '</td>' +
    '<td class="muted">' + fmtTs(u.last_seen) + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="muted">Nikdo v tomto filtru.</td></tr>';
}
function openUserModal() {
  renderUsers();
  document.getElementById('cuModal').classList.add('on');
}
function closeUserModal() {
  document.getElementById('cuModal').classList.remove('on');
}
document.getElementById('cuOpen').addEventListener('click', openUserModal);
document.getElementById('cuClose').addEventListener('click', closeUserModal);
document.getElementById('cuModal').addEventListener('click', (e) => {
  if (e.target.id === 'cuModal') closeUserModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUserModal();
});
document.querySelectorAll('#cuModal .filter-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#cuModal .filter-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  userFilter = b.getAttribute('data-f') || 'all';
  renderUsers();
}));
document.getElementById('cuSearch').addEventListener('input', (e) => {
  userQuery = e.target.value || '';
  renderUsers();
});
async function loadCustomers() {
  const j = await api('/api/admin/overview');
  const c = j.counts || {};
  document.getElementById('cuCards').innerHTML =
    card('Uživatelů celkem', c.total || 0, 'registrací') +
    card('Placené plány', c.paid || 0, 'Monthly Unlimited') +
    card('Trial / free', c.trial || 0, 'zkouší zdarma') +
    card('Aktivní 24 h', c.active24h || 0, 'na webu / v app') +
    card('Tržby celkem', money((j.revenue || {}).revenue_cents), (j.revenue || {}).sales + ' prodejů') +
    card('Plateb', (j.orders || []).length, 'záznamů');
  const us = j.users || [];
  allUsers = us;
  renderUsers();
  const os = j.orders || [];
  document.getElementById('cuOrders').innerHTML = os.length ? os.map((o) =>
    '<tr><td class="mono">#' + o.id + '</td><td class="mono">' + esc(o.email) + '</td>' +
    '<td>' + money(o.amount_cents) + ' ' + esc(o.currency || '') + '</td>' +
    '<td>' + (o.status === 'paid' ? '<span class="badge green">paid</span>'
      : '<span class="badge">' + esc(o.status) + '</span>') + '</td>' +
    '<td>' + esc(o.note || '') + '</td><td class="muted">' + fmtTs(o.created_at) + '</td></tr>'
  ).join('') : '<tr><td colspan="6" class="muted">Zatím žádné platby.</td></tr>';
}
function card(small, big, sub) {
  return '<div class="pf-card"><small>' + esc(small) + '</small><b>' + esc(String(big)) +
    '</b><span>' + esc(sub) + '</span></div>';
}

// ---------- Analytics ----------
async function loadAnalytics() {
  const j = await api('/api/admin/analytics');
  const t = j.total || {}, s = j.sums || {}, st = j.salesTotal || {};
  document.getElementById('anCards').innerHTML =
    card('Návštěv celkem', t.visits || 0, 'pageviews') +
    card('Návštěvníků', t.visitors || 0, 'přihlášených unikátně') +
    card('Dnes (24 h)', s.d1 || 0, 'návštěv') +
    card('Týden (7 dní)', s.w1 || 0, 'návštěv') +
    card('Měsíc (30 dní)', s.m1 || 0, 'návštěv') +
    card('Právě online', j.onlineCount || 0, 'aktivní do 3 min');
  const days = j.perDay || [];
  const max = Math.max(1, ...days.map((d) => d.visits));
  document.getElementById('anChart').innerHTML = days.map((d) =>
    '<div class="bar" style="height:' + Math.max(3, Math.round((d.visits / max) * 100)) + '%" title="' +
    d.day + ': ' + d.visits + ' návštěv"></div>'
  ).join('') || '<span class="muted">Zatím žádná data.</span>';
  const avg = (n, div) => (div ? ((n || 0) / div).toFixed(1) : '0');
  document.getElementById('anAvgs').innerHTML =
    card('Průměr denně', avg(s.m1, 30) + '/den', 'posledních 30 dní') +
    card('Průměr týdně', avg(s.m1, 30 / 7) + '/týden', 'posledních 30 dní') +
    card('Průměr měsíčně', (s.m1 || 0) + '/měsíc', 'posledních 30 dní') +
    card('Prodejů celkem', st.count || 0, 'zaplacených') +
    card('Tržby celkem', money(st.revenue_cents), 'vše') +
    card('Tržby 30 dní', money(st.revenue30d), 'poslední měsíc');
  const on = j.online || [];
  document.getElementById('anOnlineN').textContent = String(j.onlineCount || 0);
  document.getElementById('anOnline').innerHTML = on.length ? on.map((o) =>
    '<tr><td class="mono">' + esc(o.email) + '</td><td>' + esc(o.name || '') +
    '</td><td class="muted">' + fmtTs(o.last_seen) + '</td></tr>'
  ).join('') : '<tr><td colspan="3" class="muted">Nikdo online.</td></tr>';
  const sl = j.sales || [];
  document.getElementById('anSales').innerHTML = sl.length ? sl.map((r) =>
    '<tr><td class="mono">' + esc(r.month) + '</td><td>' + r.count + '</td><td>' + money(r.revenue_cents) + '</td></tr>'
  ).join('') : '<tr><td colspan="3" class="muted">Zatím žádné prodeje.</td></tr>';
}

// Start — server je zdroj pravdy (403 = nejsi admin)
(async function init() {
  try {
    await loadReleases();
    await loadCustomers();
    await loadAnalytics();
  } catch (e) {
    showErr(e.message === 'expired' ? '' : e.message);
    if (String(e.message).toLowerCase().includes('not an admin')) {
      document.querySelector('.pf-content').innerHTML =
        '<h1>Přístup odepřen</h1><p class="muted">Tato sekce je jen pro administrátora.</p>';
    }
  }
})();
