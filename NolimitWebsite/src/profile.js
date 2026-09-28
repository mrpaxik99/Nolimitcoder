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
