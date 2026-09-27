const MODELS = [
  { icon: '🚀', name: 'NolimitCoderV3', desc: 'Nejnovější vlajkový model NolimitCode — kód, reasoning i text. Nejchytřejší volba na složité úkoly.', ep: 'vlajkový model', foot: 'Kód • reasoning • čeština' },
  { icon: '⚡', name: 'NolimitCoderV2', desc: 'Osvědčený model NolimitCode — rychlé odpovědi i kód. Ideální na každodenní práci.', ep: 'osvědčený model', foot: 'Rychlost • stabilita • kód' },
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

// Demo "psaní" v obou ukázkách aplikace
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
  'Vytvoř přihlašovací stránku...',
  'Oprav chybu v košíku...',
  '/plan — navrhni databázi...'
], 70, 40);
typeLoop('demoInput2', [
  'git push origin main',
  '/build — přidej košík...',
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

// Scroll progress + nav stín + parallax pozadí (pozadí scroluje se stránkou)
(function () {
  const bar = document.getElementById('scrollProgress');
  const nav = document.getElementById('nav');
  const orbs = document.getElementById('bgOrbs');
  const gridBg = document.getElementById('bgGrid');
  let ticking = false;
  function onScroll() {
    const y = window.scrollY || 0;
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const p = h > 0 ? (y / h) * 100 : 0;
    if (bar) bar.style.width = p + '%';
    if (nav) nav.classList.toggle('scrolled', y > 12);
    // parallax: každá vrstva pozadí jede jinou rychlostí → pozadí "žije" při scrollu
    if (orbs) orbs.style.transform = 'translateY(' + (y * 0.12) + 'px)';
    if (gridBg) gridBg.style.transform = 'translateY(' + (y * 0.05) + 'px)';
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();
})();

// Cursor glow následující myš
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

// Jemné hvězdičky / prach na pozadí (levné canvas částice, scrolují se stránkou)
(function () {
  const cv = document.getElementById('stars');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let W, H, pts = [];
  function resize() {
    W = cv.width = cv.offsetWidth || window.innerWidth;
    H = cv.height = document.documentElement.scrollHeight;
    pts = Array.from({ length: Math.min(110, Math.floor(W / 12)) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.6 + 0.4,
      s: Math.random() * 0.35 + 0.08,
      o: Math.random() * 0.5 + 0.15,
      ph: Math.random() * Math.PI * 2
    }));
  }
  resize();
  window.addEventListener('resize', resize);
  let t = 0;
  (function draw() {
    t += 0.02;
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.y -= p.s;
      if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
      const tw = p.o * (0.6 + 0.4 * Math.sin(t + p.ph));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + tw.toFixed(3) + ')';
      ctx.fill();
    }
    requestAnimationFrame(draw);
  })();
})();

// 3D tilt obou ukázek za myší — přední víc, zadní míň (hloubka)
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
