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

// ---------- Developer: kill-switch ----------
async function loadFlags() {
  const j = await api('/api/admin/flags');
  const kill = j.kill_switch || {};
  const box = document.getElementById('killBox');
  const on = !!kill.blocked;
  box.classList.toggle('stopped', on);
  document.getElementById('killTitle').textContent = on ? 'App is STOPPED' : 'App is running';
  document.getElementById('killSub').textContent = on
    ? 'Staré aplikace se zastaví a musí stáhnout novou.'
    : 'Kill-switch je vypnutý.';
  document.getElementById('killToggle').textContent = on ? 'Povolit aplikaci' : 'Zastavit starou aplikaci';
  if (document.activeElement !== document.getElementById('killMsg')) {
    document.getElementById('killMsg').value = kill.message || '';
  }
  document.getElementById('minVer').value = (j.min_version && j.min_version.version) || '';
  return j;
}
document.getElementById('killToggle').addEventListener('click', async () => {
  showErr(''); showOk('');
  try {
    const cur = await api('/api/admin/flags');
    const on = !((cur.kill_switch || {}).blocked);
    await api('/api/admin/flags', { method: 'POST', body: JSON.stringify({
      key: 'kill_switch',
      value: { blocked: on, message: document.getElementById('killMsg').value || '' }
    }) });
    await loadFlags();
    showOk(on ? 'Aplikace zastavena.' : 'Aplikace povolena.');
  } catch (e) { showErr(e.message); }
});
document.getElementById('killSave').addEventListener('click', async () => {
  showErr(''); showOk('');
  try {
    const cur = await api('/api/admin/flags');
    await api('/api/admin/flags', { method: 'POST', body: JSON.stringify({
      key: 'kill_switch',
      value: { blocked: !!((cur.kill_switch || {}).blocked), message: document.getElementById('killMsg').value || '' }
    }) });
    await api('/api/admin/flags', { method: 'POST', body: JSON.stringify({
      key: 'min_version', value: { version: document.getElementById('minVer').value.trim() }
    }) });
    await loadFlags();
    showOk('Uloženo.');
  } catch (e) { showErr(e.message); }
});

// ---------- Updates: verze ----------
async function loadVersions() {
  const j = await api('/api/admin/versions');
  const tb = document.getElementById('upList');
  const vs = j.versions || [];
  if (!vs.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">Zatím žádná verze.</td></tr>'; return; }
  tb.innerHTML = vs.map((v) =>
    '<tr><td class="mono"><b>' + esc(v.version) + '</b></td>' +
    '<td>' + (v.is_latest ? '<span class="badge green">LATEST</span> ' : '') +
      (v.blocked ? '<span class="badge red">BLOCKED</span>' : '<span class="badge">live</span>') + '</td>' +
    '<td>' + (v.download_url ? '<a href="' + esc(v.download_url) + '">stáhnout</a>' : '<span class="muted">—</span>') + '</td>' +
    '<td>' + esc(v.notes || '') + '</td>' +
    '<td style="white-space:nowrap">' +
      (v.is_latest ? '' : '<button class="mini-btn" data-act="latest" data-v="' + esc(v.version) + '">Latest</button> ') +
      '<button class="mini-btn" data-act="' + (v.blocked ? 'unblock' : 'block') + '" data-v="' + esc(v.version) + '">' +
        (v.blocked ? 'Odblokovat' : 'Zastavit') + '</button> ' +
      '<button class="mini-btn" data-act="remove" data-v="' + esc(v.version) + '">Smazat</button>' +
    '</td></tr>'
  ).join('');
  tb.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const act = b.getAttribute('data-act') === 'latest' ? 'setLatest' : b.getAttribute('data-act');
    if (act === 'remove' && !confirm('Smazat verzi ' + b.getAttribute('data-v') + '?')) return;
    showErr(''); showOk('');
    try {
      await api('/api/admin/versions', { method: 'POST',
        body: JSON.stringify({ action: act, version: b.getAttribute('data-v') }) });
      await loadVersions();
      showOk('Hotovo.');
    } catch (e) { showErr(e.message); }
  }));
}
document.getElementById('upAdd').addEventListener('click', async () => {
  showErr(''); showOk('');
  const version = document.getElementById('upVer').value.trim();
  if (!version) { showErr('Zadej verzi.'); return; }
  try {
    await api('/api/admin/versions', { method: 'POST', body: JSON.stringify({ action: 'upsert',
      version,
      download_url: document.getElementById('upUrl').value.trim(),
      notes: document.getElementById('upNotes').value.trim() }) });
    document.getElementById('upVer').value = '';
    document.getElementById('upUrl').value = '';
    document.getElementById('upNotes').value = '';
    await loadVersions();
    showOk('Verze ' + version + ' nahrána.');
  } catch (e) { showErr(e.message); }
});

// ---------- Customers ----------
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
  document.getElementById('cuList').innerHTML = us.length ? us.map((u) =>
    '<tr><td class="mono">' + esc(u.email) + '</td><td>' + esc(u.name || '') + '</td>' +
    '<td>' + esc(u.plan || 'free') + '</td>' +
    '<td>' + ((u.plan_status === 'active')
      ? '<span class="badge green">paid</span>'
      : '<span class="badge">' + esc(u.plan_status || 'none') + '</span>') + '</td>' +
    '<td>' + money(u.total_paid_cents) + '</td>' +
    '<td class="muted">' + fmtTs(u.first_seen) + '</td>' +
    '<td class="muted">' + fmtTs(u.last_seen) + '</td></tr>'
  ).join('') : '<tr><td colspan="7" class="muted">Zatím nikdo.</td></tr>';
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
    await loadFlags();
    await loadVersions();
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
