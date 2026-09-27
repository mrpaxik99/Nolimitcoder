'use strict';
/* NolimitCoder V2 — renderer (complete) */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- state ---------- */
let selectedModel = localStorage.getItem('nlc_model') || 'free/nolimitcoder-v3';
let searchQuery = '';
let conversations = [];
try { conversations = JSON.parse(localStorage.getItem('nlc_convos') || '[]'); if (!Array.isArray(conversations)) conversations = []; } catch { conversations = []; }
// legacy data without a project → null (global), so they do not mix with project ones
for (const c of conversations) { if (!c || c.projectPath === undefined) c.projectPath = null; }
let activeConvoId = localStorage.getItem('nlc_active') || null;
let isStreaming = false;
let stopRequested = false;
let prefs = { activeProject: null, mode: 'build', terminal: 'auto', shellBackend: 'auto', sound: true, googleSearch: true };
let mode = localStorage.getItem('nlc_mode') || 'build';
if (mode === 'auto') { mode = 'build'; try { localStorage.setItem('nlc_mode', 'build'); } catch {} } // Auto removed — Build tells questions apart from tasks on its own
let projectRegistry = [];
try { projectRegistry = JSON.parse(localStorage.getItem('nlc_projects') || '[]'); } catch { projectRegistry = []; }
let autoShell = false; // "Continue always" lasts until the app is closed
const approvedOnce = new Set(); // commands approved with the Continue button — repeats no longer ask
const autoInstalled = new Set(); // tools auto-installed in this session
const HEAVY_IDS = new Set(['msvc', 'docker', 'android', 'unity', 'unreal']); // GB toolchains — only with consent
const UNIVERSAL_SET = ['node', 'python', 'git', 'gcc', 'cmake', 'make', 'dotnet', 'java', 'go', 'rust', 'bun', 'deno'];
let envData = null; // last environment scan
let envBusy = false; // scan/install in progress
let lastUserRequest = ''; // last user input (for detecting needed tools)
let pendingQueue = [];

const SPEEDS = [
  { id: 'fast', label: 'Fast', tokens: 1024 },
  { id: 'medium', label: 'Medium', tokens: 4096 },
  { id: 'high', label: 'High', tokens: 16000 }
];
let speedIx = parseInt(localStorage.getItem('nlc_speed') || '1', 10);
if (!(speedIx >= 0 && speedIx <= 2)) speedIx = 1;

const IDENTITY = 'You are NolimitCoder by NolimitCode. Respond in English, briefly.';
const PLAN_PROMPT = 'PLAN: text only, no actions. You only have read tools. Explore the files and write a brief plan: what changes in which files (path:line) + how to verify it. No code.';
const BUILD_SYS = 'Work through tools, not by printing into chat. Never announce an action in text without a simultaneous tool call - the first response to a request must contain a tool-call. Always call each tool-call with COMPLETE parameters in a single call - never empty {} and never in pieces (if the response gets cut off, call again COMPLETELY); only call when you have all parameters together - if you do not know a path, find it first via list_dir (never guess blindly). Independent actions: call them together in one step, dependent ones sequentially. Files: read with read_file, ALWAYS edit an existing file via edit_file with an exact small oldString copied from read_file (must match 1x, no line numbers, no own modifications), full write_file only for new files. Terminal: shell. Relative paths = active project; just name Documents, Desktop, Downloads.'
  + ' Before compiling/running, call env_prepare with request (it auto-installs missing tools from the internet). Never tell the user to install anything manually. Large toolchains (MSVC, Docker, Android) only with heavy: true, and only after the user agreed (ask via question).'
  + ' EXE: if no technology was specified, ask via question. Electron: scaffold_electron, write the code, shell npm install (timeout 600000), shell npm run dist (timeout 600000), verify the exe via file_info and report the path. Web: index.html in the project root. Always verify finished work by running it. Never commit without an explicit request.'
  + ' CSS in generated apps: NEVER use backdrop-filter or -webkit-backdrop-filter (slow and blurry) — only solid colors, gradients and shadows.';
const AGENT_NUDGE = '';
const CHAT_SYS = 'Respond in English, briefly and to the point. Change nothing, write nothing, run nothing. If you need to peek into project files, you may only use read tools. Show code only when the user explicitly asks for it.';
/* ---------- Build mode: question vs. task ----------
   Build ALWAYS first recognizes what the user wants (detectIntent), and then
   either just answers with text (question/chit-chat — read tools allowed), or works
   with tools (task — writes, terminal, build). See detection rules in detectIntent below:
   interrogative form wins over the infinitive, a direct command is always a task. Unclear = question. */
function detectIntent(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'chat';
  const noFill = t.replace(/^(hi|hello|hey|yo|good morning|good afternoon|good evening|please|well|so|ok|okay)\b[\s,]+/i, '').trim() || t;
  if (/^(how|what|why|where|when|who|which|whose|whom|how many|how much|whether|explain|describe|tell me|do you know|can you explain|could you explain)\b/i.test(noFill)) {
    if (/\b(fix|update|edit|write|make|create|add|delete|remove|run|install|test|rewrite|refactor|rename|generate|finish|complete|prepare)\b/i.test(t)) return 'build';
    return 'chat';
  }
  if (/(make|create|build|write|fix|repair|add|update|change|remove|delete|refactor|implement|generate|install|set up|settle|uninstall|compile|rebuild|program|remove|rewrite|extend|finish|complete|run|launch|deploy|rename|move|copy|download|test|scaffold|i want you to|i need|i would like)/i.test(t)) return 'build';
  if (/```|Traceback|SyntaxError|TypeError|ReferenceError|\berror TS\d+|^\s*at\s+\S+\s*\(|\b[A-Za-z-]+\.(js|ts|tsx|py|java|cs|cpp|c|go|rs|php|rb):\d+/im.test(t) && !/\?/.test(t)) return 'build';
  return 'chat';
}

/* ---------- helpers: markdown / highlight ---------- */
function dlog(tag, data) { try { if (window.api && window.api.debugLog) window.api.debugLog(tag, data); } catch {} }
const CODE_KW = /\b(const|let|var|function|return|if|else|for|while|do|class|extends|new|import|from|export|default|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|in|of|this|null|true|false|def|lambda|pass|with|as|assert|yield|async|await|elif|and|or|not|is|None|struct|impl|fn|mut|match|use|pub|int|float|string|bool|void|public|private|static|package|interface|echo|set)\b/;
function highlightCode(code) {
  return String(code).replace(/(&quot;.*?&quot;|'[^'\n]*'|`[^`]*`|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g, (m) => {
    if (/^(&quot;|'|`)/.test(m)) return '<span class="tk-s">' + m + '</span>';
    if (/^(\/\/|#)/.test(m)) return '<span class="tk-c">' + m + '</span>';
    if (/^\d/.test(m)) return '<span class="tk-n">' + m + '</span>';
    if (CODE_KW.test(m)) return '<span class="tk-k">' + m + '</span>';
    return m;
  });
}
function mdToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const l = String(lang || 'txt').toLowerCase();
    return '<div class="codeblock"><div class="cb-head"><span class="cb-lang">' + escapeHtml(l) + '</span><button class="cb-copy" data-copy title="Kopírovat kód">Kopírovat</button></div><pre class="cb-pre"><code>' + highlightCode(code.replace(/&quot;/g, '"')) + '</code></pre></div>';
  });
  html = html.replace(/`([^`]+)`/g, '<code style="background:#ffffff14;padding:2px 6px;border-radius:6px;border:1px solid #282828">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#8ec2fc">$1</a>');
  html = html.split(/\n{2,}/).map(p => p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '').join('');
  return html;
}
function sanitizeResponse(text) {
  let t = String(text || '');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  t = t.replace(/^(?:undefined|null|NaN)\b[\s:–—\-.,;]*/i, '');
  t = t.replace(/^(?:undefined|null|NaN)\b[\s:–—\-.,;]*/i, '');
  const parts = t.split('```');
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].split('\n').filter(line => {
      const s = line.trim();
      if (/^\{.*"tool_calls/.test(s) && s.endsWith('}')) return false;
      if (/^(undefined|null)\b/i.test(s)) return false;
      return true;
    }).join('\n');
  }
  return parts.join('```').trimStart();
}
/* Uživateli se nikdy neukazuje nic o quotě, limitech ani proxy — rotace běží potichu na pozadí.
   Jakákoliv chyba vonící přetížením se přepíše na neutrální hlášku. */
function publicErr(s) {
  const t = String(s || '');
  if (/quota|rate[\s_-]*limit|free[\s_-]*usage|429|proxy|too many|capacity|overloaded|try again later|usage[\s_-]*exceeded|limit[\s_-]*exceeded/i.test(t))
    return 'AI je teď přetížená — zkus to prosím za chvíli znovu.';
  return t.slice(0, 300);
}
function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }
function getModels() {
  let base = window.NOLIMIT_MODELS || [];
  if (window._zenLiveFree && window._zenLiveFree.length) {
    const ids = new Set(base.map(m => m.zenId || m.id));
    const extra = window._zenLiveFree.filter(m => !ids.has(m.zenId));
    base = base.concat(extra);
  }
  return base;
}
function modelLabel(id) { const m = getModels().find(x => x.id === id); return m ? m.label : String(id || '').split('/').pop(); }
function zenIdOf(id) { const m = getModels().find(x => x.id === id); return (m && m.zenId) || String(id || '').split('/').pop(); }
// Pri vycerpane kvote (429) se zkusi druhy model NolimitCoder (ma vlastni kvotu). Jen mezi temito dvema.
const MODEL_FALLBACK = { 'free/nolimitcoder-v3': 'free/nolimitcoder-v2', 'free/nolimitcoder-v2': 'free/nolimitcoder-v3' };
function activeProject() { return prefs.activeProject || null; }
function activeConvo() { return conversations.find(c => c.id === activeConvoId) || null; }
// Chaty patří projektu: shoda musí platit oběma směry (projekt A nevidí chaty projektu B ani globální a naopak).
function convoProject(c) { return (c && c.projectPath) || null; }
function projectMatch(c) { return !!c && convoProject(c) === (prefs.activeProject || null); }
function saveConvos() { try { localStorage.setItem('nlc_convos', JSON.stringify(conversations.slice(-60))); } catch {} }
function saveRegistry() { try { localStorage.setItem('nlc_projects', JSON.stringify(projectRegistry)); } catch {} }
function playDone() {
  if (!prefs.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.stop(ctx.currentTime + 0.36);
  } catch {}
}

/* ---------- element refs (lazy — voláno po DOMContentLoaded) ---------- */
let el = {};
function bindEls() {
  el.modelSelector = $('#modelSelector'); el.modelCurrent = $('#modelCurrent');
  el.modelDropdown = $('#modelDropdown'); el.modelList = $('#modelList');
  el.modelSearch = $('#modelSearch'); el.curName = $('#curName');
  el.footerModel = $('#footerModel'); el.footerStatus = $('#footerStatus');
  el.messages = $('#messages'); el.chatEmpty = $('#chatEmpty');
  el.chatContainer = $('#chatContainer'); el.promptInput = $('#promptInput');
  el.sendBtn = $('#sendBtn'); el.stopBtn = $('#stopBtn');
  el.chatList = $('#chatList'); el.sessionTitle = $('#sessionTitle');
  el.statusText = $('#statusText'); el.queueBar = $('#queueBar');
  el.activityBar = $('#activityBar'); el.planHint = $('#planHint');
  el.planBox = $('#planBox');
  el.envSummary = $('#envSummary'); el.envList = $('#envList');
  el.envScanBtn = $('#envScanBtn'); el.envFixAllBtn = $('#envFixAllBtn'); el.envHeavyCheck = $('#envHeavyCheck');
}

/* ---------- model picker ---------- */
function renderModelList() {
  const models = getModels();
  let filtered = models;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(m => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.desc || '').toLowerCase().includes(q));
  }
  el.modelList.innerHTML = filtered.map(m => {
    const isActive = m.id === selectedModel;
    return '<div class="model-item ' + (isActive ? 'active' : '') + '" data-id="' + escapeHtml(m.id) + '">'
      + '<div class="minfo"><div class="mname">' + escapeHtml(m.label) + '<span class="mcheck">✓</span></div>'
      + '<div class="mdesc">' + escapeHtml(m.desc || '') + ' · ' + escapeHtml(m.context || '') + '</div></div></div>';
  }).join('') || '<div class="chat-list-empty">Nic nenalezeno</div>';
  $$('#modelList .model-item').forEach(n => n.addEventListener('click', () => {
    selectedModel = n.getAttribute('data-id');
    localStorage.setItem('nlc_model', selectedModel);
    updateModelLabel(); renderModelList(); closeModels();
  }));
}
function updateModelLabel() {
  const l = modelLabel(selectedModel);
  if (el.curName) el.curName.textContent = l;
  if (el.footerModel) el.footerModel.textContent = l;
}
function closeModels() { if (el.modelDropdown) { el.modelDropdown.classList.remove('open'); el.modelDropdown.style.left = '0px'; } }
function clampDropdown() {
  const dd = el.modelDropdown;
  if (!dd || !dd.classList.contains('open')) return;
  dd.style.left = '0px';
  try {
    const r = dd.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 12);
    if (over > 0) dd.style.left = (-over) + 'px';
  } catch {}
}
async function refreshZenLive() {
  setFooter('Načítám modely…');
  try {
    const r = await window.api.fetchZenModels();
    if (r && r.ok && r.data) {
      const arr = Array.isArray(r.data) ? r.data : (r.data.data || r.data.models || []);
      const free = arr.filter(m => {
        const id = String(m.id || m.name || '');
        return /free|pickle|bunny|mimo|ling|nemotron|muse-spark/i.test(id);
      }).slice(0, 30).map(m => ({
        id: 'live/' + (m.id || m.name), zenId: (m.id || m.name),
        label: String(m.name || m.id || '').slice(0, 40) || String(m.id),
        provider: 'live', category: 'FREE', context: String((m.context_window || 128000) / 1000) + 'k',
        free: true, endpoint: 'chat', desc: 'Live z brány NolimitCoder'
      }));
      window._zenLiveFree = free;
      renderModelList();
      setFooter('Hotovo (' + getModels().length + ' modelů)');
    } else setFooter('Offline režim');
  } catch { setFooter('Offline režim'); }
}

/* ---------- AI commercial video: stav náhledu + exportu ---------- */
const VIDEO_RESOLUTIONS = {
  '1920x1080': { w: 1920, h: 1080, label: '16:9 Full HD' },
  '1280x720': { w: 1280, h: 720, label: '16:9 HD' },
  '1440x1080': { w: 1440, h: 1080, label: '4:3' },
  '1080x1080': { w: 1080, h: 1080, label: '1:1 Square' },
  '1080x1920': { w: 1080, h: 1920, label: '9:16 Vertical' }
};
let videoRes = localStorage.getItem('nlc_videores') || '1920x1080';
if (!VIDEO_RESOLUTIONS[videoRes]) videoRes = '1920x1080';
// Length steps: 0:30 → 5:00 in 30 s steps
const VIDEO_DURS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
let videoDur = parseInt(localStorage.getItem('nlc_videodur') || '30', 10) || 30;
if (!VIDEO_DURS.includes(videoDur)) {
  videoDur = VIDEO_DURS.reduce((a, b) => Math.abs(b - videoDur) < Math.abs(a - videoDur) ? b : a);
}
function videoDurIx() { const i = VIDEO_DURS.indexOf(videoDur); return i >= 0 ? i : 0; }
function fmtDur(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
let lastVideoPath = null;
let videoExporting = false;
// Typ aktivního projektu z registru (universal | website | video)
function activeProjectType() {
  try {
    const hit = (projectRegistry || []).find(p => p && p.path === prefs.activeProject);
    if (hit && hit.type) return hit.type;
  } catch {}
  return 'universal';
}
/* INSTRUCTIONS/ — AI instructions by project type (commercial/website/universal).
   Loaded once from the main process; missing files = built-in code defaults. */
let INSTR = null;
function instrType() {
  const t = activeProjectType();
  return t === 'video' ? 'commercial' : (t === 'website' ? 'website' : 'universal');
}
function instrSec(name, fallback) {
  try {
    const s = INSTR && INSTR[instrType()] && INSTR[instrType()].sections;
    if (s && s[name]) return s[name];
  } catch {}
  return fallback;
}
function videoResWH() { return VIDEO_RESOLUTIONS[videoRes] || VIDEO_RESOLUTIONS['1920x1080']; }
/* System prompt pro reklamní videa: jedno responzivní index.html, celé viewport,
   animované, bez potřeby klikání (v náhledu ani klikat nejde — chová se jako video). */
const VIDEO_ADD = ' VIDEO AD PROJECT: output a single self-contained advertising commercial as index.html in the project root (inline CSS+JS, no build). The ad fills the whole viewport at the target resolution, animated from page load (CSS/JS animation, autoplay, loop-friendly), readable typography, strong contrast. No clicks needed — the page behaves like a video (nothing must require interaction). Keep everything responsive so it looks right at any of 1920x1080, 1280x720, 1440x1080, 1080x1080, 1080x1920.';

/* ---------- projekty ---------- */
function renderProjects() {
  const grid = $('#projectCards');
  if (!grid) return;
  grid.innerHTML = projectRegistry.map((p, i) =>
    '<div class="pv-card" data-i="' + i + '"><span class="folder-ico">📁</span>'
    + '<div class="pv-card-info"><div class="pv-card-name">' + escapeHtml(p.name) + '</div>'
    + '<div class="pv-card-path">' + escapeHtml(p.path) + '</div>'
    + '<span class="pv-type">' + escapeHtml(p.type === 'website' ? 'Website' : (p.type === 'video' ? '🎬 Video' : 'Universal')) + '</span></div>'
    + '<div class="pv-card-act"><button class="row-btn" data-act="rename" title="Přejmenovat">✎</button>'
    + '<button class="row-btn danger" data-act="del" title="Odebrat">✕</button></div></div>'
  ).join('');
  grid.querySelectorAll('.pv-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      const p = projectRegistry[parseInt(card.getAttribute('data-i'), 10)];
      if (act === 'del') { e.stopPropagation(); projectRegistry = projectRegistry.filter(x => x !== p); saveRegistry(); renderProjects(); return; }
      if (act === 'rename') { e.stopPropagation(); askPrompt('Přejmenovat projekt', 'Nový název projektu', p.name).then(v => { if (v) { p.name = v; saveRegistry(); renderProjects(); } }); return; }
      openProject(p);
    });
  });
}
function showView(v) {
  const vp = $('#viewProjects'), vc = $('#viewChat');
  if (vp) vp.style.display = v === 'projects' ? '' : 'none';
  if (vc) vc.style.display = v === 'chat' ? '' : 'none';
}
async function openProject(p) {
  prefs.activeProject = p.path;
  try { await window.api.setStore({ activeProject: p.path }); } catch {}
  $('#projHeadName').textContent = p.name;
  showView('chat');
  renderChatList();
  let c = conversations.filter(x => x.projectPath === p.path).slice(-1)[0];
  if (!c) c = newConvo(true);
  else { activeConvoId = c.id; localStorage.setItem('nlc_active', c.id); renderMessages(); renderChatList(); }
  // Website + video: chat vpravo, náhled vlevo. Video navíc s rozlišením a exportem do MP4.
  const flip = (p.type === 'website' || p.type === 'video');
  try { $('#viewChat').classList.toggle('flip', flip); } catch {}
  if (p.type === 'website' || p.type === 'video') startPreview(p.path, p.type);
  else hidePreview();
  setVideoMode(p.type === 'video');
  setFooter('Ready · ' + p.name);
}

/* ---------- konverzace ---------- */
function newConvo(silent) {
  const c = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), projectPath: prefs.activeProject, title: 'Nová konverzace', messages: [], created: Date.now() };
  conversations.push(c); activeConvoId = c.id;
  localStorage.setItem('nlc_active', c.id); saveConvos();
  if (!silent) { renderMessages(); }
  renderChatList();
  return c;
}
function renderChatList() {
  if (!el.chatList) return;
  const list = conversations.filter(projectMatch).slice().reverse();
  el.chatList.innerHTML = list.map(c =>
    '<div class="chat-item ' + (c.id === activeConvoId ? 'active' : '') + '" data-id="' + c.id + '">'
    + '<div class="chat-item-title">' + escapeHtml(c.title || 'Nová konverzace') + '</div>'
    + '<div class="chat-item-sub">' + (c.messages ? c.messages.length : 0) + ' zpráv</div>'
    + '<button class="chat-rename" data-a="rename" title="Přejmenovat">✎</button>'
    + '<button class="chat-del" data-a="del" title="Smazat">✕</button></div>'
  ).join('') || '<div class="chat-list-empty">Zatím žádný chat — vytvoř nový.</div>';
  el.chatList.querySelectorAll('.chat-item').forEach(n => n.addEventListener('click', (e) => {
    const id = n.getAttribute('data-id');
    const a = e.target.getAttribute && e.target.getAttribute('data-a');
    if (a === 'del') { e.stopPropagation(); conversations = conversations.filter(c => c.id !== id); saveConvos(); if (activeConvoId === id) { const rest = conversations.filter(projectMatch); activeConvoId = rest.length ? rest[rest.length - 1].id : null; } renderChatList(); renderMessages(); return; }
    if (a === 'rename') { e.stopPropagation(); const c = conversations.find(x => x.id === id); askPrompt('Přejmenovat chat', 'Nový název', c.title).then(v => { if (v) { c.title = v; saveConvos(); renderChatList(); } }); return; }
    activeConvoId = id; localStorage.setItem('nlc_active', id); renderChatList(); renderMessages();
  }));
  const c = activeConvo();
  if (el.sessionTitle) el.sessionTitle.textContent = c ? (c.title || 'Nová konverzace') : 'Nová konverzace';
}

/* ---------- zprávy ---------- */
function setFooter(t) { if (el.footerStatus) el.footerStatus.textContent = t; }
function setActivity(t) {
  if (!el.activityBar) return;
  if (!t) { el.activityBar.style.display = 'none'; el.activityBar.innerHTML = ''; return; }
  el.activityBar.style.display = '';
  el.activityBar.innerHTML = '<span class="q-dot"></span><span>' + escapeHtml(t) + '</span>';
}
function scrollBottom() { try { el.chatContainer.scrollTop = el.chatContainer.scrollHeight; } catch {} }
/* ---------- Plán kroku: co AI právě teď bude dělat (pod ukazatelem průběhu) ---------- */
let planCollapsed = false;
try { planCollapsed = localStorage.getItem('nlc_plancollapsed') === '1'; } catch {}
function renderPlanBox(trail, liveIx) {
  // trail: [{name, args, st}] za CELÝ úkol — 1 volání nástroje = 1 krok, žádný vymyšlený celkový počet.
  if (!el.planBox) return;
  if (!trail || !trail.length) { el.planBox.style.display = 'none'; el.planBox.innerHTML = ''; return; }
  el.planBox.style.display = '';
  el.planBox.classList.toggle('collapsed', planCollapsed);
  const rows = trail.slice(-12);
  const off = trail.length - rows.length;
  el.planBox.innerHTML = '<div class="pb-head"><span>Krok ' + (liveIx + 1) + ' — teď udělám:</span>'
    + '<button class="pb-toggle" id="pbToggle">' + (planCollapsed ? 'Zobrazit více' : 'Zobrazit méně') + '</button></div>'
    + '<div class="pb-list">' + rows.map((t, i) =>
      '<div class="pb-row ' + (t.st === 'done' ? 'done' : t.st === 'bad' ? 'bad' : i + off === liveIx ? 'live' : '') + '">'
      + '<span class="pb-n">' + (i + off + 1) + '</span>'
      + '<span class="pb-t">' + escapeHtml(activityFor(t.name, t.args).replace(/…$/, '')) + '</span>'
      + '<span class="pb-s">' + (t.st === 'done' ? '✓' : t.st === 'bad' ? '✕' : t.st === 'skip' ? '–' : '…') + '</span></div>'
    ).join('') + '</div>';
  const tg = el.planBox.querySelector('#pbToggle');
  if (tg) tg.addEventListener('click', () => {
    planCollapsed = !planCollapsed;
    try { localStorage.setItem('nlc_plancollapsed', planCollapsed ? '1' : '0'); } catch {}
    el.planBox.classList.toggle('collapsed', planCollapsed);
    tg.textContent = planCollapsed ? 'Zobrazit více' : 'Zobrazit méně';
  });
  scrollBottom();
}
function hidePlanBox() { if (el.planBox) { el.planBox.style.display = 'none'; el.planBox.innerHTML = ''; } }
function addMsg(role, html, raw) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
  wrap.innerHTML = role === 'user'
    ? '<div class="bubble-user">' + escapeHtml(raw != null ? raw : html) + '</div>'
    : '<div class="bubble-assistant">' + html + '</div>';
  el.messages.appendChild(wrap); scrollBottom();
  return wrap;
}
function renderMessages() {
  if (!el.messages) return;
  el.messages.innerHTML = '';
  let c = activeConvo();
  // pojistka: aktivní chat z jiného projektu se nesmí vykreslit — přepni na poslední chat tohoto projektu
  if (c && !projectMatch(c)) {
    const rest = conversations.filter(projectMatch);
    c = rest.length ? rest[rest.length - 1] : null;
    activeConvoId = c ? c.id : null;
    try { localStorage.setItem('nlc_active', activeConvoId || ''); } catch {}
  }
  if (el.chatEmpty) el.chatEmpty.style.display = (!c || !c.messages.length) ? '' : 'none';
  if (!c) return;
  if (el.sessionTitle) el.sessionTitle.textContent = c.title || 'Nová konverzace';
  if (!c.messages.length) {
    el.chatEmpty.innerHTML = '<div class="empty-title">Na čem budeme pracovat?</div>'
      + '<div class="empty-sub">Build sám pozná, jestli se jen ptáš, nebo chceš něco udělat. Plan jen plánuje. Nástroje: shell, soubory, web, terminál, preview.</div>'
      + '<div class="empty-suggest"><button data-s="Vypiš soubory v projektu a navrhni, co dál">Vypiš soubory v projektu</button>'
      + '<button data-s="Připrav mi prostředí: použij env_prepare, ať je všechno co potřebuju nainstalované">Připravit prostředí (env_prepare)</button>'
      + '<button data-s="Vytvoř jednoduchou index.html stránku s pozdravem">Vytvoř demo stránku</button></div>';
    el.chatEmpty.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { el.promptInput.value = b.getAttribute('data-s'); sendMessage(); }));
    return;
  }
  for (const m of c.messages) {
    if (m.role === 'user' && m.internal) continue; // interní smyčka agenta — patří modelu, v chatu se neukazuje
    if (m.role === 'user') addMsg('user', '', m.content);
    else if (m.role === 'assistant') addMsg('assistant', mdToHtml(sanitizeResponse(m.content || '')), null);
    else if (m.role === 'tool') renderToolCard(m.tool, m.args, m.result, m.ok, m.diff);
  }
  bindCopyButtons();
  scrollBottom();
}
function bindCopyButtons() {
  $$('#messages .cb-copy[data-copy]').forEach(b => {
    if (b._bound) return; b._bound = true;
    b.addEventListener('click', () => {
      const code = b.closest('.codeblock').querySelector('code').innerText;
      const done = () => { b.textContent = 'Zkopírováno ✓'; setTimeout(() => b.textContent = 'Kopírovat', 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
      else fallbackCopy(code, done);
    });
  });
}
function fallbackCopy(txt, done) {
  try {
    const ta = document.createElement('textarea'); ta.value = txt;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
  } catch {}
}
function baseName(p) { return String(p || '').split(/[\\/]/).pop() || String(p || ''); }
/* Lidský popis akce do chatu (místo technických výpisů — ty patří jen modelu) */
function humanTool(name, args, ok) {
  args = args || {};
  switch (name) {
    case 'read_file': return 'Koukám do ' + (baseName(args.path) || 'souboru');
    case 'edit_file': return 'Upravuju ' + (baseName(args.path) || 'soubor');
    case 'write_file': return 'Vytvářím soubor ' + (baseName(args.path) || '') + (typeof args.content === 'string' ? ' (' + args.content.length + ' znaků)' : '');
    case 'append_file': return 'Připisuju do ' + (baseName(args.path) || 'souboru');
    case 'list_dir': return 'Prohlížím složku ' + (baseName(args.path) || args.dir || 'projektu');
    case 'glob_file': return 'Hledám soubory ' + (args.pattern || '');
    case 'search_files': return 'Hledám „' + (args.pattern || 'text') + '“';
    case 'shell': return 'Spouštím: ' + String(args.command || '').slice(0, 90);
    case 'create_dir': return 'Vytvářím složku ' + (baseName(args.path) || '');
    case 'delete_file': return 'Mažu ' + (baseName(args.path) || 'soubor');
    case 'move_file': return 'Přesouvám ' + (baseName(args.from) || '') + ' → ' + (baseName(args.to) || '');
    case 'copy_file': return 'Kopíruju ' + (baseName(args.from) || 'soubor');
    case 'file_info': return 'Koukám na ' + (baseName(args.path) || 'soubor');
    case 'env_scan': return 'Skenuju počítač';
    case 'env_prepare': return 'Připravuju nástroje';
    case 'env_install': return 'Instaluju ' + (((args.ids || []).join(', ') || args.id) || 'nástroje');
    case 'question': return 'Ptám se';
    case 'web_fetch': return 'Stahuju stránku';
    case 'web_search': return 'Hledám na netu';
    case 'download_file': return 'Stahuju soubor';
    case 'scaffold_electron': return 'Stavím kostru aplikace';
    case 'open_path': return 'Otvírám ' + (baseName(args.path) || '');
    default: return name;
  }
}
function renderToolCard(name, args, result, ok, diff, cached) {
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  const short = String((args && (args.path || args.dir || args.command || args.pattern || args.url || args.query || args.id || (args.ids && args.ids.join(', ')) || args.request)) || '').slice(0, 90);
  let inner = '<div class="tool-card ' + (ok ? 'ok' : 'bad') + '"><div class="tool-head"><span class="tool-dot"></span>'
    + '<span class="t-name">' + escapeHtml(name) + '</span>'
    + '<span class="t-path">' + escapeHtml(short) + '</span>'
    + '<span class="t-chip">' + (ok ? '✓' : '✕') + '</span></div>';
  if (diff && diff.length) {
    inner += '<div class="t-diff">' + diff.slice(0, 15).map(d =>
      '<div class="dl ' + (d.t === '+' ? 'add' : d.t === '-' ? 'del' : 'ctx') + '"><span>' + escapeHtml(d.t) + '</span><code>' + escapeHtml(String(d.s).slice(0, 300)) + '</code></div>'
    ).join('') + '</div>';
  }
  // V chatu lidská věta; celý výpis patří modelu (do konverzace), ne do očí.
  let body = humanTool(name, args, ok);
  const out = String(result || '');
  if (!ok && out) body += ' — ' + out.split('\n')[0].slice(0, 200);
  else if (['shell', 'env_scan', 'env_prepare', 'env_install', 'question', 'list_dir', 'search_files', 'web_search'].includes(name) && out) {
    const cut = out.slice(0, 400);
    body += '\n' + cut + (out.length > 400 ? '…' : '');
  }
  if (body) inner += '<div class="t-live">' + escapeHtml(body) + '</div>';
  inner += '</div>';
  wrap.innerHTML = inner;
  el.messages.appendChild(wrap);
  scrollBottom();
  return wrap;
}
/* ---------- Prostředí: co je v PC, co chybí, Fix ALL ---------- */
function prefsGo(section) {
  document.querySelectorAll('#prefsNav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-pref') === section));
  document.querySelectorAll('#prefsPages .pref-page').forEach(s => s.style.display = s.getAttribute('data-ppage') === section ? '' : 'none');
}
function openPrefs() {
  $('#prefsModal').classList.add('open');
  $('#soundCheck').checked = !!prefs.sound;
  const gc = $('#googleCheck'); if (gc) gc.checked = prefs.googleSearch !== false;
  const be = prefs.shellBackend || prefs.terminal || 'auto';
  document.querySelectorAll('input[name="shellbe"]').forEach(r => r.checked = r.value === be);
  if (!envData && !envBusy) runEnvScan(false);
}
function envBusyState(on) {
  envBusy = on;
  if (el.envScanBtn) el.envScanBtn.disabled = on;
  if (el.envFixAllBtn) { el.envFixAllBtn.disabled = on; el.envFixAllBtn.textContent = on ? 'Instaluji…' : 'Fix ALL'; }
}
async function runEnvScan(force) {
  if (envBusy) return envData;
  envBusyState(true);
  if (el.envSummary) el.envSummary.textContent = 'Skenuji počítač…';
  try {
    const r = await window.api.toolsExec({
      tool: 'env_scan', args: force ? { request: lastUserRequest, rescan: true } : { request: lastUserRequest },
      root: prefs.activeProject, fullAccess: true
    });
    if (r && r.data) { envData = r.data; renderEnvPanel(); }
    return envData;
  } catch (e) {
    if (el.envSummary) el.envSummary.textContent = 'Sken selhal: ' + (e.message || e);
    return null;
  } finally { envBusyState(false); }
}
function renderEnvPanel() {
  if (!el.envList || !envData) return;
  const d = envData;
  const pkg = Object.entries(d.packages || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'žádný';
  const need = d.needed || [];
  const miss = d.missing || [];
  const proj = d.project && d.project.kind ? d.project.kind : 'žádný projekt';
  const req = d.intent && d.intent.text ? d.intent.text : '';
  let head = 'PC: ' + d.os + ' · balíčkové manažery: ' + pkg + '\nProjekt: ' + proj + (need.length ? ' → potřeba: ' + need.join(', ') : ' → nic nechybí');
  if (req) head += '\nTvoje poslední zadání: „' + req.slice(0, 70) + '“ → ' + ((d.intent.needs || []).join(', ') || 'jen běžné nástroje');
  head += '\n' + (miss.length ? 'Chybí: ' + miss.join(', ') : 'Všechno potřebné je v PC ✓');
  if (el.envSummary) el.envSummary.textContent = head;
  const rows = Object.values(d.tools || {}).map(t => {
    const isNeed = need.includes(t.id);
    const cls = t.ok ? 'ok' : 'miss';
    const ver = t.ok ? escapeHtml((t.version || 'nalezeno').slice(0, 60)) : (t.heavy ? 'velký toolchain' : (t.winget ? 'winget ' + t.winget : 'chybí'));
    const tag = t.heavy ? '<span class="env-tag">GB</span>' : (isNeed ? '<span class="env-tag">potřeba</span>' : '');
    const btn = t.ok ? '' : t.manual ? '<span class="env-ver">jen ručně</span>' : '<button class="env-mini" data-inst="' + escapeHtml(t.id) + '"' + (envRowBusy.has(t.id) ? ' disabled' : '') + '>Doinstalovat</button>';
    return '<div class="env-row ' + cls + (isNeed && !t.ok ? ' need' : '') + '">'
      + '<span class="env-ico">' + (t.ok ? '✓' : '✕') + '</span>'
      + '<span class="env-name">' + escapeHtml(t.label) + '</span>'
      + '<span class="env-ver">' + ver + '</span>' + tag + btn + '</div>';
  }).join('');
  el.envList.innerHTML = rows;
  el.envList.querySelectorAll('button[data-inst]').forEach(b => b.addEventListener('click', () => envInstall([b.getAttribute('data-inst')])));
}
async function envInstall(ids, opts) {
  const list = (ids || []).filter(id => !envRowBusy.has(id));
  if (!list.length) return null;
  const o = opts || {};
  for (const id of list) envRowBusy.add(id);
  if (el.envList && envData) renderEnvPanel();
  envBusyState(true);
  const heavy = o.heavy != null ? o.heavy : !!(el.envHeavyCheck && el.envHeavyCheck.checked);
  if (el.envSummary) el.envSummary.textContent = 'Instaluji: ' + list.join(', ') + '… (může trvat pár minut)';
  const card = el.messages ? renderToolCard('env_install', { ids: list }, 'Instaluji ' + list.join(', ') + '…', true) : null;
  let r = null;
  try {
    r = await window.api.toolsExec({ tool: 'env_install', args: { ids: list, heavy: heavy }, root: prefs.activeProject, fullAccess: true });
  } catch (e) { r = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
  if (card) {
    const done = humanTool('env_install', { ids: list }, !!(r && r.ok));
    const tail = String((r && r.output) || '');
    const cut = tail ? '\n' + tail.slice(0, 400) + (tail.length > 400 ? '…' : '') : '';
    card.querySelector('.t-live') && (card.querySelector('.t-live').textContent = done + cut);
  }
  envData = (r && r.data && r.data.tools) ? null : envData;
  for (const id of list) envRowBusy.delete(id);
  envBusyState(false);
  await runEnvScan(true);
  for (const x of (r && r.data && r.data.results || [])) if (x.ok && !x.already) autoInstalled.add(x.id);
  return r;
}
async function envFixAll() {
  if (envBusy) return;
  const heavy = !!(el.envHeavyCheck && el.envHeavyCheck.checked);
  const data = envData || await runEnvScan(true);
  if (!data) return;
  const missingAll = Object.values(data.tools || {}).filter(t => !t.ok).map(t => t.id);
  const light = missingAll.filter(id => !HEAVY_IDS.has(id));
  const heavyIds = missingAll.filter(id => HEAVY_IDS.has(id));
  const todo = heavy ? missingAll : light;
  if (!todo.length) {
    if (el.envSummary) el.envSummary.textContent = heavy ? 'Všechno je v PC ✓' : 'Všechny běžné nástroje jsou v PC ✓' + (heavyIds.length ? '\nVelké toolchainy (' + heavyIds.join(', ') + ') se nainstalují jen s volbou „Včetně velkých“.' : '');
    return;
  }
  if (el.envSummary) el.envSummary.textContent = 'Fix ALL: instaluji ' + todo.join(', ') + '…\nMůže to trvat desítky minut (stahuji z internetu). Nech appku běžet.';
  await envInstall(todo, { heavy: heavy });
  if (heavy && !heavyIds.length && el.envSummary) el.envSummary.textContent += '\nHotovo ✓';
}
/* Zaneprázdněnost po jednotlivých nástrojích — řádková tlačítka se šedí jen když se PRÁVĚ TEN nástroj instaluje,
   nikdy globálně (globální envBusy patří jen skenu a Fix ALL). */
const envRowBusy = new Set();
/* Před během agenta: když zadání chce něco, co v PC není, doinstaluj to sám (malé toolchainy). */
async function ensureForRequest(text) {
  if (!/kompil|build|sestav|spus|spust|npm|node|python|java|c\+\+|c#|dotnet|rust|golang|cmake|\bapk\b|\bexe\b|aplikac|web|git/i.test(String(text || ''))) return null;
  let data;
  try { data = await runEnvScan(false); } catch { return null; }
  if (!data) return null;
  const needLight = (data.missing || []).filter(id => !HEAVY_IDS.has(id));
  if (!needLight.length) return data;
  return await envInstall(needLight, { heavy: false });
}

/* ---------- Download widget: kolečko + procenta + historie staženého ---------- */
const dlActive = new Map(); // id -> {label, phase, percent, received, total, how}
let dlHistory = [];
try { dlHistory = JSON.parse(localStorage.getItem('nlc_downloads') || '[]'); if (!Array.isArray(dlHistory)) dlHistory = []; } catch { dlHistory = []; }
function dlSaveHistory() { try { localStorage.setItem('nlc_downloads', JSON.stringify(dlHistory.slice(0, 60))); } catch {} }
function dlMB(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' kB'; }
function dlPhaseText(p) {
  if (p.phase === 'download') return p.percent >= 0 ? 'Stahuji' : 'Stahuji';
  if (p.phase === 'extract') return 'Rozbaluji';
  if (p.phase === 'install') return 'Instaluji (' + (p.how || 'správce balíčků') + ')';
  if (p.phase === 'done') return 'Hotovo' + (p.how ? ' (' + p.how + ')' : '');
  return 'Chyba';
}
async function dlCancel(id) {
  try { await window.api.cancelDownload(id); } catch {}
  // okamžitá odezva v UI; finální úklid dorazí eventem
  if (id) dlActive.delete(String(id)); else dlActive.clear();
  renderDlWidget();
}
async function dlCancelAll() {
  try { await window.api.cancelDownload(null); } catch {}
  dlActive.clear();
  renderDlWidget();
}
function dlEvent(p) {
  if (!p || p.kind !== 'dl') return;
  const id = String(p.id || p.label || Date.now());
  if (p.phase === 'done' || p.phase === 'error') {
    const cur = dlActive.get(id) || {};
    const label = String(p.label || cur.label || id);
    // prostřední pokusy (winget/choco/scoop) do historie nepatří, jen finální výsledek
    const isTry = p.phase === 'error' && ['winget', 'choco', 'scoop'].includes(String(p.how || ''));
    // posbírej bajty ze všech aktivních položek stejného nástroje (download i pokusy mají různá id)
    let bestR = Number(p.received) || 0, bestT = Number(p.total) || 0;
    for (const [k, v] of [...dlActive.entries()]) {
      if (k === id || String(v.label || '').toLowerCase() === label.toLowerCase()) {
        bestR = Math.max(bestR, Number(v.received) || 0);
        bestT = Math.max(bestT, Number(v.total) || 0);
        dlActive.delete(k);
      }
    }
    const entry = {
      label,
      how: String(p.how || cur.how || ''),
      mb: dlMB(Math.max(bestT, bestR)),
      at: Date.now(), ok: p.phase === 'done'
    };
    if (!isTry) {
      dlHistory.unshift(entry);
      dlHistory = dlHistory.slice(0, 60);
      dlSaveHistory();
    }
    // uklidit všechny aktivní položky stejného nástroje (download i pokusy mají různá id)
    dlActive.delete(id);
    for (const [k, v] of [...dlActive.entries()]) {
      if (String(v.label || '').toLowerCase() === label.toLowerCase()) dlActive.delete(k);
    }
  } else {
    const prev = dlActive.get(id) || {};
    dlActive.set(id, {
      label: String(p.label || prev.label || id), phase: p.phase,
      percent: (typeof p.percent === 'number' ? p.percent : -1),
      received: Math.max(Number(p.received) || 0, Number(prev.received) || 0),
      total: Math.max(Number(p.total) || 0, Number(prev.total) || 0),
      how: String(p.how || prev.how || '')
    });
  }
  renderDlWidget();
}
function renderDlWidget() {
  const fab = $('#dlFab'), fill = $('#dlFill'), pct = $('#dlPct'), badge = $('#dlBadge'),
    panel = $('#dlPanel'), actBox = $('#dlActive'), histBox = $('#dlHistory');
  if (!fab) return;
  const items = [...dlActive.entries()];
  const withPct = items.filter(([, v]) => v.percent >= 0);
  if (items.length) {
    const show = withPct.length ? withPct[withPct.length - 1][1] : items[items.length - 1][1];
    fab.classList.add('busy');
    if (show.percent >= 0) {
      const p = Math.min(100, show.percent);
      fill && (fill.style.width = p + '%');
      pct && (pct.textContent = p + '%');
    } else {
      fill && (fill.style.width = '100%');
      pct && (pct.textContent = '…');
    }
    badge && (badge.style.display = items.length > 1 ? '' : 'none');
    badge && (badge.textContent = items.length);
  } else {
    fab.classList.remove('busy');
    fill && (fill.style.width = dlHistory.length ? '100%' : '0%');
    pct && (pct.textContent = dlHistory.length ? dlHistory.length + ' ✓' : '–');
    badge && (badge.style.display = 'none');
  }
  if (panel && panel.style.display !== 'none') {
    if (actBox) actBox.innerHTML = items.length ? items.map(([id, v]) => {
      const bar = v.percent >= 0
        ? '<div class="dl-bar"><div style="width:' + Math.min(100, v.percent) + '%"></div></div>'
        : '<div class="dl-bar"><div style="width:100%;opacity:.4"></div></div>';
      const sub = v.phase === 'download' && v.total > 0
        ? escapeHtml(dlMB(v.received) + ' z ' + dlMB(v.total))
        : escapeHtml(dlPhaseText(v));
      return '<div class="dl-row run"><div class="dl-row-top"><span class="dl-ico">↓</span>'
        + '<span class="dl-name">' + escapeHtml(v.label) + '</span>'
        + '<span class="dl-pct2">' + (v.percent >= 0 ? v.percent + '%' : '…') + '</span>'
        + '<button class="dl-stop" data-dlstop="' + escapeHtml(encodeURIComponent(id)) + '" title="Zrušit">✕</button></div>'
        + '<div class="dl-sub">' + sub + '</div>' + bar + '</div>';
    }).join('') : '<div class="dl-empty">Zatím nic.</div>';
    actBox.querySelectorAll('button[data-dlstop]').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = decodeURIComponent(b.getAttribute('data-dlstop') || '');
      dlCancel(id);
    }));
    const cancelAll = $('#dlCancelAll');
    if (cancelAll && !cancelAll._bound) {
      cancelAll._bound = true;
      cancelAll.addEventListener('click', (ev) => { ev.stopPropagation(); dlCancelAll(); });
    }
    if (histBox) histBox.innerHTML = dlHistory.length ? dlHistory.map(h => {
      const d = new Date(h.at);
      const when = d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
      return '<div class="dl-row ' + (h.ok ? 'ok' : 'bad') + '"><div class="dl-row-top"><span class="dl-ico">' + (h.ok ? '✓' : '✕') + '</span>'
        + '<span class="dl-name">' + escapeHtml(h.label) + '</span></div>'
        + '<div class="dl-sub">' + escapeHtml([h.how === 'portable' ? 'staženo z internetu' : h.how, h.mb, when].filter(Boolean).join(' · ')) + '</div></div>';
    }).join('') : '<div class="dl-empty">Zatím nic staženého.</div>';
  }
}

function activityFor(name, args) {
  args = args || {}; const p = args.path || args.dir || '';
  const b = baseName(p);
  if (name === 'read_file') return 'Koukám do ' + (b || 'souboru') + '…';
  if (name === 'list_dir') return 'Prohlížím složku ' + (b || args.dir || 'projektu') + '…';
  if (name === 'glob_file') return 'Hledám soubory ' + (args.pattern || '') + '…';
  if (name === 'search_files') return 'Hledám „' + (args.pattern || 'text') + '“ …';
  if (name === 'write_file') return 'Vytvářím ' + (b || 'soubor') + '…';
  if (name === 'append_file') return 'Připisuju do ' + (b || 'souboru') + '…';
  if (name === 'edit_file') return 'Upravuju ' + (b || 'soubor') + '…';
  if (name === 'shell') return 'Spouštím: ' + String(args.command || '').slice(0, 80) + '…';
  if (name === 'env_check' || name === 'env_scan') return 'Skenuju počítač…';
  if (name === 'env_prepare') return 'Připravuju nástroje…';
  if (name === 'env_install') return 'Instaluju ' + (args.id || (args.ids || []).join(', ') || 'nástroje') + '…';
  if (name === 'question') return 'Ptám se…';
  return 'Volám ' + name + '…';
}

/* ---------- modály: prompt / question / where ---------- */
function askPrompt(title, text, def) {
  return new Promise((resolve) => {
    $('#promptTitle').textContent = title; $('#promptText').textContent = text || '';
    const inp = $('#promptInput2'); inp.value = def || '';
    $('#promptModal').classList.add('open');
    const done = (v) => { $('#promptModal').classList.remove('open'); $('#promptOk').onclick = $('#promptCancel').onclick = null; resolve(v); };
    $('#promptOk').onclick = () => done(inp.value.trim() || null);
    $('#promptCancel').onclick = () => done(null);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}
function askQuestion(payload) {
  // payload: { questions: [{header, question, options:[{label, description}], multiple}] }
  return new Promise((resolve) => {
    const qs = (payload && payload.questions) || [];
    const q = qs[0] || { header: 'Otázka', question: '', options: [] };
    $('#qTitle').textContent = q.header || 'Otázka';
    $('#qText').textContent = q.question || '';
    const box = $('#qOptions'); box.innerHTML = '';
    let picked = null;
    (q.options || []).forEach((o, i) => {
      const b = document.createElement('button');
      b.className = 'q-opt' + (i === 0 ? ' sel' : '');
      b.innerHTML = '<span><b>' + escapeHtml(o.label) + '</b><small>' + escapeHtml(o.description || '') + '</small></span>';
      if (i === 0) picked = o.label;
      b.addEventListener('click', () => { box.querySelectorAll('.q-opt').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); picked = o.label; });
      b.addEventListener('dblclick', () => done(picked));
      box.appendChild(b);
    });
    const inp = $('#qCustom'); inp.value = '';
    $('#questionModal').classList.add('open');
    const done = (v) => { $('#questionModal').classList.remove('open'); $('#qOk').onclick = null; resolve(v); };
    $('#qOk').onclick = () => done(inp.value.trim() || picked);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || picked); };
  });
}
function askShellApproval(cmd) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.innerHTML = '<div class="appr-box"><div class="appr-title">AI chce spustit příkaz v terminálu</div>'
      + '<div class="appr-cmd"><code>' + escapeHtml(cmd) + '</code></div>'
      + '<div class="appr-actions"><button class="primary-btn" data-a="once">Pokračovat</button>'
      + '<button class="ghost-btn2" data-a="always">Pokračovat vždy</button>'
      + '<button class="ghost-btn2" data-a="no">Zrušit</button></div></div>';
    el.messages.appendChild(wrap); scrollBottom();
    wrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const a = b.getAttribute('data-a');
      const note = document.createElement('div');
      note.className = 'appr-done';
      note.textContent = a === 'once' ? 'Povoleno jednou.' : a === 'always' ? 'Povoleno vždy (do zavření aplikace).' : 'Zamítnuto uživatelem.';
      wrap.querySelector('.appr-box').appendChild(note);
      wrap.querySelectorAll('button').forEach(x => x.disabled = true);
      if (a === 'always') autoShell = true;
      resolve(a === 'once' || a === 'always' ? 'once' : null);
    }));
  });
}
function askWhere(sub) {
  return new Promise((resolve) => {
    $('#whereSub').textContent = sub || 'Kam to uložit?';
    window.api.knownFolders().then(f => {
      $('#whereProjectPath').textContent = prefs.activeProject || '— žádný projekt —';
      $('#whereDocsPath').textContent = f.documents || '';
      $('#whereDesktopPath').textContent = f.desktop || '';
      $('#whereDownloadsPath').textContent = f.downloads || '';
    }).catch(() => {});
    const first = document.querySelector('#whereOptions input[value="project"]');
    if (first) first.checked = true;
    $('#whereModal').classList.add('open');
    const done = (v) => { $('#whereModal').classList.remove('open'); $('#whereEnter').onclick = $('#whereCancel').onclick = $('#whereBrowse').onclick = null; resolve(v); };
    $('#whereBrowse').onclick = async () => { const r = await window.api.projectPick(); if (r && r.ok) { $('#whereCustom').value = r.path; const c = document.querySelector('#whereOptions input[value="custom"]'); if (c) c.checked = true; } };
    $('#whereCancel').onclick = () => done(null);
    $('#whereEnter').onclick = async () => {
      const sel = (document.querySelector('#whereOptions input:checked') || {}).value || 'project';
      const f = await window.api.knownFolders().catch(() => ({}));
      if (sel === 'project') done(prefs.activeProject || null);
      else if (sel === 'docs') done(f.documents || null);
      else if (sel === 'desktop') done(f.desktop || null);
      else if (sel === 'downloads') done(f.downloads || null);
      else done($('#whereCustom').value.trim() || null);
    };
  });
}

/* ---------- SSE parsing (chat + responses) ---------- */
// Chunks z IPC se mohou trhnout uprostřed JSON řádku — proto se bufferuje
// a parsují jen kompletní `\n\n` bloky. Jinak by se ztratil fragment argumentů
// a slabý model by dostal prázdné {} (write_file "mám klíče: žádné").
function parseSSE(raw, st) {
  st.buf = (st.buf || '') + String(raw);
  const parts = st.buf.split('\n\n');
  st.buf = parts.pop();
  for (const b of parts) parseSSEBlock(b, st);
  // pojistka proti neomezenému růstu při vadném streamu
  if (st.buf.length > 200000) st.buf = st.buf.slice(-200000);
}
function parseSSEBlock(b, st) {
  // st: { text, toolCalls: Map(index -> {name, argsStr}), pending: {name, argsStr} | null }
  {
    const lines = b.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'));
    for (const ln of lines) {
      const data = ln.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      // --- Responses API ---
      if (j.type === 'response.output_text.delta' && j.delta) st.text += j.delta;
      else if (j.type === 'response.text.delta' && j.delta) st.text += (typeof j.delta === 'string' ? j.delta : j.delta.text || '');
      else if (j.type === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
        // začátek volání — jméno je TADY, ne v delta eventech
        st.pending = { name: j.item.name || '', argsStr: '', id: j.item.call_id || j.item.id || ('q' + st.toolCalls.size) };
      }
      else if (j.type === 'response.function_call_arguments.delta') {
        const d = typeof j.delta === 'string' ? j.delta : (j.delta && j.delta.text) || '';
        if (!st.pending) st.pending = { name: j.name || '', argsStr: '', id: 'q' + st.toolCalls.size };
        else if (j.name && !st.pending.name) st.pending.name = j.name;
        st.pending.argsStr += d || '';
      }
      else if (j.type === 'response.function_call_arguments.done') {
        const doneArgs = typeof j.arguments === 'string' ? j.arguments : '';
        if (st.pending) {
          if (j.name && !st.pending.name) st.pending.name = j.name;
          if (doneArgs) st.pending.argsStr = doneArgs;
          st.toolCalls.set(st.pending.id, { name: st.pending.name, argsStr: st.pending.argsStr, id: st.pending.id });
          st.pending = null;
        } else if (j.name) {
          st.toolCalls.set('q' + st.toolCalls.size, { name: j.name, argsStr: doneArgs, id: 'q' + st.toolCalls.size });
        }
      }
      else if (j.type === 'response.output_item.done' && j.item && j.item.type === 'function_call') {
        st.toolCalls.set(j.item.call_id || j.item.id || ('q' + st.toolCalls.size),
          { name: j.item.name || (st.pending && st.pending.name) || '', argsStr: j.item.arguments || (st.pending && st.pending.argsStr) || '', id: j.item.call_id || j.item.id });
        st.pending = null;
      }
      else if (j.type === 'response.completed' && j.response && j.response.incomplete_details) {
        // odpověď se usekla (limit délky) — argumenty nástrojů mohou být neúplné
        st.truncated = true;
      }
      // --- chat completions ---
      const ch = (j.choices && j.choices[0]) || {};
      if (ch.finish_reason === 'length') st.truncated = true;
      const d = ch.delta || {};
      if (typeof d.content === 'string') st.text += d.content;
      const tcs = d.tool_calls || [];
      for (const tc of tcs) {
        const ix = String(tc.index != null ? tc.index : tc.id || st.toolCalls.size);
        const cur = st.toolCalls.get(ix) || { name: '', argsStr: '', id: tc.id || ix };
        if (tc.function) {
          if (tc.function.name) cur.name = tc.function.name;
          if (tc.function.arguments) cur.argsStr += tc.function.arguments;
        }
        if (tc.id) cur.id = tc.id;
        st.toolCalls.set(ix, cur);
      }
    }
  }
}
// Nedokončené volání na konci streamu (chybějící .done) — nezahazovat
function flushPending(st) {
  if (st.pending && (st.pending.name || st.pending.argsStr)) {
    st.toolCalls.set(st.pending.id, { name: st.pending.name, argsStr: st.pending.argsStr, id: st.pending.id });
  }
  st.pending = null;
}
function oneShot(messages, maxTokens, aMode) {
  const useMode = aMode || mode;
  return new Promise((resolve) => {
    const st = { text: '', toolCalls: new Map(), pending: null, error: '' };
    const onC = (d) => parseSSE(String(d), st);
    const onE = () => { cleanup(); flushPending(st); resolve(st); };
    const onX = (e) => {
      st.error = e && (e.error || e.message) ? String(e.error || e.message).slice(0, 300) : (e ? String(e).slice(0, 300) : 'neznámá chyba');
      st.isRateLimit = !!(e && e.isRateLimit) || /429|rate limit|FreeUsageLimit/i.test(st.error);
      st.isRegionBlocked = !!(e && e.isRegionBlocked) || /403|RegionError|not available in your country/i.test(st.error);
      const ra = parseInt(e && e.retryAfterMs, 10);
      st.retryAfterMs = !isNaN(ra) && ra > 0 ? Math.min(ra, 300000) : 0;
      cleanup(); flushPending(st); resolve(st);
    };
    const cleanup = () => { try { window.api.removeListeners(); } catch {} };
    try { window.api.removeListeners(); } catch {}
    window.api.onChunk(onC); window.api.onEnd(onE); window.api.onError(onX);
    window.api.chatStreamStart({
      messages, model: zenIdOf(selectedModel), convoId: activeConvoId,
      agent: useMode === 'build', mode: useMode, projectRoot: prefs.activeProject,
      fullAccess: true, maxTokens: maxTokens || SPEEDS[speedIx].tokens,
      websearch: prefs.googleSearch !== false
    });
  });
}

/* ---------- odeslání ---------- */
async function sendMessage(overrideText) {
  if (isStreaming) { pendingQueue.push(overrideText || el.promptInput.value.trim()); updateQueue(); return; }
  let text = (overrideText != null ? overrideText : el.promptInput.value.trim());
  if (!text) return;
  // slash příkazy
  if (text.startsWith('/')) {
    const handled = await handleSlash(text);
    if (handled) { el.promptInput.value = ''; autoGrow(); return; }
  }
  let convo = activeConvo();
  if (!convo || !projectMatch(convo)) convo = newConvo(true);
  activeConvoId = convo.id; localStorage.setItem('nlc_active', convo.id);
  if (convo.messages.length === 0) { convo.title = text.slice(0, 48) || 'Nová konverzace'; }
  // Rozpoznej otázku vs. úkol ještě před @expanzí (přiložený obsah by mátl detekci) — Build podle toho odpoví, nebo maká.
  const intent = detectIntent(text);
  // @ kontext: @cesta → přilož obsah souboru
  text = await expandAtRefs(text);
  convo.messages.push({ role: 'user', content: text });
  lastUserRequest = text;
  dlog('send', { textLen: text.length, textHead: text.slice(0, 200), mode, histMsgs: convo.messages.length });
  el.promptInput.value = ''; autoGrow();
  saveConvos(); renderMessages(); renderChatList();
  if (intent !== 'chat') await ensureForRequest(text);
  await runAgent(convo, intent);
}
function updateQueue() {
  if (!el.queueBar) return;
  if (!pendingQueue.length) { el.queueBar.style.display = 'none'; return; }
  el.queueBar.style.display = '';
  el.queueBar.innerHTML = '<span class="q-dot"></span><span>Ve frontě: ' + pendingQueue.length + ' — ' + escapeHtml(pendingQueue[0].slice(0, 80)) + '</span>';
}
async function expandAtRefs(text) {
  const refs = text.match(/@([^\s@]{1,120})/g) || [];
  if (!refs.length || !prefs.activeProject) return text;
  let extra = '';
  for (const r of refs.slice(0, 5)) {
    const rel = r.slice(1);
    try {
      const res = await window.api.toolsExec({ tool: 'read_file', args: { path: rel }, root: prefs.activeProject, fullAccess: true });
      if (res && res.ok) extra += '\n\n[Kontext ' + rel + ']\n' + String(res.output).slice(0, 8000);
    } catch {}
  }
  return extra ? text + '\n' + extra : text;
}
async function handleSlash(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd === '/new') { newConvo(); return true; }
  if (cmd === '/clear') { const c = activeConvo(); if (c) { c.messages = []; saveConvos(); renderMessages(); } return true; }
  if (cmd === '/help') {
    const c = activeConvo() || newConvo(true);
    c.messages.push({ role: 'user', content: text });
    c.messages.push({ role: 'assistant', content: 'Příkazy: /new (nový chat), /clear (vymazat), /model <jméno> (změnit model), /build (sám pozná otázku od úkolu), /plan (jen plán), /terminal (otevřít terminál), /preview (otevřít preview), /env (sken počítače + Fix ALL v Nastavení). Kontext: @cesta/soubor.' });
    saveConvos(); renderMessages(); return true;
  }
  if (cmd === '/model') {
    const q = parts.slice(1).join(' ').toLowerCase();
    const hit = getModels().find(m => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (hit) { selectedModel = hit.id; localStorage.setItem('nlc_model', selectedModel); updateModelLabel(); renderModelList(); setFooter('Model: ' + hit.label); }
    else setFooter('Model nenalezen: ' + q);
    return true;
  }
  if (cmd === '/plan') { setMode('plan'); return true; }
  if (cmd === '/build') { setMode('build'); return true; }
  if (cmd === '/auto') { setMode('build'); setFooter('Auto zrušeno — Build už sám pozná otázku od úkolu.'); return true; }
  if (cmd === '/terminal') { toggleTerm(true); return true; }
  if (cmd === '/preview') { if (prefs.activeProject) startPreview(prefs.activeProject); return true; }
  if (cmd === '/env') { openPrefs(); runEnvScan(true); return true; }
  return false;
}

/* ---------- Paměť úkolu: žádné opakované čtení ani identické zápisy ----------
   Slabý model dokola čte stejné soubory a zapisuje stejný obsah.
   Tohle to škrtí deterministicky: čtení se servíruje z paměti (dokud soubor
   nikdo nepřepsal), identický zápis se přeskočí s pokynem pokračovat dál. */
function taskMemKey(root, p) { return String(root || '') + '' + String(p || ''); }
function taskMemLookup(mem, name, args, root) {
  args = args || {};
  if (name === 'read_file') {
    const k = taskMemKey(root, args.path);
    if (mem.reads.has(k)) return { ok: true, output: '[Paměť úkolu — soubor se od posledního čtení nezměnil]\n' + mem.reads.get(k), cached: true };
  }
  if (name === 'write_file' && typeof args.content === 'string') {
    const k = taskMemKey(root, args.path);
    if (mem.writes.has(k) && mem.writes.get(k) === args.content)
      return { ok: true, output: `BEZE ZMĚNY — na disk se nic nezapsalo, obsah je stejný jako minule → ${args.path} (${args.content.length} znaků). Pokud jsi ho chtěl změnit, zavolej znovu se skutečně změněným obsahem; pokud změna není potřeba, pokračuj dalším krokem.`, cached: true };
    if (mem.reads.has(k) && mem.reads.get(k) === args.content)
      return { ok: true, output: `BEZE ZMĚNY — na disk se nic nezapsalo, obsah je shodný s přečteným souborem → ${args.path}. Pokud jsi ho chtěl změnit, zavolej znovu se skutečně změněným obsahem; pokud změna není potřeba, pokračuj dalším krokem.`, cached: true };
  }
  return null;
}
function taskMemStore(mem, name, args, res, root) {
  try {
    if (!res || !res.ok) return;
    args = args || {};
    if (name === 'read_file') {
      if (mem.reads.size > 50) mem.reads.clear();
      mem.reads.set(taskMemKey(root, args.path), String(res.output || ''));
    } else if (name === 'write_file' && typeof args.content === 'string') {
      if (mem.writes.size > 50) mem.writes.clear();
      const k = taskMemKey(root, args.path);
      mem.writes.set(k, args.content);
      mem.reads.set(k, args.content); // po zápisu známe přesný obsah
    } else if (['append_file', 'edit_file', 'move_file', 'copy_file', 'delete_file'].includes(name)) {
      for (const p of [args.path, args.from, args.to]) {
        if (!p) continue;
        const k = taskMemKey(root, p);
        mem.reads.delete(k); mem.writes.delete(k);
      }
    }
  } catch {}
}

/* ---------- agent smyčka (text + tool-use) ---------- */
async function runAgent(convo, intent) {
  isStreaming = true; stopRequested = false;
  el.sendBtn.disabled = true; el.stopBtn.style.display = '';
  // Build: otázka → odpovídá textem (čtecí nástroje smí), úkol → staví nástroji. Plan vždy jen plánuje.
  const isQuestion = mode !== 'plan' && intent === 'chat';
  const effMode = mode === 'plan' ? 'plan' : (isQuestion ? 'plan' : 'build');
  setFooter(isQuestion ? 'Rozpoznal jsem otázku — odpovídám…' : (effMode === 'build' ? 'Rozpoznal jsem úkol — pracuji…' : 'Generuji…'));
  const streamWrap = addMsg('assistant', '<span class="thinking">Analyzuji<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><span class="stream-caret"></span>', null);
  const bubble = streamWrap.querySelector('.bubble-assistant');
  dlog('runstart', { convoId: convo.id, mode, effMode, intent, histMsgs: convo.messages.length });
  try {
    let projCtx = '';
    if (prefs.activeProject) {
      try {
        const r = await window.api.projectFiles(prefs.activeProject, false);
        if (r && r.ok) projCtx = '\n\n[Aktivní projekt: ' + prefs.activeProject + '\nSoubory (max 300):\n' + (r.tree || []).slice(0, 120).map(t => (t.dir ? t.path : t.path)).join('\n') + ']';
      } catch {}
    }
    if (!INSTR) { try { const ir = await window.api.instructionsGet(); if (ir && ir.ok && ir.data) INSTR = ir.data; } catch {} }
    const itype = instrType();
    const sysBase = (effMode === 'build' ? instrSec('build', BUILD_SYS) : (isQuestion ? instrSec('chat', CHAT_SYS) : instrSec('plan', PLAN_PROMPT)))
      + ((effMode === 'build' && itype === 'commercial') ? instrSec('video', VIDEO_ADD) : '');
    if (activeProjectType() === 'video') {
      const vr = videoResWH();
      projCtx += '\n[Video project: target resolution ' + vr.w + 'x' + vr.h + ' (' + vr.label + '), single index.html ad.]';
    }
    let rounds = 0;
    let finalText = '';
    let planBlocked = 0; // kolikrát Plan mód odmítl zapisující nástroj (pak už model jen dopíše plán textem)
    let promiseNudge = 0; // kolikrát jsme model vrátili, když pracoval bez zápisu (max 2x)
    let emptyRounds = 0; // po sobě jdoucí kola bez textu i bez volání (po 3 konec, pak záchranné kolo)
    let lastErr = ''; // poslední chyba spojení s AI (nikdy se nesmí tiše spolknout)
    let errRounds = 0; // po sobě jdoucí chybná kola (po 3 konec s poctivou hláškou)
    let modelSwitched = false; // uz se pri 429 preslo na druhy model NolimitCoder (max 1x za pozadavek)
    let argFail = { key: '', count: 0 }; // opakované volání bez parametrů (slabý model to jinak točí dokola)
    const taskMem = { reads: new Map(), writes: new Map() }; // paměť tohoto úkolu (čtení/zápisy)
    const summarized = new Set(); // hashe výsledků už poslaných modelu (neopakovat stejný obsah)
    const readSeen = new Set(); // cesty už přečtené v tomto úkolu (pozná rutinu)
    const readCounts = {}; // cesta -> kolikrát čtena
    let readRut = 0; // po sobě jdoucí kola, která nepřinesla nic nového (jen opakované čtení)
    let readNudged = false; // direktiva proti čtecí rutině (max 1x za úkol)
    const planTrail = []; // provedené kroky úkolu (1 volání = 1 krok), pro lištu průběhu
    const maxRounds = effMode === 'build' ? 20 : 8; // slabý model potřebuje na velký úkol víc kol
    while (rounds < maxRounds && !stopRequested) {
      rounds++;
      const planRemind = (mode === 'plan' && planBlocked > 0)
        ? ' Plan mod: zapisujici nastroje nejsou dostupne. Napis plan textem.'
        : '';
      const msgs = [{ role: 'system', content: sysBase + projCtx + planRemind }];
      // Staré interní shrnutí z minulých úkolů modelu jen zahlcují kontext — posílá se jen aktuální.
      const reqStart = currentReqStart(convo);
      const hist = convo.messages;
      for (let hi = Math.max(0, hist.length - 30); hi < hist.length; hi++) {
        const m = hist[hi];
        if (m.role === 'user' && m.internal && hi < reqStart) continue;
        if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: m.content });
      }
      setActivity(rounds > 1 ? 'Pokračuji…' : 'Analyzuji…');
      bubble.innerHTML = '<span class="thinking">Analyzuji<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><span class="stream-caret"></span>';
      dlog('round', {
        round: rounds, sysChars: String(sysBase + projCtx + planRemind).length,
        msgsSent: msgs.length, promptChars: msgs.reduce((n, m) => n + String(m.content || '').length, 0),
        maxT: SPEEDS[speedIx].tokens
      });
      const roundT0 = Date.now();
      const st = await oneShot(msgs, SPEEDS[speedIx].tokens, effMode);
      if (stopRequested) break;
      // Chyba spojení se nikdy nesmí tiše spolknout — ukázat neutrální hlášku a po 3. opakování skončit.
      // Tady je poslední záchrana: 403 se neopakuje, přetížení zkusí druhý model NolimitCoder.
      if (st.error) {
        lastErr = String(st.error).slice(0, 300);
        // 403 RegionError = zeme je blokovana → rovnou poctiva hlaska, opakovat nema smysl.
        if (st.isRegionBlocked && !stopRequested) {
          finalText = 'Model není v této zemi dostupný — brána NolimitCoder vrátila 403. Zkus jiný model, nebo to zkus později.';
          break;
        }
        if (st.isRateLimit && !stopRequested) {
          // Zkusit druhy model NolimitCoder (ma vlastni kvotu), max 1x za pozadavek. Potichu, bez zmínky o limitech.
          const other = !modelSwitched && MODEL_FALLBACK[selectedModel];
          if (other && getModels().some(m => m.id === other)) {
            modelSwitched = true;
            selectedModel = other;
            try { localStorage.setItem('nlc_model', selectedModel); } catch {}
            updateModelLabel(); renderModelList();
            setActivity('Zkouším druhý model NolimitCoder…');
            setFooter('Přepnuto na ' + modelLabel(selectedModel) + '…');
            dlog('ratelimit', { modelSwitch: selectedModel });
            continue;
          }
          finalText = 'AI je teď přetížená — zkus to prosím za chvíli znovu, nebo zapni lokální model.';
          break;
        }
        errRounds++;
        setActivity('');
        setFooter('Chyba AI: ' + publicErr(lastErr).slice(0, 120));
        if (errRounds >= 3) { finalText = ''; break; }
        continue;
      }
      errRounds = 0;
      const calls = Array.from(st.toolCalls.values())
        .map(t => {
          const p = tryParseArgs(t.argsStr);
          const o = { name: normTool(t.name), args: p.obj };
          if (!p.clean) o.repaired = true;
          if (st.truncated) o.fromCut = true;
          return o;
        })
        .filter(t => t.name);
      const text = sanitizeResponse(st.text);
      dlog('roundres', {
        round: rounds, ms: Date.now() - roundT0, textLen: text.length,
        textHead: text.slice(0, 200),
        calls: calls.map(c => ({ name: c.name, argKeys: Object.keys(c.args || {}), argsLen: JSON.stringify(c.args || {}).length })),
        pendingName: (st.pending && st.pending.name) || '', pendingArgsLen: (st.pending && st.pending.argsStr || '').length,
        callsCount: st.toolCalls.size, truncated: !!st.truncated, error: st.error || ''
      });
      if (!calls.length && text) {
        // Text bez akce uprostřed práce (čte dokola, ale needituje): vrať ho k práci.
        // Za hotovou akci se počítá jen SKUTEČNÝ zápis nebo úspěšný shell/env_install
        // (přeskočené "beze změny" se nepočítají). Za závěr se bere jen text po akci
        // nebo text, který zní jako výsledek. Falešný slib na konci se označí.
        const toolMsgs = runToolMsgs(convo);
        const toolsDone = toolMsgs.length;
        const actsDone = toolMsgs.filter(m => !m.skipped && (
          ['write_file', 'append_file', 'edit_file'].includes(m.tool) ||
          ((m.tool === 'shell' || m.tool === 'env_install') && m.ok)
        )).length;
        const looksFinal = looksDone(text);
        if (effMode === 'build' && promiseNudge < 2 && toolsDone > 0 && actsDone === 0 && !looksFinal && looksPromise(text)) {
          promiseNudge++;
          dlog('nudge', { promiseNudge, toolsDone, actsDone, looksFinal, textHead: text.slice(0, 150) });
          convo.messages.push({ role: 'assistant', content: text });
          convo.messages.push({ role: 'user', internal: true, content: '[Místo oznamování rovnou volej nástroje (úpravu existujícího souboru proveď přes edit_file). Odpověď musí obsahovat tool-call.]' });
          setActivity('Upřesňuji akci…');
          continue;
        }
        if (effMode === 'build' && promiseNudge >= 2 && toolsDone > 0 && actsDone === 0 && !looksFinal && looksPromise(text) && isWorkRequest(lastUserText(convo))) {
          dlog('flagfail', { textHead: text.slice(0, 150) });
          finalText = text + '\n\n⚠ Tohle se nepovedlo dokončit — nic se nezapsalo ani nespustilo. Zkus požadavek upřesnit nebo ho zadej znovu.';
          break;
        }
        finalText = text; break;
      }
      if (text && calls.length) {
        // průběžné myšlení ukaž
        bubble.innerHTML = mdToHtml(text) + '<span class="stream-caret"></span>'; bindCopyButtons();
      }
      if (!calls.length) {
        if (text) { finalText = text; break; }
        // prázdné kolo: nezahazovat úkol hláškou, zkusit další kolo (max 3×), pak záchranné kolo
        emptyRounds++;
        if (emptyRounds >= 3) { finalText = ''; break; }
        continue;
      }
      emptyRounds = 0; // produktivní kolo → počítadlo znovu
      // proveď tool cally (každé provedení = 1 krok v liště)
      for (let ci = 0; ci < calls.length; ci++) {
        const c = calls[ci];
        if (stopRequested) break;
        if (effMode !== 'build' && !['read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'question', 'env_scan'].includes(c.name)) {
          planBlocked++;
          const blockedMsg = isQuestion ? 'Odpovídám na otázku — nezapisuji ani nespouštím, jen čtu a odpovídám textem.' : 'Nedostupné v Plan módu (jen čtení).';
          convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: blockedMsg, ok: false });
          renderToolCard(c.name, c.args, isQuestion ? 'Odpovídám na otázku.' : 'Nedostupné v Plan módu.', false);
          continue;
        }
        // Commercial video: HTML video ads ONLY (full access otherwise) — block non-video scaffolding.
        if (activeProjectType() === 'video' && ['scaffold_electron'].includes(c.name)) {
          convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: 'Video project: HTML video ads only — apps and other work are not allowed here. Build the ad as index.html.', ok: false });
          renderToolCard(c.name, c.args, 'Jen HTML videa.', false);
          continue;
        }
        if (c.name === 'question') {
          setActivity('Ptám se…');
          planTrail.push({ name: c.name, args: c.args, st: 'live' });
          renderPlanBox(planTrail, planTrail.length - 1);
          const ans = await askQuestion(c.args);
          planTrail[planTrail.length - 1].st = 'done';
          renderPlanBox(planTrail, planTrail.length - 1);
          convo.messages.push({ role: 'tool', tool: 'question', args: c.args, result: 'Uživatel odpověděl: ' + ans, ok: true });
          renderToolCard('question', c.args, ans, true);
          msgs.push({ role: 'assistant', content: text || '' });
          continue;
        }
        if (c.name === 'shell' && !autoShell) {
          const cmdKey = String(c.args.command || '').trim();
          if (!approvedOnce.has(cmdKey)) {
            const verdict = await askShellApproval(cmdKey);
            if (!verdict) {
              convo.messages.push({ role: 'tool', tool: 'shell', args: c.args, result: 'Uživatel příkaz zamítl.', ok: false });
              renderToolCard('shell', c.args, 'Zamítnuto uživatelem.', false);
              continue;
            }
            approvedOnce.add(cmdKey);
          }
        }
        // "Kam to uložit" pojistka: nejasný relativní zápis bez projektu → zeptej se
        if (['write_file', 'append_file', 'download_file'].includes(c.name) && !prefs.activeProject && !String((c.args.path || c.args.to || '')).match(/^([a-zA-Z]:[\\/]|\\\\|\/)/)) {
          const where = await askWhere('AI chce zapsat soubor ' + (c.args.path || c.args.to || '') + '. Kam to uložit?');
          if (!where) {
            convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: 'Uživatel zrušil výběr složky.', ok: false });
            renderToolCard(c.name, c.args, 'Zrušeno.', false);
            continue;
          }
          prefs.activeProject = where;
          try { await window.api.setStore({ activeProject: where }); } catch {}
        }
        setActivity(activityFor(c.name, c.args));
        const emptyWhy = emptyCallReason(c.name, c.args || {}, c);
        if (!emptyWhy) {
          planTrail.push({ name: c.name, args: c.args, st: 'live' });
          renderPlanBox(planTrail, planTrail.length - 1);
        }
        let res;
        if (emptyWhy) {
          // Vůbec neposílat — cílená chyba (zapadá i do eskalace opakovaných selhání).
          res = { ok: false, output: 'Chyba: Chybí parametr: ' + emptyWhy };
          dlog('emptycall', { tool: c.name, why: emptyWhy.slice(0, 120), cut: !!c.fromCut, repaired: !!c.repaired });
        } else {
          const memHit = taskMemLookup(taskMem, c.name, c.args, prefs.activeProject);
          if (memHit) {
            res = memHit;
            dlog('taskmem', { action: 'hit', name: c.name, path: (c.args || {}).path || (c.args || {}).dir || '' });
          } else {
            try {
              res = await window.api.toolsExec({ tool: c.name, args: withBackend(c.name, c.args), root: prefs.activeProject, fullAccess: true });
            } catch (e) { res = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
          }
        }
        // Chybí program v PC (git, node, ...)? Doinstaluj AUTOMATICKY z internetu a příkaz zopakuj — bez ptaní.
        // (Neplatí pro stráží zachycená prázdná volání — tam se má opravit volání, ne instalovat.)
        if (!emptyWhy && !res.ok && (c.name === 'shell' || c.name === 'env_check' || c.name === 'env_scan')) {
          const missId = missingBinId(res.output, c.name === 'shell' ? String(c.args.command || '') : '');
          if (missId && !autoInstalled.has(missId)) {
            autoInstalled.add(missId);
            setActivity('Chybí ' + missId + ' — stahuji a instaluji automaticky…');
            renderToolCard('env_install', { id: missId }, 'Automatická instalace ' + missId + '…', true);
            let inst;
            try {
              inst = await window.api.toolsExec({ tool: 'env_install', args: { id: missId }, root: prefs.activeProject, fullAccess: true });
            } catch (e) { inst = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
            convo.messages.push({ role: 'tool', tool: 'env_install', args: { id: missId }, result: String((inst && inst.output) || ''), ok: !!(inst && inst.ok) });
            renderToolCard('env_install', { id: missId }, String((inst && inst.output) || ''), !!(inst && inst.ok));
            if (inst && inst.ok) {
              setActivity(activityFor(c.name, c.args) + ' (po instalaci znovu)');
              try {
                res = await window.api.toolsExec({ tool: c.name, args: withBackend(c.name, c.args), root: prefs.activeProject, fullAccess: true });
              } catch (e) { res = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
            }
          }
        }
        if (!res.cached) taskMemStore(taskMem, c.name, c.args, res, prefs.activeProject);
        // Stejné volání bez parametrů 2× po sobě → eskalace: přesný tvar, žádné prosby
        if (!res.ok && /Chybí parametr/.test(String(res.output || ''))) {
          const missKey = c.name + '|' + Object.keys(c.args || {}).join(',');
          argFail = (argFail.key === missKey) ? { key: missKey, count: argFail.count + 1 } : { key: missKey, count: 1 };
          if (argFail.count >= 2) {
            const ex = ARG_EXAMPLES[c.name] || '{"path": "..."}';
            res = Object.assign({}, res, { output: String(res.output || '') + `\n[OPAKOVANÁ CHYBA ${argFail.count}×: ${c.name} voláš bez parametrů. IHNED zavolej znovu S KOMPLETNÍMI parametry v přesném tvaru: ${ex} — žádné prázdné volání!]` });
            dlog('argescalate', { tool: c.name, count: argFail.count });
          }
        } else argFail = { key: '', count: 0 };
        convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: String((res && res.output) || ''), ok: !!(res && res.ok), diff: res && res.diff, skipped: !!(res && res.cached) });
        if (!emptyWhy) {
          // Stráží zachycené prázdné volání se v chatu neukazuje (nic se nestalo) — jen v logu a v kontextu modelu.
          renderToolCard(c.name, c.args, String((res && res.output) || ''), !!(res && res.ok), res && res.diff, !!(res && res.cached));
          planTrail[planTrail.length - 1].st = (res && res.ok) ? 'done' : 'bad';
          renderPlanBox(planTrail, planTrail.length - 1);
        }
      }
      // kontext pro další kolo: shrň výsledky nástrojů AKTUÁLNÍHO požadavku (ne staré úkoly).
      // Stejný obsah se neposílá dvakrát — model by se topil ve vlastních výpisech a jen dokola četl.
      const sumHash = (t) => {
        const s = (t.tool || '') + '\n' + JSON.stringify((t.args || {})) + '\n' + String(t.result || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
        return (t.tool || '') + ':' + String(t.result || '').length + ':' + h;
      };
      const lastTools = runToolMsgs(convo).slice(-8).map(t => {
        const h = sumHash(t);
        if (summarized.has(h)) return '[' + t.tool + ' ' + (t.ok ? 'OK' : 'CHYBA') + ']\n(stejný výsledek jako výše — neopakuji)';
        summarized.add(h);
        return '[' + t.tool + ' ' + ((t.ok ? 'OK' : 'CHYBA')) + ']\n' + String(t.result).slice(0, 2000);
      }).join('\n\n');
      convo.messages.push({ role: 'user', internal: true, content: '[Výsledky nástrojů — pokračuj v práci, nebo napiš výsledek.]\n' + lastTools });
      // Rutina: kola, která jen znovu čtou už přečtené soubory a nic nového nepřinesla.
      // Jednou za úkol to utnout konkrétní direktivou (ne obecným povzbuzením).
      const READ_TOOLS = ['read_file', 'list_dir', 'glob_file', 'file_info'];
      if (calls.length && calls.every(c => READ_TOOLS.includes(c.name))) {
        let fresh = false;
        for (const c of calls) {
          const p = String((c.args || {}).path || (c.args || {}).dir || '.');
          readCounts[p] = (readCounts[p] || 0) + 1;
          if (!readSeen.has(p)) { fresh = true; readSeen.add(p); }
        }
        if (!fresh) readRut++; else readRut = 0;
        if (readRut >= 2 && !readNudged) {
          let top = '', topN = 0;
          for (const c of calls) {
            const p = String((c.args || {}).path || (c.args || {}).dir || '.');
            if ((readCounts[p] || 0) > topN) { topN = readCounts[p]; top = p; }
          }
          readNudged = true;
          readRut = 0;
          convo.messages.push({ role: 'user', internal: true, content: `[Dost čtení. Soubor ${top} už znáš nazpaměť — teď HNED zavolej edit_file nebo write_file s upraveným obsahem. Žádné další čtení, odpověď musí obsahovat tool-call.]` });
          dlog('rutbreak', { file: top });
          setActivity('Tlačím k akci…');
        }
      } else {
        for (const c of calls) {
          if (READ_TOOLS.includes(c.name)) {
            const p = String((c.args || {}).path || (c.args || {}).dir || '.');
            readSeen.add(p);
          }
        }
        readRut = 0;
      }
      if (calls.every(c => ['read_file', 'list_dir', 'glob_file', 'search_files', 'file_info', 'web_fetch', 'web_search', 'env_check', 'env_scan'].includes(c.name)) && !st.text) {
        // čistě čtecí kolo bez textu → ještě jedno kolo na odpověď
        continue;
      }
      if (runToolMsgs(convo).length > 30) { finalText = text || 'Hotovo.'; break; }
    }
    // Závěr bez textu modelu: shrnutí se postaví Z DAT (co se zapsalo/spustilo/selhalo),
    // neptá se modelu — ten by zase jen něco slíbil. Model se volá jen když se nestalo vůbec nic.
    if (!finalText && !stopRequested) {
      const doneSummary = buildRunSummary(runToolMsgs(convo), lastErr, lastUserText(convo));
      if (doneSummary) {
        finalText = doneSummary;
        dlog('final', { kind: 'summary', finalLen: finalText.length });
      } else {
        try {
          setActivity('Sepisuji výsledek…');
          const rec = await oneShot([
            { role: 'system', content: sysBase },
            { role: 'user', content: '[Napiš stručně textem, v jakém stavu práce je a kde je výsledek (cesta k souboru/exe). Žádné nástroje, jen 2-4 věty.]' }
          ], 1024, effMode);
          if (rec && rec.text) finalText = rec.text;
          dlog('final', { kind: 'model', finalLen: finalText.length });
        } catch {}
      }
    }
    // Práce je hotová, ale model píše v přítomném čase ("Opravuji…"), jako by teprve začínal.
    // Takový text se nahradí fakty v minulém čase (co se zapsalo/spustilo).
    if (finalText && !stopRequested) {
      const acts = runToolMsgs(convo).filter(m => !m.skipped && (
        ['write_file', 'append_file', 'edit_file'].includes(m.tool) ||
        ((m.tool === 'shell' || m.tool === 'env_install') && m.ok)
      ));
      if (acts.length && looksPromise(finalText) && !looksDone(finalText)) {
        const s = buildRunSummary(runToolMsgs(convo), lastErr, lastUserText(convo));
        if (s) { dlog('final', { kind: 'past-rewrite' }); finalText = s; }
      }
    }
    finalText = sanitizeResponse(finalText || '');
    if (!finalText && lastErr) finalText = 'Nedokončeno — ' + publicErr(lastErr) + ' Zkus to prosím znovu za chvíli.';
    dlog('final', { finalLen: finalText.length, finalHead: finalText.slice(0, 200), rounds });
    convo.messages.push({ role: 'assistant', content: finalText || 'Nedostala jsem od AI žádnou odpověď (prázdný stream). Zkus to prosím poslat znovu.' });
    saveConvos(); renderMessages(); renderChatList();
    setFooter('Hotovo'); playDone();
  } catch (e) {
    bubble.innerHTML = mdToHtml('Chyba: ' + (e.message || e));
    setFooter('Chyba');
  } finally {
    isStreaming = false; setActivity(null); hidePlanBox();
    el.sendBtn.disabled = false; el.stopBtn.style.display = 'none';
    try { window.api.removeListeners(); } catch {}
    try { if (activeProjectType() === 'video') refreshVideoEmpty(); } catch {}
    if (pendingQueue.length) { const nx = pendingQueue.shift(); updateQueue(); sendMessage(nx); }
    else updateQueue();
  }
}
/* Deterministické shrnutí úkolu Z DAT (bez modelu — ten by zase jen něco slíbil) */
function buildRunSummary(toolMsgs, lastErr, userText) {
  const ms = (toolMsgs || []).filter(m => !m.skipped);
  if (!ms.length) return '';
  const uniq = (a) => [...new Set(a)];
  const short = (p) => String(p || '').split(/[\\/]/).slice(-2).join('/');
  const writes = uniq(ms.filter(m => ['write_file', 'append_file', 'edit_file'].includes(m.tool) && m.ok)
    .map(m => short((m.args || {}).path || (m.args || {}).to)));
  const shellsOk = ms.filter(m => m.tool === 'shell' && m.ok).map(m => String((m.args || {}).command || '').slice(0, 80));
  const shellsBad = ms.filter(m => m.tool === 'shell' && !m.ok);
  const envOk = ms.filter(m => m.tool === 'env_install' && m.ok).length;
  const reads = ms.filter(m => ['read_file', 'list_dir', 'glob_file', 'file_info'].includes(m.tool)).length;
  const didWork = writes.length > 0 || shellsOk.length > 0 || envOk > 0;
  const lines = [shellsBad.length ? 'Nedokončeno.' : (didWork ? 'Hotovo.' : (isWorkRequest(userText)
    ? 'Nedokončeno — nic se nezapsalo ani nespustilo, model jen četl.'
    : 'Hotovo.'))];
  if (writes.length) lines.push('Zapsáno: ' + writes.join(', '));
  if (shellsOk.length) lines.push('Spuštěno: ' + shellsOk[shellsOk.length - 1] + (shellsOk.length > 1 ? ` (+${shellsOk.length - 1}×)` : ''));
  if (envOk) lines.push('Doinstalováno nástrojů: ' + envOk);
  if (!writes.length && !shellsOk.length && !envOk) lines.push(isWorkRequest(userText)
    ? `Jen průzkum (čtení: ${reads}) — požadovaná změna se nestala. Zadej požadavek znovu nebo ho upřesni.`
    : `Zatím jen průzkum (čtení: ${reads}).`);
  if (shellsBad.length) {
    const last = shellsBad[shellsBad.length - 1];
    const err = String(last.result || '').split('\n').map(s => s.trim())
      .filter(s => /chyba|error|fail|není|neni|not found|nelze|selhal|exit [1-9]|nenalezen/i.test(s))[0]
      || String(last.result || '').slice(0, 200);
    lines.push(`Poslední příkaz selhal (${String((last.args || {}).command || '').slice(0, 80)}): ${err.slice(0, 220)}`);
  }
  if (lastErr) lines.push('Pozn.: ' + publicErr(lastErr).slice(0, 120));
  return lines.join('\n');
}
/* Přesný tvar parametrů pro eskalaci opakovaných chyb (slabý model ignoruje zdvořilou hlášku) */
const ARG_EXAMPLES = {
  write_file: '{"path": "index.html", "content": "<CELÝ obsah souboru>"}',
  append_file: '{"path": "index.html", "content": "<text k připsání>"}',
  edit_file: '{"path": "index.html", "oldString": "<přesný text ze souboru>", "newString": "<nový text>"}',
  read_file: '{"path": "index.html"}',
  list_dir: '{"path": "."}',
  shell: '{"command": "npm run dist", "timeout": 600000}'
};
/* Prázdné/usjeknuté volání se vůbec neposílá do nástrojů.
   Vrací důvod k chybové hlášce, nebo '' když je volání v pořádku.
   (env_scan/env_prepare/list_dir/glob_file prázdné být smí; env_install
   bez ID by stahovalo VŠECHNO, takže se vyžaduje.) */
function emptyCallReason(name, args, c) {
  args = args || {};
  if (name === 'env_install' && !args.ids && !args.id)
    return 'upřesni která ID (ids: ["node", "python", ...]) — prázdné volání by stahovalo VŠECHNO';
  const needsParams = ['shell', 'write_file', 'append_file', 'edit_file', 'read_file', 'create_dir',
    'delete_file', 'move_file', 'copy_file', 'file_info', 'web_fetch', 'web_search', 'download_file',
    'scaffold_electron', 'question', 'open_path', 'search_files'];
  if (!needsParams.includes(name)) return '';
  if (Object.keys(args).length > 0) {
    // Slepené argumenty po useknutém streamu se u zápisů nesmí provést (chyběl by konec obsahu).
    if (c && c.fromCut && c.repaired && ['write_file', 'append_file', 'edit_file'].includes(name))
      return 'volání se useklo uprostřed parametrů — zavolej ' + name + ' ZNOVU, KOMPLETNĚ a najednou';
    return '';
  }
  const ex = ARG_EXAMPLES[name] || '{"path": "..."}';
  const cut = c && c.fromCut ? ' (odpověď se usekla)' : '';
  return 'prázdné volání ' + name + cut + ' — zavolej ' + name + ' ZNOVU, KOMPLETNĚ v přesném tvaru: ' + ex;
}
/* Poslední skutečný požadavek uživatele (bez interních zpráv smyčky) */
function lastUserText(convo) {
  const ms = ((convo && convo.messages) || []).filter(m => m.role === 'user' && !m.internal && m.content);
  return ms.length ? String(ms[ms.length - 1].content) : '';
}
/* Index, kde začíná aktuální požadavek (za poslední neinterní user zprávou) */
function currentReqStart(convo) {
  const ms = (convo && convo.messages) || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === 'user' && !ms[i].internal) return i + 1;
  }
  return 0;
}
/* Nástroje provedené v AKTUÁLNÍM požadavku (minulé úkoly se nepočítají) */
function runToolMsgs(convo) {
  const ms = (convo && convo.messages) || [];
  return ms.slice(currentReqStart(convo)).filter(m => m.role === 'tool');
}
/* Vypadá text jako HOTOVÝ výsledek (minulý čas), nebo jako SLIB (budoucí/přítomný čas)?
   Pravidlo: minulé tvary nesmí být podřetězcem přítomných ("sestavení" není "sestaveno").
   Proto hotové tvary jen jednoznačné, sliby v přítomném čase. */
function looksDone(t) {
  return /hotovo|hotov\b|hotov[ýáé]|hotovy|hotovi|hotové|hotove|dokončeno|dokonceno|nainstalov|zapsán|zapsan|zapsáno|zapsano|upraven|upraveno|vytvořen|vytvoren|vytvořeno|vytvoreno|ověřen|overen|ověřeno|overeno|připraven|pripraven|připraveno|pripraveno|opraven|opraveno|done|závěr|zaver|shrnut|shrnout|výsledek:|vysledek:/i.test(String(t || ''));
}
function looksPromise(t) {
  return /opravuj|opravuji|opravuju|opravím|opravim|ověřuj|overuj|ověřuji|overuji|ověřuju|ověřím|overim|mění|menim|měním|píš|pisu|píši|pisi|dělám|delam|přidáv|pridav|maž|maz|smaž|smaz|kompiluj|sestavuj|generuj|tvořím|tvorim|pracuj|řeš|resim|hledám|hledam|čtu|ctu|dokončuj|dokoncuj|zapisuj|zapisuji|ukládám|ukladam|instaluj|zjistím|zjistim|budu|projdu|napíšu|napisu|udělám|udelam|připrav|priprav|zkontroluj|podívám|podivam|upravuj|upravuji|upravuju|upravím|upravim|spustím|spustim|zkusím|zkusim|pokračuj|pokracuj|začínám|zacinam|načítám|nacitam|nainstaluji|stavím|stavim|vytvářím|vytvarim|nejprve|nejdřív|nejdrive|hned/i.test(String(t || ''));
}
/* Vypadá požadavek jako práce (něco udělat), nebo jako otázka? */
function isWorkRequest(t) {
  return /udělej|udelej|vytvoř|vytvor|naprogramuj|napiš|napis|uprav|změň|zmen|přebarvi|prebarvi|odstraň|odstran|přidej|pridej|oprav|sestav|zkompiluj|přebuilduj|prebuild|překompiluj|prekompiluj|nainstaluj|smaž|smaz|vyrob|postav|přepiš|prepis|rozšiř|rozsir|dodělej|dodelej|vygeneruj|vygenerovat|přidej funkci|pridej funkci|dodat|doplň|dopln|rozšiř|zkus (to |ten |tu )?(opravit|sestavit|prepsat)/i.test(String(t || ''));
}
function normTool(t) {  let s = String(t || '').replace(/^(default|functions|tools)\./i, '').trim().toLowerCase();
  if (s === 'shell_admin') return 'shell';
  if (s === 'read') return 'read_file';
  return s;
}
/* Oprava useknutého/rozbitého JSON (useknutý stream, slepené chunky).
   Vrací {obj, clean} — clean=false znamená "slepeno", takovým argumentům
   se u zápisů nedá věřit (mohl chybět konec obsahu). */
function repairJson(s) {
  s = String(s || '').trim();
  if (!s) return null;
  try { return { obj: JSON.parse(s), clean: true }; } catch {}
  let t = s.replace(/\\$/, '');
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  try { return { obj: JSON.parse(t), clean: false }; } catch { return null; }
}
function tryParseArgs(s) {
  const r = repairJson(s);
  if (r && r.obj && typeof r.obj === 'object' && !Array.isArray(r.obj)) return r;
  return { obj: {}, clean: !String(s || '').trim() };
}
function safeParseArgs(s) { return tryParseArgs(s).obj; }
/* Z výstupu neúspěšného shellu poznej chybějící program (git, node, ...) pro automatickou instalaci */
function missingBinId(output, cmd) {
  const s = String(output || '');
  if (!/not recognized|není rozpoznán|neni rozpoznan|command not found|nenalezen|není nainstalován|neni nainstalovan|no such file|nemohl být nalezen|nemohl byt nalezen|was not found/i.test(s)) return null;
  let bin = '';
  const q = s.match(/['"]([A-Za-z][\w.+~-]*)['"]\s+(is not|není|neni)/i) || s.match(/\b([A-Za-z][\w.+~-]*)\s+(is not recognized|není rozpoznán|neni rozpoznan)/i);
  if (q) bin = q[1].toLowerCase();
  else {
    const m = String(cmd || '').trim().match(/^["']?([A-Za-z][\w.+~-]*)/);
    bin = ((m && m[1]) || '').toLowerCase();
  }
  const map = {
    node: 'node', npm: 'node', npx: 'node',
    python: 'python', py: 'python', pip: 'python',
    git: 'git', gcc: 'gcc', 'g++': 'gcc',
    go: 'go', cargo: 'rust', rustc: 'rust',
    dotnet: 'dotnet', java: 'java', javac: 'java'
  };
  return map[bin] || null;
}
function withBackend(name, args) {
  if (name === 'shell') {
    const be = prefs.shellBackend && prefs.shellBackend !== 'all' ? prefs.shellBackend : (prefs.terminal || 'auto');
    return Object.assign({}, args, { backend: be === 'all' ? 'auto' : be });
  }
  return args;
}
function autoGrow() {
  if (!el.promptInput) return;
  el.promptInput.style.height = 'auto';
  el.promptInput.style.height = Math.min(el.promptInput.scrollHeight, 160) + 'px';
}
function setMode(m) {
  if (m === 'auto') m = 'build'; // Auto zrušeno — Build už sám pozná otázku od úkolu
  mode = m; localStorage.setItem('nlc_mode', m);
  $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === m));
  if (el.planHint) el.planHint.style.display = m === 'plan' ? '' : 'none';
}

/* ---------- terminál ---------- */
function toggleTerm(force) {
  const p = $('#termPane');
  const show = force != null ? force : p.style.display === 'none';
  p.style.display = show ? '' : 'none';
  if (show) setTimeout(() => $('#termInput').focus(), 50);
}
async function termExec(cmd) {
  const out = $('#termOut');
  const line = document.createElement('div');
  line.innerHTML = '<span class="t-cmd">&gt; ' + escapeHtml(cmd) + '</span>';
  out.appendChild(line); out.scrollTop = out.scrollHeight;
  try {
    const r = await window.api.termRun({ command: cmd, cwd: prefs.activeProject || undefined, timeout: 120000 });
    const d = document.createElement('div');
    d.className = r && r.ok ? 't-ok' : 't-err';
    d.textContent = String((r && r.output) || '(bez výstupu)');
    out.appendChild(d);
  } catch (e) {
    const d = document.createElement('div'); d.className = 't-err'; d.textContent = 'Chyba: ' + (e.message || e); out.appendChild(d);
  }
  out.scrollTop = out.scrollHeight;
}

/* ---------- preview (+ video režim) ---------- */
function setVideoMode(on) {
  const pane = $('#previewPane'), bar = $('#videoBar'), blocker = $('#videoBlocker');
  if (pane) pane.classList.toggle('video', !!on);
  try { $('#viewChat').classList.toggle('video', !!on); } catch {}
  if (bar) bar.style.display = on ? '' : 'none';
  if (blocker) blocker.style.display = on ? '' : 'none';
  if (on) {
    const rs = $('#videoRes'); if (rs) rs.value = videoRes;
    const du = $('#videoDurRange'); if (du) { du.value = String(videoDurIx()); try { du.style.setProperty('--fill', (videoDurIx() / (VIDEO_DURS.length - 1) * 100) + '%'); } catch {} }
    const dl2 = $('#videoDurLabel'); if (dl2) dl2.textContent = fmtDur(videoDur);
    setVideoProgress('');
    const dl = $('#videoDownload'); if (dl) dl.style.display = 'none';
    lastVideoPath = null;
  }
}
function isVideoMode() { try { return $('#previewPane').classList.contains('video'); } catch { return false; } }
// Rámeček videa: přesné pixely rozlišení, zmenšené aby se vešlo (export jede vždy v plném rozlišení)
function fitVideoFrame() {
  if (!isVideoMode()) return;
  const frame = $('#previewFrame'), stage = $('#previewStage');
  if (!frame || !stage) return;
  const { w, h } = videoResWH();
  const r = stage.getBoundingClientRect();
  const s = Math.min(1, (r.width - 24) / w, (r.height - 24) / h);
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
  frame.style.transform = 'scale(' + s + ')';
  try { frame.style.setProperty('--s', s); } catch {}
  frame.style.flex = 'none';
}
async function startPreview(root, type) {
  try {
    const r = await window.api.previewStart(root);
    if (r && r.ok) {
      $('#previewPane').style.display = '';
      // Video (commercial) has no Preview toggle button — the preview is always there.
      const isVid = type === 'video' || isVideoMode();
      $('#previewToggle').style.display = isVid ? 'none' : '';
      if (!isVid) $('#previewToggle').textContent = 'Preview ✓';
      $('#previewUrl').textContent = r.url;
      $('#previewFrame').src = r.url;
      if (type === 'video' || isVideoMode()) {
        setVideoMode(true);
        setTimeout(fitVideoFrame, 60);
        setTimeout(refreshVideoEmpty, 150);
      } else {
        const f = $('#previewFrame');
        if (f) { f.style.width = ''; f.style.height = ''; f.style.transform = ''; f.style.flex = ''; }
      }
    }
  } catch {}
}
/* Empty video project → the frame shows gray with thick dots (never white),
   plus the waiting text on top. As soon as index.html exists, the real ad shows. */
const VIDEO_EMPTY_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<body style="margin:0;background:#0a0a0d;background-image:radial-gradient(circle,rgba(255,255,255,0.13) 2.6px,transparent 3.2px);background-size:26px 26px">');
async function refreshVideoEmpty() {
  const empty = $('#videoEmpty'), frame = $('#previewFrame');
  if (!empty || !frame) return;
  if (!isVideoMode() || !prefs.activeProject) { empty.style.display = 'none'; return; }
  let hasIndex = false;
  try {
    const r = await window.api.projectFiles(prefs.activeProject, false);
    if (r && r.ok) {
      const paths = (r.tree || []).map(t => String(t.path || '').toLowerCase());
      hasIndex = paths.includes('index.html') || paths.includes('dist/index.html');
    }
  } catch {}
  if (hasIndex) {
    empty.style.display = 'none';
    const src = String(frame.src || '');
    if (!src || src === 'about:blank' || src.startsWith('data:')) {
      const url = $('#previewUrl') ? $('#previewUrl').textContent : '';
      if (url && url.startsWith('http')) frame.src = url;
    }
    fitVideoFrame();
  } else {
    try { if (String(frame.src || '') !== VIDEO_EMPTY_PAGE) frame.src = VIDEO_EMPTY_PAGE; } catch {}
    empty.style.display = '';
    fitVideoFrame();
  }
}
function setVideoProgress(t) { const p = $('#videoProgress'); if (p) p.textContent = t || ''; }
async function videoExportRun() {
  if (videoExporting) return;
  if (!prefs.activeProject) { setVideoProgress('No project selected'); return; }
  const { w, h } = videoResWH();
  videoExporting = true;
  const btn = $('#videoExport'); if (btn) btn.disabled = true;
  const dl = $('#videoDownload'); if (dl) dl.style.display = 'none';
  setVideoProgress('Preparing…');
  try {
    const r = await window.api.videoExport({ root: prefs.activeProject, width: w, height: h, durationSec: videoDur, fps: 30 });
    if (r && r.ok) {
      lastVideoPath = r.path;
      setVideoProgress('Done: ' + r.file + ' (' + r.mb + ')');
      if (dl) dl.style.display = '';
      playDone();
    } else {
      setVideoProgress('Export failed: ' + ((r && r.error) || 'unknown error').slice(0, 160));
    }
  } catch (e) {
    setVideoProgress('Export failed: ' + String((e && e.message) || e).slice(0, 160));
  }
  videoExporting = false;
  if (btn) btn.disabled = false;
}
async function videoDownloadRun() {
  if (!lastVideoPath) return;
  try { await window.api.videoReveal(lastVideoPath); }
  catch { try { window.api.openPath(lastVideoPath); } catch {} }
}
function hidePreview() {
  $('#previewPane').style.display = 'none';
  $('#previewToggle').style.display = 'none';
  try { $('#previewFrame').src = 'about:blank'; } catch {}
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  bindEls();
  try { const s = await window.api.getStore(); prefs = Object.assign(prefs, s || {}); } catch {}
  // po startu: uložený aktivní chat mohl patřit jinému projektu — srovnat
  if (!activeConvo() || !projectMatch(activeConvo())) {
    const rest = conversations.filter(projectMatch);
    activeConvoId = rest.length ? rest[rest.length - 1].id : null;
    try { localStorage.setItem('nlc_active', activeConvoId || ''); } catch {}
  }
  try { const v = await window.api.getVersion(); if ($('#sideVer')) $('#sideVer').textContent = 'NolimitCoder ' + v; } catch {}
  mode = prefs.mode || mode || 'build';
  if (mode === 'auto') mode = 'build'; // migrace ze zrušeného Auto
  setMode(mode);
  // rychlost
  const slider = $('#speedSlider'), slabel = $('#speedLabel');
  const speedFill = () => {
    try {
      const v = parseInt(slider.value, 10) || 0;
      slider.style.setProperty('--fill', (v / 2 * 100) + '%');
      const dot = $('#speedDot');
      if (dot) dot.className = 'speed-dot' + (v === 2 ? ' high' : v === 1 ? ' mid' : '');
    } catch {}
  };
  if (slider) {
    slider.value = String(speedIx);
    const names = ['Fast', 'Medium', 'High'];
    if (slabel) slabel.textContent = names[speedIx];
    speedFill();
    slider.addEventListener('input', () => { speedIx = parseInt(slider.value, 10) || 0; localStorage.setItem('nlc_speed', String(speedIx)); if (slabel) slabel.textContent = names[speedIx]; speedFill(); });
  }
  updateModelLabel(); renderModelList(); renderProjects(); showView('projects');
  renderChatList(); renderMessages();
  try { const d = await window.api.projectsDir(); if ($('#projectsDirPath')) $('#projectsDirPath').textContent = d; } catch {}
  // model picker — dropdown se vždy vejde do okna (posune se doleva, když by přetekl vpravo)
  el.modelCurrent.addEventListener('click', (e) => { e.stopPropagation(); el.modelDropdown.classList.toggle('open'); if (el.modelDropdown.classList.contains('open')) { clampDropdown(); setTimeout(() => el.modelSearch.focus(), 30); } });
  window.addEventListener('resize', () => { try { clampDropdown(); } catch {} });
  document.addEventListener('click', (e) => { if (!el.modelSelector.contains(e.target)) closeModels(); });
  el.modelSearch.addEventListener('input', () => { searchQuery = el.modelSearch.value; renderModelList(); });
  $('#fetchZenBtn').addEventListener('click', (e) => { e.preventDefault(); refreshZenLive(); });
  $$('#modeSeg button').forEach(b => b.addEventListener('click', () => setMode(b.getAttribute('data-mode'))));
  $('#planSwitchBtn').addEventListener('click', () => setMode('build'));
  $('#planDismissBtn').addEventListener('click', () => { if (el.planHint) el.planHint.style.display = 'none'; });
  // composer
  el.promptInput.addEventListener('input', autoGrow);
  el.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  el.sendBtn.addEventListener('click', () => sendMessage());
  el.stopBtn.addEventListener('click', () => { stopRequested = true; try { window.api.chatStreamAbort(); } catch {} setFooter('Zastaveno'); });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newConvo(); renderMessages(); } });
  $('#newChatBtn').addEventListener('click', () => { newConvo(); renderMessages(); });
  $('#backBtn').addEventListener('click', () => { showView('projects'); renderProjects(); });
  // term
  $('#termToggle').addEventListener('click', () => toggleTerm());
  $('#termHide').addEventListener('click', () => toggleTerm(false));
  $('#termClear').addEventListener('click', () => { $('#termOut').innerHTML = ''; });
  $('#termInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { e.target.value = ''; termExec(v); } } });
  // preview
  $('#previewToggle').addEventListener('click', () => {
    const p = $('#previewPane');
    const show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    if (show && prefs.activeProject) startPreview(prefs.activeProject);
  });
  $('#previewHide').addEventListener('click', () => { $('#previewPane').style.display = 'none'; });
  // video: resolution + length + export to MP4 + download
  const vres = $('#videoRes');
  if (vres) {
    vres.value = videoRes;
    vres.addEventListener('change', () => {
      videoRes = vres.value;
      try { localStorage.setItem('nlc_videores', videoRes); } catch {}
      // ultra-smooth bubble pop on resolution switch
      try {
        const fr = $('#previewFrame');
        if (fr) { fr.classList.remove('res-pop'); void fr.offsetWidth; fr.classList.add('res-pop'); }
      } catch {}
      fitVideoFrame();
    });
  }
  const vdur = $('#videoDurRange'), vdlab = $('#videoDurLabel');
  const durFill = () => {
    try {
      const ix = parseInt(vdur.value, 10) || 0;
      vdur.style.setProperty('--fill', (ix / (VIDEO_DURS.length - 1) * 100) + '%');
      if (vdlab) vdlab.textContent = fmtDur(VIDEO_DURS[ix] || 30);
    } catch {}
  };
  if (vdur) {
    vdur.value = String(videoDurIx());
    durFill();
    vdur.addEventListener('input', () => {
      videoDur = VIDEO_DURS[parseInt(vdur.value, 10) || 0] || 30;
      try { localStorage.setItem('nlc_videodur', String(videoDur)); } catch {}
      durFill();
    });
  }
  const vexp = $('#videoExport');
  if (vexp) vexp.addEventListener('click', videoExportRun);
  const vdl = $('#videoDownload');
  if (vdl) vdl.addEventListener('click', videoDownloadRun);
  try {
    window.api.onVideoProgress((p) => {
      if (!p) return;
      if (p.phase === 'frames') setVideoProgress('Recording ' + p.done + '/' + p.total + '…');
      else if (p.phase === 'encode') setVideoProgress('Encoding MP4…');
      else if (p.phase === 'ffmpeg') setVideoProgress('Preparing converter (' + (p.percent >= 0 ? p.percent + '%' : 'downloading') + ')…');
      else if (p.msg) setVideoProgress(p.msg);
    });
  } catch {}
  window.addEventListener('resize', () => { try { fitVideoFrame(); } catch {} });
  $('#previewReload').addEventListener('click', () => { try { $('#previewFrame').contentWindow.location.reload(); } catch {} try { refreshVideoEmpty(); } catch {} });
  $('#previewOpen').addEventListener('click', () => { const u = $('#previewUrl').textContent; if (u && u.startsWith('http')) window.api.openExternal(u); });
  // create project modal
  $('#createProjectBtn').addEventListener('click', () => {
    $('#pmPicked').textContent = 'Zatím nevybrána žádná složka';
    $('#pmPicked').dataset.path = '';
    $('#pmName').value = '';
    $('#projectModal').classList.add('open');
  });
  $('#pmCancel').addEventListener('click', () => $('#projectModal').classList.remove('open'));
  document.querySelectorAll('input[name="ptype"]').forEach(r => r.addEventListener('change', () => {
    const v = (document.querySelector('input[name="ptype"]:checked') || {}).value;
    $('#pmContent').classList.toggle('wide', v === 'website');
  }));
  $('#pmPick').addEventListener('click', async () => {
    const r = await window.api.projectPick();
    if (r && r.ok) { $('#pmPicked').textContent = r.path; $('#pmPicked').dataset.path = r.path; if (!$('#pmName').value) $('#pmName').value = baseName(r.path); }
  });
  $('#pmNext').addEventListener('click', async () => {
    const path = $('#pmPicked').dataset.path;
    const name = $('#pmName').value.trim() || baseName(path) || 'Projekt';
    if (!path) { $('#pmPicked').textContent = 'Nejdřív vyber složku…'; return; }
    const type = (document.querySelector('input[name="ptype"]:checked') || {}).value || 'universal';
    const frame = type === 'video' ? 'html' : ((document.querySelector('input[name="pframe"]:checked') || {}).value || 'html');
    projectRegistry.push({ name, path, type, framework: frame });
    saveRegistry(); $('#projectModal').classList.remove('open'); renderProjects();
    openProject({ name, path, type, framework: frame });
    if (type === 'video') {
      try {
        const chk = await window.api.toolsExec({ tool: 'list_dir', args: { path: '.' }, root: path, fullAccess: true });
        if (!chk || !chk.ok || chk.output === '(prázdná složka)' || chk.output === '(empty folder)') {
          const vr = videoResWH();
          el.promptInput.value = 'Create an advertising commercial (' + vr.w + 'x' + vr.h + ', ' + vr.label + ') as a single index.html in the project root: full-viewport animated ad, autoplay, no clicks needed (behaves like a video). Then verify with file_info.';
          sendMessage();
        }
      } catch {}
    } else if (type === 'website') {
      try {
        const chk = await window.api.toolsExec({ tool: 'list_dir', args: { path: '.' }, root: path, fullAccess: true });
        if (!chk || !chk.ok || chk.output === '(prázdná složka)') {
          el.promptInput.value = 'Vytvor funkcni web (' + frame + ') v tomto projektu: index.html v korenu' + (frame === 'html' ? ', bez buildu' : ', build do dist/') + ', rovnou k pouziti. Pak to over pres file_info.';
          sendMessage();
        }
      } catch {}
    }
  });
  // prefs
  $('#prefsBtn').addEventListener('click', openPrefs);
  if (el.envScanBtn) el.envScanBtn.addEventListener('click', () => runEnvScan(true));
  if (el.envFixAllBtn) el.envFixAllBtn.addEventListener('click', () => envFixAll());
  if (el.envHeavyCheck) el.envHeavyCheck.addEventListener('change', () => { if (envData) renderEnvPanel(); });
  // download widget (vlevo dole)
  const dlFab = $('#dlFab');
  if (dlFab) dlFab.addEventListener('click', () => {
    const p = $('#dlPanel'); if (!p) return;
    const open = p.style.display === 'none';
    p.style.display = open ? '' : 'none';
    if (open) renderDlWidget();
  });
  if (window.api && window.api.onDownload) { try { window.api.onDownload(dlEvent); } catch {} }
  try { renderDlWidget(); } catch {}
  $('#prefsClose').addEventListener('click', () => $('#prefsModal').classList.remove('open'));
  $('#prefsBackdrop').addEventListener('click', () => $('#prefsModal').classList.remove('open'));
  document.querySelectorAll('#prefsNav button').forEach(b => b.addEventListener('click', () => prefsGo(b.getAttribute('data-pref'))));
  $('#soundCheck').addEventListener('change', async (e) => { prefs.sound = e.target.checked; try { await window.api.setStore({ sound: prefs.sound }); } catch {} });
  const gc0 = $('#googleCheck');
  if (gc0) gc0.addEventListener('change', async (e) => { prefs.googleSearch = e.target.checked; try { await window.api.setStore({ googleSearch: prefs.googleSearch }); } catch {} });
  document.querySelectorAll('input[name="shellbe"]').forEach(r => r.addEventListener('change', async () => {
    const v = (document.querySelector('input[name="shellbe"]:checked') || {}).value || 'auto';
    prefs.shellBackend = v; prefs.terminal = v;
    try { await window.api.setStore({ terminal: v }); } catch {}
  }));
  $('#openProjectsDir').addEventListener('click', async () => { try { const d = await window.api.projectsDir(); window.api.openPath(d); } catch {} });
  $('#clearAllBtn').addEventListener('click', async () => {
    if (await askPrompt('Smazat konverzace', 'Napiš ANO pro potvrzení', '') === 'ANO') {
      conversations = []; activeConvoId = null; saveConvos();
      localStorage.removeItem('nlc_active'); renderChatList(); renderMessages();
      $('#prefsModal').classList.remove('open');
    }
  });
  // about
  $('#settingsBtn').addEventListener('click', () => $('#settingsModal').classList.add('open'));
  $('#closeModal').addEventListener('click', () => $('#settingsModal').classList.remove('open'));
  $('#modalBackdrop').addEventListener('click', () => $('#settingsModal').classList.remove('open'));
  $('#saveSettings').addEventListener('click', () => $('#settingsModal').classList.remove('open'));
  autoGrow();
});

/* ---------- proxy pool UI odstraněno ----------
   Rotace proxy při přetížení běží potichu v main procesu. Uživatel nikdy
   nevidí nic o quotě, limitech ani proxy — proto tu není žádný badge,
   žádný listener ani žádné hlášky. (window.api.proxyStatus/proxyRefresh
   v preloadu zůstávají pro interní potřeby main procesu.) */
