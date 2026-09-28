import '../style.css';
import './track.js';

const MODELS = [
  { icon: '<svg class="ic" viewBox="0 0 24 24"><path d="M14 4c3-2 7-2 7-2s0 4-2 7l-7 7-5-5 7-7z"/><circle cx="15" cy="9" r="1.5"/><path d="M5 15c-1 4-1 6-1 6s2 0 6-1"/></svg>', name: 'NolimitCoderV3', desc: 'The latest flagship NolimitCode model — code, reasoning, and text. The smartest choice for complex tasks.', ep: 'flagship model', foot: 'Code • reasoning • text' },
  { icon: '<svg class="ic" viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>', name: 'NolimitCoderV2', desc: 'A proven NolimitCode model — fast answers and code. Ideal for everyday work.', ep: 'proven model', foot: 'Speed • stability • code' },
];

const grid = document.getElementById('modelGrid');
if (grid) {
  grid.innerHTML = MODELS.map(m => `
    <div class="model-card">
      <div class="m-head"><span class="m-icon">${m.icon}</span><b>${m.name}</b><span class="free-tag">NolimitCode</span></div>
      <p>${m.desc}</p>
      <span class="m-ep">${m.ep}</span>
      <div class="m-foot">${m.foot}</div>
    </div>
  `).join('');
}

// Demo "typing" in both app previews
function typeLoop(id, texts, typeSpeed, delSpeed) {
  const el = document.getElementById(id);
  if (!el) return;
  let ti = 0, ci = 0, del = false;
  (function tick() {
    const t = texts[ti];
    el.textContent = t.slice(0, ci);
    if (!del) {
      ci++;
      if (ci > t.length + 14) del = true;
    } else {
      ci -= 3;
      if (ci <= 0) { ci = 0; del = false; ti = (ti + 1) % texts.length; }
    }
    setTimeout(tick, del ? delSpeed : typeSpeed);
  })();
}
typeLoop('demoInput', [
  'Create a login page...',
  'Fix the cart bug...',
  '/plan — design the database...'
], 70, 40);
typeLoop('demoInput2', [
  'git push origin main',
  '/build — add the cart...',
  'npm run preview'
], 90, 50);

// Reveal on scroll
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach(e => e.classList.add('visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en, i) => {
      if (en.isIntersecting) {
        setTimeout(() => en.target.classList.add('visible'), (i % 4) * 70);
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.12 });
  els.forEach(e => io.observe(e));
})();

// Scroll progress + nav shadow
(function () {
  const bar = document.getElementById('scrollProgress');
  const nav = document.getElementById('nav');
  let ticking = false;
  function onScroll() {
    const y = window.scrollY || 0;
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const p = h > 0 ? (y / h) * 100 : 0;
    if (bar) bar.style.width = p + '%';
    if (nav) nav.classList.toggle('scrolled', y > 12);
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();
})();

// Cursor glow following the mouse
(function () {
  const glow = document.getElementById('cursorGlow');
  if (!glow) return;
  let x = -500, y = -500, tx = x, ty = y;
  window.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
  (function loop() {
    x += (tx - x) * 0.12;
    y += (ty - y) * 0.12;
    glow.style.transform = 'translate(' + (x - 260) + 'px,' + (y - 260) + 'px)';
    requestAnimationFrame(loop);
  })();
})();

// 3D tilt of both previews following the mouse — front more, back less (depth)
(function () {
  const zone = document.getElementById('heroShots');
  const front = document.getElementById('appShot');
  const back = document.getElementById('appShotBack');
  if (!zone || !front || window.matchMedia('(max-width: 1024px)').matches) return;
  let raf = null;
  zone.addEventListener('mousemove', (e) => {
    const r = zone.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      front.style.transform = 'perspective(1100px) rotateY(' + (px * 7) + 'deg) rotateX(' + (-py * 7) + 'deg) translateY(-4px)';
      if (back) back.style.transform = 'perspective(1100px) rotateY(' + (px * -4) + 'deg) rotateX(' + (py * 4) + 'deg) translateY(3px)';
    });
  });
  zone.addEventListener('mouseleave', () => {
    if (raf) cancelAnimationFrame(raf);
    front.style.transform = '';
    if (back) back.style.transform = '';
  });
})();

// Logged-in user in nav (Google login via login.html)
(function () {
  const btn = document.getElementById('loginBtn');
  if (!btn) return;
  let user = null;
  try { user = JSON.parse(localStorage.getItem('nolimit_user')); } catch (e) {}
  if (!user) return;
  const chip = document.createElement('a');
  chip.className = 'nav-user';
  chip.href = './profile.html';
  chip.title = 'My profile';
  chip.innerHTML = (user.picture
    ? '<img src="' + user.picture + '" alt="">'
    : '<img src="./assets/logo.png" alt="">') +
    '<span>' + (user.name || 'User').split(' ')[0] + ' · Profile</span>';
  btn.replaceWith(chip);
  // Admin tlačítko vedle profilu — jen UX, skutečná kontrola je na serveru (/api/admin/*)
  try {
    if (String(user.email || '').toLowerCase() === 'tomaskonarik1977@gmail.com') {
      const ab = document.createElement('a');
      ab.className = 'btn btn-primary btn-sm';
      ab.href = './admin.html';
      ab.textContent = 'Admin';
      chip.after(ab);
    }
  } catch (e) {}
})();
