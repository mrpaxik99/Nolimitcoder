import '../style.css';

// ---------------------------------------------------------------------------
// Billing data stub. No backend yet, so everything renders from local data.
// TODO(backend): replace loadBilling() with a call to the Vercel endpoint,
// e.g. GET /api/billing with the Google ID token, returning:
// { subscription: { plan: 'monthly-unlimited', price: 14.02, status: 'active' } | null,
//   invoices: [{ id, date, item, amount, status }], totalPaid: number }
// ---------------------------------------------------------------------------
async function loadBilling() {
  return { subscription: null, invoices: [], totalPaid: 0 };
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('nolimit_user')); } catch (e) { return null; }
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

const TRIAL_MS = 24 * 3600 * 1000; // FREE trial lasts 1 day

// ---------------------------------------------------------------------------
// Trial state. For now stored locally; later synced with the app by Google
// account (the app will report claimedAt to the backend).
// TODO(backend): replace with GET /api/trial → { claimedAt: number | null }
// ---------------------------------------------------------------------------
function loadTrial() {
  try { return JSON.parse(localStorage.getItem('nolimit_trial')); } catch (e) { return null; }
}
function saveTrial(t) {
  try { localStorage.setItem('nolimit_trial', JSON.stringify(t)); } catch (e) {}
}
function trialState() {
  const t = loadTrial();
  if (!t || !t.claimedAt) return { status: 'unclaimed' };
  const expiresAt = t.claimedAt + TRIAL_MS;
  const left = expiresAt - Date.now();
  if (left > 0) return { status: 'active', left, expiresAt };
  return { status: 'expired', expiresAt };
}
function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h + ':' + m + ':' + sec;
}
function fmtDate(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
}

function renderTrial() {
  const st = trialState();
  const box = document.getElementById('trialBox');
  const title = document.getElementById('trialTitle');
  const sub = document.getElementById('trialSub');
  const count = document.getElementById('trialCount');
  const sync = document.getElementById('trialSync');
  const ovPlan = document.getElementById('ovPlan');
  const ovPlanSub = document.getElementById('ovPlanSub');
  const ovStatus = document.getElementById('ovStatus');
  const ovStatusSub = document.getElementById('ovStatusSub');
  if (!box) return st;
  box.classList.remove('is-active', 'is-expired');
  if (st.status === 'active') {
    box.classList.add('is-active');
    title.textContent = 'FREE trial — Active';
    sub.textContent = 'Claimed in the app · expires ' + fmtDate(st.expiresAt);
    count.style.display = '';
    count.textContent = fmtLeft(st.left);
    sync.style.display = 'none';
    if (ovPlan) ovPlan.textContent = 'FREE trial';
    if (ovPlanSub) ovPlanSub.textContent = 'claimed in the app';
    if (ovStatus) ovStatus.textContent = 'Active';
    if (ovStatusSub) ovStatusSub.textContent = fmtLeft(st.left) + ' left';
  } else if (st.status === 'expired') {
    box.classList.add('is-expired');
    title.textContent = 'FREE trial — Expired';
    sub.textContent = 'Your 1-day trial ended ' + fmtDate(st.expiresAt) + '. Upgrade to keep going.';
    count.style.display = 'none';
    sync.style.display = 'none';
    if (ovPlan) ovPlan.textContent = 'FREE trial';
    if (ovPlanSub) ovPlanSub.textContent = 'trial used up';
    if (ovStatus) ovStatus.textContent = 'Expired';
    if (ovStatusSub) ovStatusSub.textContent = 'upgrade to Monthly Unlimited';
  } else {
    title.textContent = 'FREE trial — Not claimed';
    sub.textContent = 'Claim your 1-day trial in the app (log in with the same Google account). Auto-sync is coming.';
    count.style.display = 'none';
    sync.style.display = '';
    if (ovPlan) ovPlan.textContent = 'FREE trial';
    if (ovPlanSub) ovPlanSub.textContent = 'not claimed yet';
    if (ovStatus) ovStatus.textContent = 'Inactive';
    if (ovStatusSub) ovStatusSub.textContent = 'claim it in the app';
  }
  return st;
}

const user = getUser();
if (!user) {
  location.href = './login.html';
} else {
  const ava = document.getElementById('pfAva');
  if (user.picture) ava.innerHTML = '<img src="' + user.picture + '" alt="">';
  document.getElementById('pfName').textContent = user.name || 'User';
  document.getElementById('pfMail').textContent = user.email || '';

  document.getElementById('pfLogout').addEventListener('click', () => {
    try { localStorage.removeItem('nolimit_user'); } catch (e) {}
    location.href = './index.html';
  });

  // Trial status + live countdown (ticks every second while active)
  renderTrial();
  document.getElementById('trialSync').addEventListener('click', () => {
    saveTrial({ claimedAt: Date.now() }); // temporary: until the app syncs automatically
    renderTrial();
  });
  setInterval(() => {
    const st = trialState();
    if (st.status === 'active') {
      renderTrial();
    } else if (document.getElementById('trialBox').classList.contains('is-active')) {
      renderTrial(); // just expired → flip to expired state
    }
  }, 1000);

  document.querySelectorAll('.pf-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.pf-nav button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.pf-sec').forEach((s) => {
        s.style.display = s.getAttribute('data-spage') === b.getAttribute('data-sec') ? '' : 'none';
      });
    });
  });

  loadBilling().then((billing) => {
    const sub = billing.subscription;
    if (sub && sub.status === 'active') {
      document.getElementById('ovPlan').textContent = 'Monthly Unlimited';
      document.getElementById('ovPlanSub').textContent = money(sub.price) + '/mo · active';
      document.getElementById('ovStatus').textContent = 'Active';
      document.getElementById('ovStatusSub').textContent = 'renews monthly';
      const cta = document.getElementById('subCta');
      if (cta) { cta.textContent = 'Manage subscription'; cta.setAttribute('href', './payment.html?plan=unlimited'); }
    }
    document.getElementById('ovTotal').textContent = money(billing.totalPaid);
    document.getElementById('invTotal').textContent = money(billing.totalPaid);

    const list = document.getElementById('invList');
    if (!billing.invoices || billing.invoices.length === 0) {
      list.innerHTML = '<div class="inv-empty">No invoices yet.<br>They will show up here after your first payment.</div>';
    } else {
      list.innerHTML = '<div class="inv-table">' + billing.invoices.map((inv) =>
        '<div class="inv-row"><span>' + inv.date + '</span><span>' + inv.item + '</span>' +
        '<b>' + money(inv.amount) + '</b><span class="inv-status">' + inv.status + '</span></div>'
      ).join('') + '</div>';
    }
  }).catch(() => {});
}
