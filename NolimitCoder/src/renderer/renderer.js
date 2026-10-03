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
// Staré uložené modely (longcat…) už nejsou v bráně dostupné → vždy začni aktuálním.
const SAVED_MODEL = localStorage.getItem('nlc_model');
// Staré uložené volby modelu už brána nemá — padnou na aktuální free model.
const MODEL_DEFAULT = 'free/mimo-v2.6-flash-free';
let selectedModel = (SAVED_MODEL && !/longcat|space[-_]?bunny/i.test(SAVED_MODEL)) ? SAVED_MODEL : MODEL_DEFAULT;
let searchQuery = '';
let conversations = [];
try { conversations = JSON.parse(localStorage.getItem('nlc_convos') || '[]'); if (!Array.isArray(conversations)) conversations = []; } catch { conversations = []; }
// legacy data without a project → null (global), so they do not mix with project ones
for (const c of conversations) { if (!c || c.projectPath === undefined) c.projectPath = null; }
let activeConvoId = localStorage.getItem('nlc_active') || null;
// Per-chat streaming state — každý chat může generovat nezávisle na ostatních.
// Klíč = conversation ID, hodnota = { stopRequested: boolean }
const streamingChats = new Map();
// Globální stop flag pro aktuálně aktivní chat (používá se v runAgent smyčce)
let stopRequested = false;
let prefs = { activeProject: null, terminal: 'auto', shellBackend: 'auto', sound: true, googleSearch: true,
  logErrors: true };
let projectRegistry = [];
try { projectRegistry = JSON.parse(localStorage.getItem('nlc_projects') || '[]'); } catch { projectRegistry = []; }
// Plná automatika, trvale. Žádné schvalování příkazů, nic se neptá.
let autoShell = true;
function shellNeedsApproval() { return false; }
const approvedOnce = new Set(); // commands approved with the Continue button — repeats no longer ask
const autoInstalled = new Set(); // tools auto-installed in this session
const HEAVY_IDS = new Set(['msvc', 'docker', 'android', 'unity', 'unreal']); // GB toolchains — only with consent
const UNIVERSAL_SET = ['node', 'python', 'git', 'gcc', 'cmake', 'make', 'dotnet', 'java', 'go', 'rust', 'bun', 'deno'];
let envData = null; // last environment scan
let envBusy = false; // scan/install in progress
let lastUserRequest = ''; // last user input (for detecting needed tools)
let pendingQueue = [];

// Tokenová rezerva. Předtím byl default 4096 = jediný write_file se často usekl napůl
// a do souboru šla polovina kódu. Vyšší limit = méně vynechaných kusů.
// Slider Fast/Medium/High je pryč — tokenový limit je pevný, maximální.
// max_tokens = MAXIMUM, KTERÉ MODEL VYDŽÍ. Změřeno přímo proti bráně:
//   524 288 (2^19) -> HTTP 200
//   530 000       -> HTTP 400  (a 1 000 000 taky)
// Brána cokoliv nad to odmítí celý požadavek, takže tady posíláme přesně strop.
// Stejnou hodnotu používá přístupce tokenů jako jmenovatel pruhu.
const MAX_TOKENS = 524288;
const SEND_MAX_TOKENS = 524288;
// Model má kontextové okno ~1M tokenů. Dřív se posílalo jen 30 zpráv a výsledky
// nástrojů se ořezávaly na 2000 znaků — okno se využívalo na ~2 %. Teď:
//   HIST_MESSAGES     kolik posledních zpráv se pošle
//   PROMPT_CHAR_BUDGET bezpečný rozpočet promptu ve znacích (~4 znaky/token)
//   TOOL_RESULT_CHARS  kolik znaků jednoho výsledku nástroje se pošle modelu
const HIST_MESSAGES = 400;
const PROMPT_CHAR_BUDGET = 2400000;   // ~600k tokenů, s rezervou do 1M
const TOOL_RESULT_CHARS = 24000;
//   TOOLS_IN_CONTEXT   kolik posledních výsledků nástrojů jde do kontextu
const TOOLS_IN_CONTEXT = 40;

/* ---------- Nástroje, mezi které se vybírá ---------- */
const ALL_TOOLS = [
  'shell', 'read', 'read_file', 'write_file', 'append_file', 'edit_file', 'list_dir',
  'glob_file', 'create_dir', 'move_file', 'copy_file', 'delete_file', 'file_info',
  'search_files', 'open_path', 'close_app', 'show_panel', 'web_fetch', 'web_search',
  'download_file', 'env_scan', 'env_prepare', 'env_install', 'scaffold_electron',
  'build_exe', 'question'
];
const READ_TOOLS = [
  'read', 'read_file', 'list_dir', 'glob_file', 'file_info', 'search_files',
  'web_fetch', 'web_search', 'env_scan', 'question', 'show_panel', 'close_app'
];
/* ---------- Build mode: question vs. task ----------
   Build ALWAYS first recognizes what the user wants (detectIntent), and then
   either just answers with text (question/chit-chat — read tools allowed), or works
   with tools (task — writes, terminal, build). See detection rules in detectIntent below:
   interrogative form wins over the infinitive, a direct command is always a task. Unclear = question.
   DVOJJAZYČNĚ (CS + EN): uživatel píše česky, ale slovník akcí byl jen anglický —
   české "udělej"/"vytvoř" padalo do chatu, takže model neměl ani jeden zapisovací nástroj. */
const ACT_WORDS = /(\bmake|\bcreate|\bbuild|\bwrite|\bfix|\brepair|\badd|\bupdate|\bchange|\bremove|\bdelete|\brefactor|\bimplement|\bgenerate|\binstall|\bset up|\buninstall|\bcompile|\brebuild|\bprogram|\brewrite|\bextend|\bfinish|\bcomplete|\brun|\blaunch|\bdeploy|\brename|\bmove|\bcopy|\bdownload|\btest|\bscaffold|\bconvert|\boptimi[sz]e|\btranslate|\bformat|\brename|\bi want you to|\bi need|\bi would like|udělej|udelej|udělat|udelat|vytvoř|vytvor|vytvořit|vytvorit|naprogramuj|naprogramuj|napiš|napis|napsat|napíš|oprav|opravit|přidej|pridej|přidat|pridat|smazat|smaz|uprav|upravit|změň|zmen|změnit|zmenit|přepis|přepiš|prepis|prepiš|dodělej|dodelej|dokonči|dokonci|vygeneruj|vygeneruj|spusť|spust|spustit|nainstaluj|nainstal|stáhni|stahni|stažení|stazeni|přelož|preloz|překlop|preklop|vyhledej|vyhledat|implementuj|refaktoruj|oprav mi|udělej mi|vytvoř mi|napiš mi)/i;
const ASK_WORDS = /^(how|what|why|where|when|who|which|whose|whom|how many|how much|whether|explain|describe|tell me|do you know|can you explain|could you explain|is there|are there|should i|would you)\b/i;
const ASK_WORDS_CS = /^(jak|co|proč|proc|kde|kdy|kdo|kolik|čí|či|jestli|vysvětli|vysvetli|řekni|rekni|popiš|popis|poradíš|poradis|jaký|jakou|jaky|jakou|smí|smi|můžeš|muzes|dokážeš|dokazes|který|ktery|kdovolákterý)\b/i;
const ASK_MID_CS = /\b(jak|vysvětli|vysvetli|řekni|rekni|popiš|popis|poraď|porad|co znamená|co znamena|co je to|co je|jak se|jaký je|jaky je)\b/i;
/* Stížnost / pokračování práce. Krátká věta bez otazníku ("bro je to furt stejný",
   "zase to nefunguje") je v praxi příkaz pokračovat, ne otázka. Bez tohoto se
   taková zpráva vyhodnotí jako `chat` → agent dostane jen čtecí nástroje →
   nemá write_file → zapisuje soubory přes shell heredoc → parser error. */
const CONTINUE_WORDS = /(\bfurt\b|\bfurtě\b|\bzase\b|\bpořád\b|\bporad\b|\bstále\b|\bstable\b|\bagain\b|\bsame\b|\bsame as\b|\bstejně\b|\bstejne\b|\bdál\b|\bdal\b|\bpokračuj|pokracuj|\bcontinue\b|\bfinish\b|\bdokonči|dokonci|\bnefunguje\b|\bnefunguj\b|\bnejde\b|\bnepišu\b|\bnepíše\b|\bnesmazal\b|\bneslo\b|\bmálo\b|\bnedokonč|nedokonc|\boprav\b|\bopravit\b|\bzmeni\b|\bzměň\b|\bpřepiš\b|\bprepis\b|\bpřepisuj|budu|budu to|\boprav mi\b|\bsa to\b|\bsa mi\b|\bsa mi chce\b|\bplease fix\b|\bfix it\b|\btry again\b|\bsame thing\b|\bstuck\b|\bvisí\b|\bvisi\b|\bnejede\b|\bspadne\b|\bcrash)/i;
const WRITEISH_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'create_dir', 'move_file',
  'copy_file', 'delete_file', 'shell', 'env_install', 'env_prepare', 'scaffold_electron', 'download_file']);
/* Direktivy proti "model jen čte a nikdy nezapíše". Slabý modely (free tier) se zaseknou
   v průzkumu kódu a nikdy nepřejdou k zápisu. Místo toho, abychom to zabili po 4. kole
   a ukázali "Nedokončeno", do toho jdeme — postupně posíláme direktivy a teprve když
   ani ta nejtvrdší nepomůže, skončíme. */
const WRITE_DIRECTIVE_1 = '[Dost čtení. Už víš, jak kód vypadá. Teď HNED zavolej write_file nebo edit_file a udělej změnu. Žádné další read_file / list_dir / glob_file / search_files — pokud něco potřebuješ vědět, vzpomeň si na to, co jsi už přečetl.]';
const WRITE_DIRECTIVE_2 = '[STOP. Přestaň číst. Máš všechno, co potřebuješ. Zavolej write_file nebo edit_file HNED, v tomto kole. Pokud zavoláš read_file, list_dir, glob_file nebo search_files ještě jednou, úloha selže a budeš muset začít znovu. Napiš soubor.]';
/* Už se v této konverzaci pracovalo (zápis/spuštění něčeho)? Pak je to běh pokračující
   práce, ne dotaz — read-only sada nástrojů by ho jen uvěznila. */
function convoDidWork(convo) {
  const ms = (convo && convo.messages) || [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m && m.role === 'tool' && !m.skipped && WRITEISH_TOOLS.has(String(m.tool || ''))) return true;
  }
  return false;
}
function detectIntent(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'chat';
  // Stížnost na průběh práce = pokračovat, ne ptát se (viz CONTINUE_WORDS).
  if (CONTINUE_WORDS.test(t)) return 'build';
  const noFill = t.replace(/^(hi|hello|hey|yo|good morning|good afternoon|good evening|please|well|so|ok|okay|ahoj|čau|cau|zdar|dobrý den|dobry den|prosím|prosim|tak|hele|bro)\b[\s,]+/i, '').trim() || t;
  // Tázací začátek → otázka, ledaže je v ní i výslovný rozkaz ("jak opravit X?" = úkol).
  if (ASK_WORDS.test(noFill) || ASK_WORDS_CS.test(noFill)) {
    if (ACT_WORDS.test(t)) return 'build';
    return 'chat';
  }
  if (ACT_WORDS.test(t)) return 'build';
  if (/```|Traceback|SyntaxError|TypeError|ReferenceError|\berror TS\d+|^\s*at\s+\S+\s*\(|\b[A-Za-z-]+\.(js|ts|tsx|py|java|cs|cpp|c|go|rs|php|rb):\d+/im.test(t) && !/\?/.test(t)) return 'build';
  // Česká otázka uprostřed věty ("jak udělat X") bez rozkazu → otázka.
  if (/\?/.test(t) && !ACT_WORDS.test(t) && ASK_MID_CS.test(t)) return 'chat';
  if (/\?/.test(t) && t.length < 40) return 'chat';
  // Delší popis bez otazníku = zadání, ne pokec.
  if (t.length > 40) return 'build';
  return 'chat';
}
/* Commercial video: popis reklamy je VŽDY úkol (i bez rozkazovacích sloves) — model nesmí
   skončit u otázek, musí rovnou stavět. Pokecem zůstane jen pozdrav a skutečná otázka.
   Dvojjazyčně (EN + CS): uživatel často píše česky. */
function detectCommercialIntent(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'chat';
  // otazník: úkol jen když žádá akci, jinak otázka
  if (/\?/.test(t)) {
    if (/(make|create|build|fix|add|generate|change|rewrite|finish|complete|prepare|udělej|udelej|udělat|udelat|vytvoř|vytvor|vytvořit|vytvorit|přidej|pridej|přidat|pridat|oprav|opravit|změň|zmen|změnit|zmenit|napiš|napis|napsat|dodělej|dodelej|dodělat|dodelat)/i.test(t)) return 'build';
    return 'chat';
  }
  // holý pozdrav / díky → pokec
  if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay|ahoj|čau|cau|zdar|čus|cus|dobrý den|dobry den|díky|diky|děkuji|dekuji|good (morning|afternoon|evening))\b[\s!.,]*$/i.test(t)) return 'chat';
  // tázací začátek → otázka
  const noHi = t.replace(/^(hi|hello|hey|yo|ahoj|čau|cau|zdar|please|prosím|prosim|well|so|ok|okay|tak|no|hele)\b[\s,]+/i, '').trim() || t;
  if (/^(how|what|why|where|when|who|which|whose|whom|how many|how much|whether|explain|describe|tell me|do you know|jak|co|proč|proc|kde|kdy|kdo|kolik|čí|či|jestli|vysvětli|vysvetli|řekni|rekni|popiš|popis|poradíš|poradis)\b/i.test(noHi)) return 'chat';
  // zadání videa → vždy úkol: video klíčová slova, rozlišení/poměr, délka, akční slovesa, delší popis
  if (/(video|\bad\b|advert|commercial|animat|intro|outro|subscribe|\blike\b|bell|logo|youtube|tiktok|reels|shorts|vertical|square|full[\s-]?hd|\bhd\b|\b4k\b|resolution|\d{3,4}\s*x\s*\d{3,4}|\b(16:9|9:16|1:1|4:3)\b|\b\d+\s*(s|sec|seconds?|min|minutes?)\b|reklam|animac|vide|odběr|odber|vertikál|vertikal|čtverec|ctverec|rozlišen|rozlisen|délk|delk|sekund|vteřin|minut)/i.test(t)) return 'build';
  if (/(make|create|build|write|fix|repair|add|update|change|remove|delete|refactor|implement|generate|install|run|rename|move|copy|download|test|scaffold|udělej|udelej|vytvoř|vytvor|naprogramuj|napiš|napis|uprav|změň|zmen|přidej|pridej|oprav|dodělej|dodelej|vygeneruj|spusť|spust)/i.test(t)) return 'build';
  if (t.length > 40) return 'build'; // delší popis = zadání, ne pokec
  return detectIntent(t); // zbytek podle obecných pravidel
}

/* ---------- Error Log: všechny chyby jdou do Logs/errors-AAAA-MM-DD.txt ----------
   Zachytí i chyby, o kterých se nikdo nedozví — nevyzchaná výjimka v UI,
   selhaný nástroj, chyba spojení s AI. Uživatel si ji pak otevře v
   Settings → Error Log. */
function errLog(tag, error, detail) {
  try { if (window.api && window.api.logError) window.api.logError(tag, String(error || ''), detail); } catch {}
}
window.addEventListener('error', (e) => {
  errLog('renderer/error', (e && e.message) || 'error', {
    source: (e && e.filename || '') + ':' + (e && e.lineno || 0) + ':' + (e && e.colno || 0),
    stack: (e && e.error && e.error.stack) || ''
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  errLog('renderer/rejection', (r && (r.message || r)) || 'unhandled rejection', { stack: (r && r.stack) || '' });
});

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
  const t = scrubName(String(s || ''));
  if (/quota|kv[oó]t|rate[\s_-]*limit|free[\s_-]*usage|429|proxy|too many|capacity|overloaded|try again later|usage[\s_-]*exceeded|limit[\s_-]*exceeded/i.test(t))
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
// Název modelu se nesmí nikde propasnout v raw podobě — ani když je id staré,
// neznámé nebo přišlo z uložených prefů. Tady se čistí i to, co modelLabel vrátí
// jako fallback (dřív to padalo na surové "mimo-v2.6-flash-free").
// POZOR: nepatternovat holé /mimo/ — český text v UI obsahuje "mimo".
function scrubName(s) {
  return String(s == null ? '' : s)
    .replace(/mimo[-\s]*v?2\.6[-\s]*flash(?:[-\s]*free)?/gi, 'NolimitCoder Pro')
    .replace(/\bmimo[-\s]+(?:v?2\.6[-\s]*)?(?:flash|pro|mini|turbo)\b/gi, 'NolimitCoder Pro');
}
function modelLabel(id) {
  const m = getModels().find(x => x.id === id);
  return scrubName(m ? m.label : String(id || '').split('/').pop());
}
function zenIdOf(id) { const m = getModels().find(x => x.id === id); return (m && m.zenId) || String(id || '').split('/').pop(); }
// Pri vycerpane kvote (429) se zkusi druhy model. Jen mezi temito dvema.
const MODEL_FALLBACK = { 'free/mimo-v2.6-flash-free': 'free/mimo-v2.6-flash-free' };
function activeProject() { return prefs.activeProject || null; }
function activeConvo() { return conversations.find(c => c.id === activeConvoId) || null; }
// Chaty patří projektu: shoda musí platit oběma směry (projekt A nevidí chaty projektu B ani globální a naopak).
// Porovnávání jako původně — doslova. (normPath je tu jen pro okénko
// přístupu a indikátor složky, aby se cesty nerůznily v UI.)
function normPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/[\\/]+$/, '');
  if (!s) return '';
  return s.replace(/\//g, '\\').toLowerCase();
}
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
  el.activityBar = $('#activityBar');
  el.planBox = $('#planBox');
  el.envSummary = $('#envSummary'); el.envList = $('#envList');
  el.envScanBtn = $('#envScanBtn'); el.envFixAllBtn = $('#envFixAllBtn'); el.envHeavyCheck = $('#envHeavyCheck');
}

/* ---------- model picker ---------- */
// Odznaky: kvalita (kategorie modelu) a rychlost (odhad podle kategorie).
const QUALITY_TAG = { FLASH: 'High', PRO: 'High', ULTRA: 'High', BALANCED: 'Medium', STANDARD: 'Medium', THINK: 'Thinking', REASONING: 'Thinking', LITE: 'Low', MINIMAL: 'Low', FAST: 'Low' };
const SPEED_TAG = { FLASH: ['fast', 'Fast'], PRO: ['fast', 'Fast'], ULTRA: ['med', 'Fast'], BALANCED: ['fast', 'Fast'], STANDARD: ['med', 'Fast'], THINK: ['med', 'Fast'], REASONING: ['med', 'Fast'], LITE: ['fast', 'Fast'], MINIMAL: ['fast', 'Fast'], FAST: ['fast', 'Fast'] };
function modelTags(m) {
  const cat = String(m.category || 'FLASH').toUpperCase();
  const q = QUALITY_TAG[cat] || 'Medium';
  const sp = SPEED_TAG[cat] || ['med', 'Fast'];
  let out = '';
  if (m.context) out += '<span class="mtag">' + escapeHtml(m.context) + '</span>';
  out += '<span class="mtag q">' + escapeHtml(q) + '</span>';
  out += '<span class="mtag s"><span class="mdot ' + sp[0] + '"></span>' + escapeHtml(sp[1]) + '</span>';
  return '<span class="mtags">' + out + '</span>';
}
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
      + '<div class="minfo"><div class="mname"><span>' + escapeHtml(m.label) + '</span>' + modelTags(m) + '</div>'
      + (m.desc || m.context ? '<div class="mdesc">' + escapeHtml(m.desc || '') + '</div>' : '')
      + '</div><span class="mcheck">✓</span></div>';
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
        // Jen modely, o kterých je víme, že reálně obsluží (ostatní vrací 403/500).
        return /^(mimo-v2\.6-flash-free)$/i.test(id);
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
function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ' min ' + (s % 60) + ' sec'; }
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
function videoResWH() { return VIDEO_RESOLUTIONS[videoRes] || VIDEO_RESOLUTIONS['1920x1080']; }

/* ---------- projekty ---------- */
function renderProjects() {
  const grid = $('#projectCards');
  if (!grid) return;
  grid.innerHTML = projectRegistry.map((p, i) =>
    '<div class="pv-card" data-i="' + i + '"><span class="folder-ico">📁</span>'
    + '<div class="pv-card-info"><div class="pv-card-name">' + escapeHtml(p.name) + '</div>'
    + '<div class="pv-card-path">' + escapeHtml(p.path) + '</div>'
    + '<span class="pv-type">' + escapeHtml(p.type === 'website' ? 'Website Studio' : (p.type === 'video' ? '🎬 Commercial Studio' : 'Coder Studio')) + '</span></div>'
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
/* Návrat na výběr projektů ze stavového řádku pod composerem */
function openProjects() {
  try { showView('projects'); setFooter('Vyber projekt'); } catch {}
}
async function openProject(p) {
  // Zastav generaci jen v aktivním chatu, ne globálně — ostatní chaty můžou dál generovat
  if (activeConvoId && streamingChats.has(activeConvoId)) {
    stopEverything('Přepnuto na jiný projekt', activeConvoId);
  }
  prefs.activeProject = p.path;
  try { await window.api.setStore({ activeProject: p.path }); } catch {}
  $('#projHeadName').textContent = p.name;
  showView('chat');
  setFolderLabel(p.path);
  renderChatList();
  let c = conversations.filter(projectMatch).slice(-1)[0];
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
/* STOP zastaví generaci v KONKRÉTNÍM chatu (stream, frontu zpráv i nahrávání MP4).
   Ostatní chaty můžou dál generovat — každý chat má svůj vlastní stav. */
function stopEverything(why, convoId) {
  const cid = convoId || activeConvoId;
  if (cid) {
    const st = streamingChats.get(cid);
    if (st) st.stopRequested = true;
  }
  if (cid === activeConvoId) {
    stopRequested = true;
    pendingQueue.length = 0; updateQueue();
    // Zastavíme jen stream tohoto chatu — ostatní chaty v pozadí jedou dál.
    try { window.api.chatStreamAbort({ convoId: cid }); } catch { try { window.api.chatStreamAbort(); } catch {} }
    try { window.api.videoAbort(); } catch {}
    videoExporting = false;
    setVideoProgress('');
    setActivity(null); hidePlanBox();
    setSendBusy(false);
    setFooter(why || 'Zastaveno');
  }
}
function newConvo(silent) {
  // Nový chat NESMÍ zastavovat generování v ostatních chatech — každý chat je nezávislý.
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
  el.chatList.innerHTML = list.map(c => {
    const isStreaming = streamingChats.has(c.id);
    const isActive = c.id === activeConvoId;
    return '<div class="chat-item ' + (isActive ? 'active' : '') + (isStreaming ? ' streaming' : '') + '" data-id="' + c.id + '">'
      + '<div class="chat-item-title">'
      + (isStreaming ? '<span class="chat-spinner"></span>' : '')
      + escapeHtml(c.title || 'Nová konverzace') + '</div>'
      + '<div class="chat-item-sub">' + (c.messages ? c.messages.length : 0) + ' zpráv' + (isStreaming ? ' · generuje…' : '') + '</div>'
      + '<button class="chat-rename" data-a="rename" title="Přejmenovat">✎</button>'
      + '<button class="chat-del" data-a="del" title="Smazat">✕</button></div>';
  }).join('') || '<div class="chat-list-empty">Zatím žádný chat — vytvoř nový.</div>';
  el.chatList.querySelectorAll('.chat-item').forEach(n => n.addEventListener('click', (e) => {
    const id = n.getAttribute('data-id');
    const a = e.target.getAttribute && e.target.getAttribute('data-a');
    if (a === 'del') {
      e.stopPropagation();
      // Zastav generaci v mazaném chatu, ale ne v ostatních
      const st = streamingChats.get(id);
      if (st) { st.stopRequested = true; streamingChats.delete(id); }
      if (id === activeConvoId) stopEverything('Smazáno', id);
      conversations = conversations.filter(c => c.id !== id);
      saveConvos();
      if (activeConvoId === id) {
        const rest = conversations.filter(projectMatch);
        activeConvoId = rest.length ? rest[rest.length - 1].id : null;
        stopRequested = false;
      }
      renderChatList(); renderMessages();
      return;
    }
    if (a === 'rename') { e.stopPropagation(); const c = conversations.find(x => x.id === id); askPrompt('Přejmenovat chat', 'Nový název', c.title).then(v => { if (v) { c.title = v; saveConvos(); renderChatList(); } }); return; }
    // Přepnutí chatu NESMÍ zastavit generaci v jiných chatech
    activeConvoId = id; localStorage.setItem('nlc_active', id);
    stopRequested = false; // Reset stop flag pro nový chat
    renderChatList(); renderMessages();
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
/* Plynulý posun dolů — jako v OpenCode: message se objeví a chat se sjede dolů
   plynule, ne skokem. `auto` = posun bez animace (překreslení celé historie),
   jinak smooth. Když uživatel odroloval výrazně nahoru, necháme ho tam být —
   jinak by mu stream šahal pod nos a nedal by se číst. */
let smoothScrollRaf = 0;
const SCROLL_STICK_PX = 140;   // jak blízko dna se ještě "držíme" streamu
function scrollBottomSmooth(behavior) {
  try {
    const c = el.chatContainer;
    if (!c) return;
    const mode = behavior || 'smooth';
    const nearBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < SCROLL_STICK_PX;
    if (!nearBottom && mode === 'auto') return;          // uživatel čte výš — netlač
    if (smoothScrollRaf) cancelAnimationFrame(smoothScrollRaf);
    smoothScrollRaf = requestAnimationFrame(() => {
      smoothScrollRaf = 0;
      const target = Math.max(0, c.scrollHeight - c.clientHeight);
      try { c.scrollTo({ top: target, behavior: mode }); }
      catch { c.scrollTop = target; }
    });
  } catch {}
}
/* Během streamu text roste chunk po chunku → držíme scroll dole, dokud uživatel
   neodroluje. Volá se po každém vykreslení, proto se neinvokuje přes RAF. */
function scrollStick() {
  try {
    const c = el.chatContainer;
    if (!c) return;
    if ((c.scrollHeight - c.scrollTop - c.clientHeight) >= SCROLL_STICK_PX) return;
    c.scrollTop = c.scrollHeight;
  } catch {}
}
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
  scrollBottomSmooth();
}
function hidePlanBox() { if (el.planBox) { el.planBox.style.display = 'none'; el.planBox.innerHTML = ''; } }
function addMsg(role, html, raw) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
  wrap.innerHTML = role === 'user'
    ? '<div class="bubble-user">' + escapeHtml(raw != null ? raw : html) + '</div>'
    : '<div class="bubble-assistant">' + html + '</div>';
  el.messages.appendChild(wrap); scrollBottomSmooth();
  return wrap;
}
/* ---------- Prázdný stav (OpenCode styl) ---------- */
let isEmptyState = null;
function setEmptyState(on) {
  if (isEmptyState === on) return;
  isEmptyState = !!on;
  const m = document.getElementById('mainCol');
  if (m) m.classList.toggle('is-empty', !!on);
  if (el.sessionTitle) el.sessionTitle.style.opacity = on ? '0.45' : '';
}
function renderEmptyState() {
  const proj = (prefs.activeProject || '').split(/[\\/]/).pop() || '';
  return '<div class="empty-mark">'
    + '<div class="empty-word">NolimitCoder</div>'
    + '<div class="empty-hint">Napiš, co chceš udělat. @ pro soubor v kontextu, / pro příkazy.<br>'
    + 'AI má shell, soubory, terminál, web i preview — a pustí se do toho.</div>'
    + '<div class="empty-sugg-inline">'
    + '<button data-s="Projdi projekt a řekni mi, co v něm je a s čím začít">Projdi projekt</button>'
    + '<button data-s="Vytvoř mi jednoduchou HTML stránku s tmavým designem">Nová HTML stránka</button>'
    + '<button data-s="Najdi chybu v tomhle kódu a oprav ji">Najdi a oprav chybu</button>'
    + '<button data-s="Připrav mi prostředí, ať je všechno co potřebuju nainstalované">Připravit prostředí</button>'
    + '</div></div>';
}
/* Stavový řádek pod composerem: projekt · git větev */
let metaBranchCache = { root: null, branch: '' };
async function updateComposerMeta() {
  const pn = document.getElementById('metaProjName');
  if (pn) pn.textContent = (prefs.activeProject || '').split(/[\\/]/).pop() || 'Bez projektu';
  const root = prefs.activeProject;
  const bn = document.getElementById('metaBranchName');
  if (!bn) return;
  if (metaBranchCache.root === root) { bn.textContent = metaBranchCache.branch || '—'; return; }
  metaBranchCache.root = root; bn.textContent = '…';
  let branch = '';
  try {
    const r = await window.api.toolsExec({ tool: 'shell', args: { command: 'git rev-parse --abbrev-ref HEAD 2>nul' }, root, fullAccess: true });
    const out = String((r && r.output) || '');
    const m = out.match(/(?:^|\n)([A-Za-z0-9._\-\/]+)(?:\r?\n|$)/);
    if (r && r.ok && m) branch = m[1];
  } catch {}
  metaBranchCache.branch = branch;
  bn.textContent = branch || (root ? 'bez git' : '—');
}
function bindComposerMeta() {
  const proj = document.getElementById('metaProj');
  if (proj) proj.addEventListener('click', () => { try { openProjects(); } catch {} });
  const br = document.getElementById('metaBranch');
  if (br) br.addEventListener('click', () => { try { window.api.toolsExec({ tool: 'shell', args: { command: 'git branch --show-current' }, root: prefs.activeProject, fullAccess: true }); } catch {} });
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
  /* Prázdný stav ve stylu OpenCode: velký bledý wordmark, plovoucí composer,
     stavový řádek (projekt / větev). Třída `.is-empty` na `.main`
     přesouvá composer do středu obrazovky; při první zprávě zmizí. */
  setEmptyState(!c.messages.length);
  if (!c.messages.length) {
    el.chatEmpty.innerHTML = renderEmptyState();
    el.chatEmpty.querySelectorAll('button[data-s]').forEach(b => b.addEventListener('click', () => {
      el.promptInput.value = b.getAttribute('data-s');
      autoGrow();
      sendMessage();
    }));
    updateComposerMeta();
    return;
  }
  for (const m of c.messages) {
    if (m.role === 'user' && m.internal) continue; // interní smyčka agenta — patří modelu, v chatu se neukazuje
    if (m.role === 'user') addMsg('user', '', m.content);
    else if (m.role === 'assistant') addMsg('assistant', (m.thinking ? thinkHtml(m.thinking, false) : '') + mdToHtml(sanitizeResponse(m.content || '')), null);
    else if (m.role === 'tool') renderToolCard(m.tool, m.args, m.result, m.ok, m.diff);
  }
  bindCopyButtons();
  bindThink(el.messages);
  updateComposerMeta();
  scrollBottomSmooth('auto');
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
    case 'build_exe': return 'Buildím EXE (inventura → rebuild → test)';
    case 'open_path': return 'Otvírám ' + (baseName(args.path) || '');
    case 'show_panel': return 'Otvírám v panelu ' + (baseName(args.path) || args.path || '');
    case 'close_app': return 'Zavírám ' + (baseName(args.target) || args.target || 'aplikaci');
    default: return name;
  }
}
/* ---------- Thinking: viditelné přemýšlení modelu ----------
   Model posílá delta.reasoning_content. Kreslí se živě, uživatel vidí
   nad čím model právě přemýšlí. Sbalitelné, během streamu otevřené. */
let thinkState = { box: null, body: null, seen: '' };
function thinkHtml(txt, live) {
  return '<div class="think-box' + (live ? ' live open' : '') + '" data-think>'
    + '<div class="think-head"><img class="think-logo" src="./assets/logo.png" alt=""><span class="think-caret"></span><span>Thinking</span></div>'
    + '<div class="think-body">' + escapeHtml(txt) + '</div></div>';
}
function bindThink(root) {
  const heads = (root || document).querySelectorAll('[data-think] > .think-head');
  heads.forEach(h => {
    if (h.dataset.thinkBound) return;
    h.dataset.thinkBound = '1';
    h.addEventListener('click', () => {
      const box = h.parentElement;
      if (box) box.classList.toggle('open');
    });
  });
}
// Živá aktualizace během streamu (pouze přírůstky, ne celý innerHTML pokaždé)
function updateThink(bubble, txt, live) {
  if (!bubble) return;
  const t = String(txt || '').trim();
  if (!t) return;
  if (!thinkState.box || !thinkState.box.isConnected || !bubble.contains(thinkState.box)) {
    bubble.querySelectorAll('[data-think]').forEach(n => n.remove());
    const box = document.createElement('div');
    box.innerHTML = thinkHtml(t, live);
    const el2 = box.firstElementChild;
    bubble.insertBefore(el2, bubble.firstChild);
    thinkState = { box: el2, body: el2.querySelector('.think-body'), seen: t };
    return;
  }
  if (t.length > thinkState.seen.length) {
    thinkState.body.textContent = t;
    thinkState.seen = t;
    thinkState.body.scrollTop = thinkState.body.scrollHeight;
    scrollStickSafe();   // myšlení také roste dolů → chat musí jet s ním
  }
}
function resetThink() { thinkState = { box: null, body: null, seen: '' }; }

function renderToolCard(name, args, result, ok, diff, cached) {
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  const short = String((args && (args.path || args.dir || args.target || args.command || args.pattern || args.url || args.query || args.id || args.name || (args.ids && args.ids.join(', ')) || args.request)) || '').slice(0, 90);
  // Rámeček jako Thinking: logo + hlavička, tělo SBALENÉ (jinak je chat 3x vyšší).
  // Klik na hlavičku rozbalí výsledek.
  let inner = '<div class="think-box tool" data-think>'
    + '<div class="think-head"><img class="think-logo" src="./assets/logo.png" alt="">'
    + '<span class="t-name">' + escapeHtml(name) + '</span>'
    + '<span class="t-path">' + escapeHtml(short) + '</span>'
    + '<span class="t-chip ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓' : '✕') + '</span></div>'
    + '<div class="think-body">';
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
  if (body) inner += escapeHtml(body);
  inner += '</div></div>';
  wrap.innerHTML = inner;
  el.messages.appendChild(wrap);
  bindThink(wrap);
  scrollBottomSmooth();
  return wrap;
}
/* Text odpovědi přibývá po kouscích — držíme scroll dole, aby text nejel pod okraj.
   Volá se po každém chunku, proto bez animace (jinak by se to trhalo). */
function scrollStickSafe() { try { scrollStick(); } catch {} }
/* ---------- Obrázky v chatu: Ctrl+V, výběr souboru, AI je vidí ----------
   Obrázek se uloží do <projekt>/uploads/ a do zprávy se přidá jako @odkaz.
   Prompt modelu říká, že soubor existuje a má ho otevřít/ukázat v panelu. */
let chatImages = []; // [{ rel, abs, name, dataUrl }]
function renderAttachStrip() {
  const strip = $('#attachStrip');
  if (!strip) return;
  if (!chatImages.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
  strip.style.display = '';
  strip.innerHTML = '';
  chatImages.forEach((im, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const img = document.createElement('img');
    img.src = im.dataUrl; img.alt = im.name;
    const x = document.createElement('button');
    x.className = 'attach-x'; x.textContent = '✕'; x.title = 'Odebrat';
    x.addEventListener('click', () => { chatImages.splice(i, 1); renderAttachStrip(); });
    chip.appendChild(img); chip.appendChild(x);
    strip.appendChild(chip);
  });
}
async function addImageFiles(files) {
  const list = Array.from(files || []).filter(f => /^image\//.test(f.type || ''));
  if (!list.length) return;
  // Bez otevřeného projektu použijeme pracovní složku (AI si ji založí).
  const root = prefs.activeProject || (await autoWorkspace({ messages: [] })) || '';
  if (!prefs.activeProject && root) { prefs.activeProject = root; try { await window.api.setStore({ activeProject: root }); } catch {} }
  if (!root) { setFooter('Nepodařilo se zjistit složku pro obrázek.'); return; }
  for (const f of list.slice(0, 4)) {
    try {
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('čtení souboru'));
        fr.readAsDataURL(f);
      });
      const ext = (String(f.name || '').match(/\.([a-z0-9]+)$/i) || [, 'png'])[1];
      const r = await window.api.saveImage({ data: b64, ext, root });
      if (r && r.ok) {
        chatImages.push({ rel: r.rel, abs: r.abs, name: f.name || 'obrazek', dataUrl: b64 });
      } else if (r && r.error) { setFooter('Obrázek se nepodařilo uložit: ' + r.error); }
    } catch (e) { errLog('attach', e && e.message); }
  }
  renderAttachStrip();
  setFooter(chatImages.length ? 'Přiloženo ' + chatImages.length + ' obrázků — AI je uvidí.' : '');
}
// Odkazy na obrázky, které se přidají do zprávy modelu.
function imageContext() {
  if (!chatImages.length) return '';
  return chatImages.map(im => '[Obrázek od uživatele: ' + im.rel + ']').join('\n') + '\n'
    + 'Uživatel ti poslal obrázek/výběr. Zobraz ho uživateli v bočním panelu přes show_panel {"path": "'
    + chatImages[0].rel + '"} a při práci s ním ho použij.';
}

/* ---------- Přístup mimo složku + indikátor cesty ----------
   Když AI píše/čte mimo aktivní projekt, nad chatem smooth vyskočí okénko:
   Povolit / Povolit vždy / Ne. "Vždy" = AI smí hledat a psát v celém počítači. */
let askAlways = false; // uživatel povolil všechny složky natrvalo
let askInFlight = false;
function outsideProject(p) {
  const target = normPath(p);
  const proj = normPath(prefs.activeProject);
  if (!target) return null;
  if (!proj) return target;              // žádný projekt = vše mimo
  if (target === proj) return null;
  if (target.startsWith(proj + '\\')) return null; // podsložka projektu = OK
  return target;
}
function askAccess(path) {
  if (askInFlight) return Promise.resolve('always');
  askInFlight = true;
  return new Promise((resolve) => {
    const pop = $('#accessPop'), lbl = $('#accessPath');
    if (!pop) { askInFlight = false; resolve('no'); return; }
    lbl.textContent = path;
    pop.classList.add('show');
    const close = (r) => {
      pop.classList.remove('show');
      askInFlight = false;
      resolve(r);
    };
    $('#accessYes').onclick = () => close('once');
    $('#accessAlways').onclick = () => { askAlways = true; close('always'); };
    $('#accessNo').onclick = () => close('no');
  });
}
/* Cílová složka, kam se píše — z panelu/projektu nebo z absolutní cesty v nástroji. */
function activeFolder() { return prefs.activeProject || ''; }
function setFolderLabel(p) {
  const n = $('#folderName');
  if (!n) return;
  const f = p || activeFolder();
  n.textContent = f ? baseName(f) : '(žádná složka)';
  const pill = $('#folderPill');
  if (pill) pill.title = f ? ('AI píše do: ' + f + '\nKlikni pro změnu složky') : 'Vyber složku, kam má AI psát';
}
function changeFolder() {
  // Klasický systémový dialog jako v Exploreru (Tento počítač, všechny disky).
  Promise.resolve(window.api.projectPick()).then((r) => {
    const v = r && r.ok ? r.path : null;
    if (!v) return;
    prefs.activeProject = v;
    try { window.api.setStore({ activeProject: v }); } catch {}
    setFolderLabel(v);
    const ex = (projectRegistry || []).find(p => normPath(p.path) === normPath(v));
    if (!ex) { projectRegistry.push({ name: baseName(v) || 'Projekt', path: v, type: 'universal', framework: 'html' }); saveRegistry(); renderProjects(); }
    setFooter('AI teď píše do: ' + v);
  }).catch(() => {});
}

/* ---------- Stav odesílacího tlačítka ----------
   Za běhu se ↑ přemění na animovaný "generating" (tři body + kroužek).
   Kliknutím v tomto stavu se zpráva připíše do fronty (max 5). */
function setSendBusy(busy) {
  const b = el.sendBtn;
  if (!b) return;
  if (busy) {
    if (!b.dataset.busy) { b.dataset.busy = '1'; b.dataset.label = b.textContent; }
    b.classList.add('generating');
    b.innerHTML = '<span class="gen-dots"><i></i><i></i><i></i></span>';
    b.title = 'Generuje… kliknutím přidáš další úkol do fronty';
  } else {
    b.classList.remove('generating');
    if (b.dataset.busy) { b.textContent = b.dataset.label || '↑'; delete b.dataset.busy; }
    b.title = 'Send';
  }
}

/* ---------- Počítadlo tokenů: plní se během generování ----------
   Reálná čísla z brány (j.usage), ne odhad. Ukazuje prompt / vygenerované
   a pruh se plní k maximu, které má tenhle běh nastavené. */
let tokState = { in: 0, out: 0, max: 0 };
function fmtTok(n) {
  n = Math.max(0, parseInt(n) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}
function updateTokenMeter(usage, st) {
  const bar = $('#tokenBar'), lbl = $('#tokenLabel');
  if (!bar || !lbl) return;
  if (usage) {
    tokState.in = usage.prompt || tokState.in;
    tokState.out = usage.completion || tokState.out;
  }
  if (st) tokState.out = Math.max(tokState.out, Math.round(String(st.text || '').length / 3.4) + Math.round(String(st.reasoning || '').length / 3.4));
  const lim = tokState.max || MAX_TOKENS;
  tokState.max = lim;
  const pct = Math.max(0, Math.min(100, Math.round((tokState.out / lim) * 100)));
  bar.style.width = pct + '%';
  bar.classList.toggle('near', pct > 80);
  lbl.textContent = fmtTok(tokState.out) + ' / ' + fmtTok(lim);
  lbl.title = 'Vygenerováno ' + tokState.out + ' z limitu ' + lim + ' tokenů'
    + (tokState.in ? ' · prompt ' + tokState.in + ' tokenů' : '');
}
function resetTokenMeter() { tokState = { in: 0, out: 0, max: MAX_TOKENS }; updateTokenMeter(null, null); }

/* ---------- Výsuvný panel vpravo ----------
   Tlačítko "Panel" vpravo nahoře ho smooth vysune přes půlku chatu. AI do něj otevírá
   výsledky přes show_panel: HTML/obrázky přes preview server, exe jako kartu
   s ovládáním (exečko se do stránky vložit nedá — je to nativní okno). */
function toggleSidePanel(force) {
  const p = $('#sidePanel');
  if (!p) return;
  const open = force !== undefined ? !!force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  const t = $('#panelToggle');
  if (t) t.classList.toggle('active', open);
  // Chat se zmenší spolu s panelem (stejná šířka i animace).
  try { const m = document.querySelector('.main'); if (m) m.classList.toggle('panel-open', open); } catch {}
}
/* Záložky panelu: každé show_panel = nová karta (max 10), každá drží svůj obsah. */
let sideTabs = [];
let sideActive = null;
let sideTabSeq = 0;
const SP_EMPTY = '<div class="sp-empty">AI sem otevře výsledky — HTML náhled, spuštěný program, obrázek…<br>Tlačítkem Panel ho schováš.</div>';
function renderSideTabs() {
  const bar = $('#sidePanelTabs');
  if (!bar) return;
  if (!sideTabs.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '';
  sideTabs.forEach(t => {
    const s = document.createElement('span');
    s.className = 'sp-tab' + (t.id === sideActive ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = t.title;
    const x = document.createElement('b');
    x.textContent = '✕'; x.className = 'sp-tab-x'; x.title = 'Zavřít kartu';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeSideTab(t.id); });
    s.appendChild(label); s.appendChild(x);
    s.addEventListener('click', () => activateSideTab(t.id));
    bar.appendChild(s);
  });
}
function activateSideTab(id) {
  const t = sideTabs.find(x => x.id === id);
  if (!t) return;
  sideActive = id;
  sidePanelTitle(t.title);
  renderSideTabs();
  renderSideTab(t);
}
function closeSideTab(id) {
  sideTabs = sideTabs.filter(x => x.id !== id);
  if (sideActive === id) sideActive = sideTabs.length ? sideTabs[sideTabs.length - 1].id : null;
  const t = sideTabs.find(x => x.id === sideActive);
  renderSideTabs();
  if (t) { sidePanelTitle(t.title); renderSideTab(t); }
  else {
    sidePanelTitle('Panel');
    const body = $('#sidePanelBody');
    if (body) body.innerHTML = SP_EMPTY;
  }
}
function sidePanelTitle(s) { const n = $('#sidePanelTitle'); if (n) n.textContent = String(s || 'Panel').slice(0, 60); }
function panelAbs(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s)) return s;
  return prefs.activeProject ? prefs.activeProject.replace(/[\\/]+$/, '') + '\\' + s : s;
}
async function openSidePanelFor(rawPath, mode) {
  const abs = panelAbs(rawPath);
  if (!abs) return;
  const low = abs.toLowerCase();
  const kind = /\.exe$/i.test(low) ? 'run' : (/\.(html?|png|jpe?g|gif|webp|svg|ico)$/i.test(low) ? 'web' : 'text');
  const tab = { id: ++sideTabSeq, title: baseName(abs), kind, abs, mode, launched: false };
  sideTabs.push(tab);
  if (sideTabs.length > 10) sideTabs.shift();
  sideActive = tab.id;
  sidePanelTitle(tab.title);
  toggleSidePanel(true);
  renderSideTabs();
  await renderSideTab(tab);
}
async function renderSideTab(tab) {
  const body = $('#sidePanelBody');
  if (!body || !tab) return;
  const set = (h) => { body.innerHTML = h; };
  const abs = tab.abs, low = abs.toLowerCase();
  if (tab.kind === 'run') { renderRunCard(body, abs, tab.mode === 'run' && !tab.launched); tab.launched = true; return; }
  if (tab.kind === 'web') {
    set('<div class="sp-empty">Načítám…</div>');
    try {
      const cut = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
      const root = cut > 0 ? abs.slice(0, cut) : abs;
      const r = await window.api.previewStart(root);
      if (r && r.ok && r.url) {
        const url = r.url.replace(/\/$/, '') + abs.slice(root.length).replace(/\\/g, '/');
        if (/\.html?$/i.test(low)) set('<iframe class="sp-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" title="preview" src="' + escapeHtml(url) + '"></iframe>');
        else set('<img class="sp-img" src="' + escapeHtml(url) + '" alt="">');
        return;
      }
    } catch (e) { errLog('panel/preview', e && e.message); }
    try { await window.api.toolsExec({ tool: 'open_path', args: { path: abs }, root: prefs.activeProject, fullAccess: true }); } catch {}
    set('<div class="sp-empty">Náhled se nepovedl — otevřeno v systému.</div>');
    return;
  }
  try {
    const r = await window.api.toolsExec({ tool: 'read_file', args: { path: abs }, root: prefs.activeProject, fullAccess: true });
    const txt = String((r && r.output) || '').slice(0, 20000);
    set('<pre class="sp-code">' + escapeHtml(txt || '(prázdný soubor)') + '</pre>');
  } catch { set('<div class="sp-empty">Soubor se nepovedlo načíst.</div>'); }
}
async function renderRunCard(body, abs, autoLaunch) {
  const name = baseName(abs);
  const short = name.replace(/\.exe$/i, '');
  body.innerHTML = '<div class="sp-run"><div class="sp-run-name">' + escapeHtml(name) + '</div>'
    + '<div class="sp-run-status" data-st>Stav: zjišťuji…</div>'
    + '<div class="sp-run-row"><button class="primary-btn" data-a="run">Spustit</button>'
    + '<button class="mini-btn" data-a="stop">Zastavit</button>'
    + '<button class="mini-btn" data-a="reveal">Složka</button></div></div>';
  const st = body.querySelector('[data-st]');
  const refresh = async () => {
    try {
      // Bez /FI filtru: ten se pres cmd.exe rozbiji na citacich ("Invalid argument/option").
      // Vypise se vsechno (CSV) a hleda se presne "jmeno.exe" v uvozovkach.
      const r = await window.api.toolsExec({ tool: 'shell', args: { command: 'tasklist /FO CSV /NH' }, root: prefs.activeProject, fullAccess: true });
      const on = r && r.ok && String(r.output || '').toLowerCase().includes('"' + String(short).toLowerCase() + '.exe"');
      if (st) { st.textContent = on ? 'Stav: běží ✓' : 'Stav: neběží'; st.classList.toggle('on', !!on); }
      return !!on;
    } catch { if (st) st.textContent = 'Stav: neznámý'; return false; }
  };
  const launch = async () => {
    if (st) st.textContent = 'Stav: spouštím…';
    try { await window.api.toolsExec({ tool: 'shell', args: { command: 'start "" "' + abs + '"' }, root: prefs.activeProject, fullAccess: true }); } catch {}
    setTimeout(refresh, 1500);
  };
  body.querySelector('[data-a="run"]').addEventListener('click', launch);
  body.querySelector('[data-a="stop"]').addEventListener('click', async () => {
    try { await window.api.toolsExec({ tool: 'close_app', args: { target: abs }, root: prefs.activeProject, fullAccess: true }); } catch {}
    setTimeout(refresh, 800);
  });
  body.querySelector('[data-a="reveal"]').addEventListener('click', async () => {
    try { await window.api.toolsExec({ tool: 'open_path', args: { path: abs }, root: prefs.activeProject, fullAccess: true }); } catch {}
  });
  refresh();
  // Auto-spuštění jen při prvním otevření karty (ne při přepínání záložek).
  if (autoLaunch) launch();
}

/* ---------- Prostředí: co je v PC, co chybí, Fix ALL ---------- */
function prefsGo(section) {
  document.querySelectorAll('#prefsNav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-pref') === section));
  document.querySelectorAll('#prefsPages .pref-page').forEach(s => s.style.display = s.getAttribute('data-ppage') === section ? '' : 'none');
}
/* ---------- Settings → Error Log ---------- */
function syncErrUI() {
  const le = $('#errLogCheck'); if (le) le.checked = prefs.logErrors !== false;
}
async function saveErrPref(patch) {
  prefs = Object.assign(prefs, patch);
  try { await window.api.setStore(patch); } catch {}
  syncErrUI();
}
async function refreshErrLog() {
  const view = $('#errLogView'); if (!view) return;
  try {
    const r = await window.api.errRead();
    view.textContent = (r && r.ok) ? (r.text || '(prázdný)') : ((r && r.text) || 'nelze číst');
  } catch (e) { view.textContent = 'Chyba čtení: ' + (e && e.message); }
}
function openPrefs() {
  $('#prefsModal').classList.add('open');
  $('#soundCheck').checked = !!prefs.sound;
  const gc = $('#googleCheck'); if (gc) gc.checked = prefs.googleSearch !== false;
  const be = prefs.shellBackend || prefs.terminal || 'auto';
  document.querySelectorAll('input[name="shellbe"]').forEach(r => r.checked = r.value === be);
  syncErrUI();
  try { window.api.errPath().then(p => { const n = $('#errLogPath'); if (n && p && p.path) n.textContent = p.path; }); } catch {}
  refreshErrLog();
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
  // Bez omezení: všechny toolchainy včetně velkých, bez volby.
  const wantHeavy = true;
  const todo = missingAll;
  if (!todo.length) {
    if (el.envSummary) el.envSummary.textContent = 'Všechno je v PC ✓';
    return;
  }
  if (el.envSummary) el.envSummary.textContent = 'Fix ALL: instaluji ' + todo.join(', ') + '…\nMůže to trvat desítky minut (stahuji z internetu). Nech appku běžet.';
  await envInstall(todo, { heavy: wantHeavy });
  if (!heavyIds.length && el.envSummary) el.envSummary.textContent += '\nHotovo ✓';
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
  // Instaluje se všechno chybějící, včetně velkých toolchainů — bez dotazu.
  const need = (data.missing || []).filter(Boolean);
  if (!need.length) return data;
  return await envInstall(need, { heavy: true });
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
  if (name === 'build_exe') return 'Buildím a testuji EXE…';
  if (name === 'question') return 'Ptám se…';
  if (name === 'show_panel') return 'Otvírám v panelu…';
  if (name === 'close_app') return 'Zavírám ' + (baseName(args.target) || args.target || 'aplikaci') + '…';
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
    el.messages.appendChild(wrap); scrollBottomSmooth();
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
/* ---------- Prohlížeč složek (všechny disky) ---------- */
let brState = { path: null, parent: null, drives: [], shortcuts: [] };
function brRender(listEl, items, ico, onClick) {
  if (!listEl) return;
  if (!items.length) { listEl.innerHTML = '<div class="browser-empty">Žádné složky</div>'; return; }
  listEl.innerHTML = items.map((it, i) => '<div class="browser-item' + (it.path === brState.path ? ' active' : '') + '" data-i="' + i + '">'
    + '<span class="bi-ico">' + ico + '</span><span>' + escapeHtml(it.name) + '</span></div>').join('');
  listEl.querySelectorAll('.browser-item').forEach(n => n.addEventListener('click', () => onClick(items[parseInt(n.getAttribute('data-i'), 10)])));
}
function brLoad(p) {
  const list = $('#browserList'), drv = $('#browserDrives'), sh = $('#browserShortcuts'), pathEl = $('#browserPath');
  Promise.resolve(window.api.fsBrowse(p || null)).then(r => {
    if (!r || !r.ok) { if (list) list.innerHTML = '<div class="browser-empty">' + escapeHtml((r && r.error) || 'Chyba') + '</div>'; return; }
    brState.path = r.path; brState.parent = r.parent || null;
    brState.drives = r.drives || []; brState.shortcuts = r.shortcuts || [];
    if (pathEl) pathEl.textContent = r.path || 'Tento počítač — vyber disk';
    brRender(drv, brState.drives, '💾', (it) => brLoad(it.path));
    brRender(sh, brState.shortcuts, '⭐', (it) => brLoad(it.path));
    brRender(list, r.folders || [], '📁', (it) => brLoad(it.path));
    const up = $('#browserUp');
    if (up) up.style.display = r.parent ? '' : 'none';
  }).catch(e => { if (list) list.innerHTML = '<div class="browser-empty">Chyba: ' + escapeHtml(e && e.message) + '</div>'; });
}
function pickFolder(startPath) {
  return new Promise((resolve) => {
    const m = $('#browserModal');
    if (!m) { resolve(null); return; }
    m.classList.add('open');
    brLoad(startPath || null);
    const done = (v) => { m.classList.remove('open'); resolve(v); };
    const onPick = () => done(brState.path || null);
    const onCancel = () => done(null);
    const onUp = () => { if (brState.parent) brLoad(brState.parent); };
    const onNew = async () => {
      const name = ($('#browserNewName') || {}).value;
      if (!name || !brState.path) return;
      const r = await window.api.fsMkdir(brState.path, name);
      if (r && r.ok) { $('#browserNewName').value = ''; brLoad(r.path); } else setFooter((r && r.error) || 'Složku se nepodařilo vytvořit');
    };
    const b = m.querySelector('#browserPick'), c = m.querySelector('#browserCancel');
    const u = m.querySelector('#browserUp'), n = m.querySelector('#browserNewFolder');
    const bd = m.querySelector('#browserBackdrop'), x = m.querySelector('#browserClose');
    if (b) b.onclick = onPick; if (c) c.onclick = onCancel; if (u) u.onclick = onUp;
    if (n) n.onclick = onNew; if (bd) bd.onclick = onCancel; if (x) x.onclick = onCancel;
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
      // usage z brány (prompt/completion/total) — základ pro počítadlo tokenů
      if (j.usage && typeof j.usage === 'object') {
        const u = j.usage;
        const g = (k) => (typeof u[k] === 'number' ? u[k] : 0);
        st.usage = {
          prompt: g('prompt_tokens') || g('input_tokens') || (u.prompt_tokens_details ? 0 : 0),
          completion: g('completion_tokens') || g('output_tokens'),
          total: g('total_tokens') || (g('prompt_tokens') + g('completion_tokens'))
        };
        if (st.usage.total) { st.usage.prompt = st.usage.prompt || Math.max(0, st.usage.total - st.usage.completion); }
        try { if (window.api && window.api.debugLog) window.api.debugLog('usage', st.usage); } catch {}
      }
      const d = ch.delta || {};
      if (typeof d.content === 'string') st.text += d.content;
      // Přemýšlení modelu — chodí v delta.reasoning_content, dřív se zahazovalo.
      const rc = d.reasoning_content || d.reasoning;
      if (typeof rc === 'string' && rc) { st.reasoning += rc; }
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
/* ---------- směrování streamů (paralelní chaty) ----------
   Každý požadavek má vlastní streamId. Main ho posílá s každým chunkem,
   tady se chunky rozdělí do správného oneShot. Dřív tu byla jediná globální
   posluchačka, takže dvě chaty generující současně si odpovědi promíchaly. */
const streamRoutes = new Map();
let streamRouterBound = false;
let streamSeq = 0;
function newStreamId() {
  streamSeq++;
  return 'r' + Date.now().toString(36) + '-' + streamSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
function bindStreamRouter() {
  if (streamRouterBound) return;
  streamRouterBound = true;
  // starší main posílá chunky jako prostý string (bez ID) — padá na jediný aktivní stream
  const pick = (p) => {
    const sid = (p && typeof p === 'object' && p.s !== undefined && p.s !== null) ? String(p.s) : '';
    let r = sid ? streamRoutes.get(sid) : null;
    if (!r && streamRoutes.size === 1) r = streamRoutes.values().next().value;
    return r;
  };
  try { window.api.onChunk((p) => { const r = pick(p); if (!r) return; r.chunk((p && typeof p === 'object' && 'd' in p) ? p.d : p); }); } catch {}
  try { window.api.onEnd((p) => { const r = pick(p); if (r) r.end(); }); } catch {}
  try { window.api.onError((p) => { const r = pick(p); if (r) r.error((p && typeof p === 'object' && p.e) ? p.e : p); }); } catch {}
}

function oneShot(messages, maxTokens, onThink, onUsage, opts) {
  opts = opts || {};
  const convoId = opts.convoId || activeConvoId;
  bindStreamRouter();
  const streamId = newStreamId();
  return new Promise((resolve) => {
    const st = { text: '', reasoning: '', toolCalls: new Map(), pending: null, error: '', usage: null };
    const cleanup = () => { streamRoutes.delete(streamId); };
    const onC = (d) => {
      parseSSE(String(d), st);
      try { if (onThink) onThink(st.reasoning); } catch {}
      // Počítadlo tokenů se plní už během generování.
      try { if (onUsage) onUsage(st.usage, st); } catch {}
    };
    const onE = () => { cleanup(); flushPending(st); resolve(st); };
    const onX = (e) => {
      const msg = e && (e.error || e.message) ? String(e.error || e.message) : (e ? String(e) : 'neznámá chyba');
      st.error = msg.slice(0, 300);
      st.isRateLimit = !!(e && e.isRateLimit) || /429|rate limit|FreeUsageLimit/i.test(st.error);
      st.isRegionBlocked = !!(e && e.isRegionBlocked) || /403|RegionError|not available in your country/i.test(st.error);
      const ra = parseInt(e && e.retryAfterMs, 10);
      st.retryAfterMs = !isNaN(ra) && ra > 0 ? Math.min(ra, 300000) : 0;
      errLog('aistream', st.error, { via: (e && e.via) || '', isRateLimit: st.isRateLimit, isRegionBlocked: st.isRegionBlocked, url: (e && e.url) || '', convoId });
      cleanup(); flushPending(st); resolve(st);
    };
    streamRoutes.set(streamId, { chunk: onC, end: onE, error: onX });
    // Prázdný seznam nástrojů = "žádné nástroje". Důležité: brána vždy nechá v těle
    // requestu shell+read (jinak request odmítne), takže prázdno musí jít i jako noTools.
    const noTools = opts.noTools === true || (Array.isArray(opts.allowedTools) && opts.allowedTools.length === 0);
    try {
      window.api.chatStreamStart({
        messages, model: opts.model || zenIdOf(selectedModel), convoId, streamId,
        agent: !!opts.agent, projectRoot: prefs.activeProject,
        fullAccess: true, maxTokens: maxTokens || SEND_MAX_TOKENS,
        allowedTools: noTools ? [] : (opts.allowedTools || ALL_TOOLS.slice()),
        noTools,
        websearch: prefs.googleSearch !== false
      });
    } catch (e) { onX({ error: e && e.message ? e.message : String(e) }); }
  });
}

/* ---------- odeslání ---------- */
async function sendMessage(overrideText) {
  // Bez přihlášení se nepíše — pojistka i kdyby brána zlobila.
  try { const lg = $('#loginGate'); if (lg && lg.style.display !== 'none') { setFooter('Nejdřív se přihlas přes Google.'); return; } } catch {}
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
  const firstMsg = convo.messages.length === 0;
  if (firstMsg) { convo.title = text.slice(0, 48) || 'Nová konverzace'; }
  // Rozpoznej otázku vs. úkol ještě před @expanzí (přiložený obsah by mátl detekci) — Build podle toho odpoví, nebo maká.
  // Commercial video má vlastní detekci: popis reklamy je vždy úkol, nikdy pokec s otázkami.
  const intent = activeProjectType() === 'video' ? detectCommercialIntent(text) : detectIntent(text);
  // @ kontext: @cesta → přilož obsah souboru
  text = await expandAtRefs(text);
  // Přiložené obrázky: soubory v uploads/ + instrukce pro model
  if (chatImages.length) {
    const ctx = imageContext();
    if (ctx) text = text + '\n\n' + ctx;
    convo.messages.push({ role: 'user', content: text, images: chatImages.map(i => i.rel) });
    chatImages = [];
    renderAttachStrip();
  } else {
    convo.messages.push({ role: 'user', content: text });
  }
  lastUserRequest = text;
  dlog('send', { textLen: text.length, textHead: text.slice(0, 200), histMsgs: convo.messages.length });
  el.promptInput.value = ''; autoGrow();
  saveConvos(); renderMessages(); renderChatList();
  if (intent !== 'chat') await ensureForRequest(text);
  // Každý chat generuje nezávisle — streamingChats Map drží stav per chat
  await runAgent(convo, intent);
}
function updateQueue(animateLast) {
  if (!el.queueBar) return;
  if (!pendingQueue.length) { el.queueBar.style.display = 'none'; el.queueBar.innerHTML = ''; return; }
  el.queueBar.style.display = '';
  el.queueBar.innerHTML = '<span class="q-dot"></span><span class="q-label">Fronta ' + pendingQueue.length + '/5</span>'
    + pendingQueue.map((m, i) => '<span class="q-bubble' + (animateLast && i === pendingQueue.length - 1 ? ' pop' : '') + '">'
      + escapeHtml(m.slice(0, 60)) + (m.length > 60 ? '…' : '') + '</span>').join('');
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
  if (cmd === '/clear') { if (activeConvoId && streamingChats.has(activeConvoId)) stopEverything('Vymazáno', activeConvoId); const c = activeConvo(); if (c) { c.messages = []; saveConvos(); renderMessages(); } return true; }
  if (cmd === '/help') {
    const c = activeConvo() || newConvo(true);
    c.messages.push({ role: 'user', content: text });
    c.messages.push({ role: 'assistant', content: 'Příkazy: /new (nový chat), /clear (vymazat), /model <jméno> (změnit model), /terminal, /preview, /env. Kontext: @cesta/soubor.' });
    saveConvos(); renderMessages(); return true;
  }
  if (cmd === '/model') {
    const q = parts.slice(1).join(' ').toLowerCase();
    const hit = getModels().find(m => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (hit) { selectedModel = hit.id; localStorage.setItem('nlc_model', selectedModel); updateModelLabel(); renderModelList(); setFooter('Model: ' + scrubName(hit.label)); }
    else setFooter('Model nenalezen: ' + q);
    return true;
  }
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

async function runAgent(convo, intent) {
  // Per-chat streaming stav — každý chat generuje nezávisle
  const chatState = { stopRequested: false };
  streamingChats.set(convo.id, chatState);
  if (convo.id === activeConvoId) { stopRequested = false; resetTokenMeter(); }
  // Tlačítko send se přemění na animovaný stav "generating" — žádné druhé tlačítko.
  setSendBusy(true);
  /* Build automaticky rozliší otázku od úkolu: na otázku dostane jen
     čtecí nástroje, na úkol celou sadu. */
  /* POZOR: read-only sada nástrojů pro "otázku" se nesmí nikdy zapnout v konverzaci,
     kde už se pracovalo. Bez `write_file` totiž model nemá jak uložit soubor a začne
     zapisovat přes `shell` (PowerShell here-string) → "command line is too long" /
     "missing terminator" → hotová chyba a žádný soubor. Když už v historii je
     zápis nebo příkaz, jde o pokračování práce → běží plný build agent. */
  const didWork = convoDidWork(convo);
  const isQuestion = intent === 'chat' && !didWork;
  const effMode = isQuestion ? 'chat' : 'build';
  // u otázky běží build agent s omezenou sadou nástrojů (jen čtení + dotaz)
  let toolSet = (effMode === 'build') ? ALL_TOOLS.slice() : READ_TOOLS.slice();
  if (didWork && intent === 'chat') dlog('intent', { convoId: convo.id, was: 'chat', forced: 'build', why: 'conversation already has write/exec calls' });
  setFooter(isQuestion ? 'Rozpoznal jsem otázku — odpovídám…' : 'Rozpoznal jsem úkol — pracuji…');
  const streamWrap = addMsg('assistant', '<span class="thinking">Analyzuji<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><span class="stream-caret"></span>', null);
  const bubble = streamWrap ? streamWrap.querySelector('.bubble-assistant') : null;
  dlog('runstart', { convoId: convo.id, effMode, intent, histMsgs: convo.messages.length });
  /* --- guard proti křížení chatů ---
     Když uživatel přepne na jiný chat, tenhle běží dál v pozadí. Od té chvíle
     nesmí kreslit do otevřené konverzace (jinak by tool-karty a stavová hláška
     patřily cizímu chatu). Stavy zapisujeme jen do vlastního DOM uzlu. */
  const isVisible = () => convo.id === activeConvoId;
  const paintActivity = (t) => { if (isVisible()) setActivity(t); };
  const paintFooter = (t) => { if (isVisible()) setFooter(t); };
  const paintTrail = (trail, idx) => { if (isVisible()) renderPlanBox(trail, idx); };
  const paintCard = (...a) => { if (isVisible()) return renderToolCard(...a); return null; };
  try {
    let projCtx = '';
    if (prefs.activeProject) {
      // SE SKENEM SE NECHÁVÍME NA POZDĚ — na Z: (WebDAV) trvá desítky sekund a čekání
      // by zase zmrazilo UI. Vrátíme jen to, co už máme v cache, a sken spustíme na pozadí.
      // Od druhé zprávy má AI soubory k dispozici.
      try {
        const r = await window.api.projectFiles(prefs.activeProject, false, true);
        if (r && r.ok && (r.tree || []).length) {
          projCtx = '\n\n[Aktivní projekt: ' + prefs.activeProject + '\nSoubory:\n' + r.tree.slice(0, 120).map(t => t.path).join('\n') + ']';
        }
      } catch {}
      try { window.api.projectScanAsync(prefs.activeProject); } catch {}
    }
    if (activeProjectType() === 'video') {
      const vr = videoResWH();
      projCtx += '\n[Video project: target resolution ' + vr.w + 'x' + vr.h + ' (' + vr.label + ')]';
    }
    let rounds = 0;
    let finalText = '';
    let lastThinking = ''; // přemýšlení modelu z posledního kola — jde do Thinking bloku
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
    let staleRounds = 0; // po sobě jdoucí kola BEZ skutečného postupu (žádný zápis/spuštění)
    let roundProductive = false; // tohle kolo něco skutečně udělalo
    let readNudged = false; // direktiva proti čtecí rutině (max 1x za úkol)
    let writeDirectiveLevel = 0; // 0=žádná, 1=mírná, 2=tvrdá (čtení vypnuto)
    let autoRetried = false; // už se jednou zkusilo znovu po "jen čtení"
    const planTrail = []; // provedené kroky úkolu (1 volání = 1 krok), pro lištu průběhu
    // Počet modelových kroků. Na posledním se nástroje odstraní
    // a model dostane jen pokyn shrnout, co udělal.
    const maxRounds = (effMode === 'build') ? 20 : 8;
    const stepNotice = (n) => (n >= maxRounds)
      ? '[POSLEDNÍ KROK. Nemáš už žádné nástroje. Napiš už teď stručně, v jakém stavu práce je a kde je výsledek (cesta k souboru/exe). 2–4 věty, žádné plány.]'
      : '';
    while (rounds < maxRounds && !chatState.stopRequested) {
      rounds++;
      // Poslední krok: nástroje zmizí, model jen shrňuje.
      const lastStep = rounds >= maxRounds;
      // System message = jen kontext projektu (prázdné se do promptu vůbec nedává).
      const sysText = projCtx + stepNotice(rounds);
      const msgs = sysText ? [{ role: 'system', content: sysText }] : [];
      // Model má 1M kontextu — posíláme mu mnohem víc historie než dřív (bylo jen 30 zpráv,
      // tedy ~2 % okna). Navíc hlídáme odhad velikosti promptu, aby se to nevešlo do limitu.
      const reqStart = currentReqStart(convo);
      const hist = convo.messages;
      const histStart = Math.max(0, hist.length - HIST_MESSAGES);
      let promptChars = sysText.length;
      for (let hi = histStart; hi < hist.length; hi++) {
        const m = hist[hi];
        if (m.role === 'user' && m.internal && hi < reqStart) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const content = String(m.content || '');
        // ~4 znaky na token; když by prompt přesáhl bezpečný podíl kontextu,
        // odhazujeme nejstarší zprávy (aktuální požadavek musí zůstat vždy).
        if (promptChars + content.length > PROMPT_CHAR_BUDGET && msgs.length > 2) break;
        promptChars += content.length;
        msgs.push({ role: m.role, content });
      }
      paintActivity(rounds > 1 ? 'Pokračuji…' : 'Analyzuji…');
      if (bubble && isVisible()) bubble.innerHTML = '<span class="thinking">Analyzuji<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><span class="stream-caret"></span>';
      dlog('round', {
        round: rounds, sysChars: sysText.length,
        msgsSent: msgs.length, promptChars: msgs.reduce((n, m) => n + String(m.content || '').length, 0),
        maxT: MAX_TOKENS
      });
      const roundT0 = Date.now();
      if (isVisible()) resetThink();
      const onThink = (r) => { if (bubble) updateThink(bubble, r, true); };
      const st = await oneShot(msgs, MAX_TOKENS, onThink, updateTokenMeter, {
        convoId: convo.id, agent: true, allowedTools: lastStep ? [] : toolSet
      });
      // Poslední krok je souhrn — kdyby model přesto poslal volání, nevykoná se.
      if (chatState.stopRequested) break;
      // Chyba spojení se nikdy nesmí tiše spolknout — ukázat neutrální hlášku a po 3. opakování skončit.
      // Tady je poslední záchrana: 403 se neopakuje, přetížení zkusí druhý model NolimitCoder.
      if (st.error) {
        lastErr = String(st.error).slice(0, 300);
        // 403 RegionError = zeme je blokovana → rovnou poctiva hlaska, opakovat nema smysl.
        if (st.isRegionBlocked && !chatState.stopRequested) {
          finalText = 'Model není v této zemi dostupný — brána NolimitCoder vrátila 403. Zkus jiný model, nebo to zkus později.';
          break;
        }
        if (st.isRateLimit && !chatState.stopRequested) {
          // Zkusit druhy model NolimitCoder (ma vlastni kvotu), max 1x za pozadavek. Potichu, bez zmínky o limitech.
          const other = !modelSwitched && MODEL_FALLBACK[selectedModel];
          if (other && getModels().some(m => m.id === other)) {
            modelSwitched = true;
            selectedModel = other;
            try { localStorage.setItem('nlc_model', selectedModel); } catch {}
            updateModelLabel(); renderModelList();
            paintActivity('Zkouším druhý model NolimitCoder…');
            paintFooter('Přepnuto na ' + modelLabel(selectedModel) + '…');
            dlog('ratelimit', { modelSwitch: selectedModel });
            continue;
          }
          finalText = 'AI je teď přetížená — zkus to prosím za chvíli znovu, nebo zapni lokální model.';
          break;
        }
        errRounds++;
        paintActivity('');
        paintFooter('Chyba AI: ' + publicErr(lastErr).slice(0, 120));
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
      if (String(st.reasoning || '').trim()) lastThinking = String(st.reasoning).trim();
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
          paintActivity('Upřesňuji akci…');
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
        // průběžné myšlení ukaž — Thinking blok musí zůstat, proto se vkládá PŘED něj
        const th = thinkState.box && thinkState.box.isConnected ? thinkState.box.outerHTML : '';
        if (bubble && isVisible()) { bubble.innerHTML = th + mdToHtml(text) + '<span class="stream-caret"></span>'; bindCopyButtons(); bindThink(bubble); scrollStickSafe(); }
      }
      if (!calls.length) {
        if (text) { finalText = text; break; }
        // prázdné kolo: nezahazovat úkol hláškou, zkusit další kolo (max 3×), pak záchranné kolo
        emptyRounds++;
        if (emptyRounds >= 3) { finalText = ''; break; }
        continue;
      }
      emptyRounds = 0; // produktivní kolo → počítadlo znovu
      roundProductive = false;
      // proveď tool cally (každé provedení = 1 krok v liště)
      // Žádné omezování podle režimu — AI může psát, mazat i spouštět vždy.
      for (let ci = 0; ci < calls.length; ci++) {
        const c = calls[ci];
        if (chatState.stopRequested) break;
        if (lastStep && c.name !== 'question') {
          const msg = 'Toto je poslední krok — už nejsou dostupné žádné nástroje. Napiš rovnou souhrn, co je hotové a kde to je (cesta k souboru).';
          convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: msg, ok: false });
          paintCard(c.name, c.args, msg, false);
          continue;
        }
        if (c.name !== 'question' && !toolSet.includes(c.name)) {
          const msg = 'Nástroj ' + c.name + ' teď není k dispozici. Použij nástroje, které tu jsou, nebo odpověz textem.';
          convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: msg, ok: false });
          paintCard(c.name, c.args, msg, false);
          dlog('perm', { tool: c.name, effect: 'no-tool' });
          continue;
        }
        if (c.name === 'question') {
          paintActivity('Ptám se…');
          planTrail.push({ name: c.name, args: c.args, st: 'live' });
          paintTrail(planTrail, planTrail.length - 1);
          const ans = await askQuestion(c.args);
          planTrail[planTrail.length - 1].st = 'done';
          paintTrail(planTrail, planTrail.length - 1);
          convo.messages.push({ role: 'tool', tool: 'question', args: c.args, result: 'Uživatel odpověděl: ' + ans, ok: true });
          paintCard('question', c.args, ans, true);
          msgs.push({ role: 'assistant', content: text || '' });
          continue;
        }
        if (c.name === 'shell' && (shellNeedsApproval() || !autoShell)) {
          const cmdKey = String(c.args.command || '').trim();
          if (!approvedOnce.has(cmdKey)) {
            const verdict = await askShellApproval(cmdKey);
            if (!verdict) {
              convo.messages.push({ role: 'tool', tool: 'shell', args: c.args, result: 'Uživatel příkaz zamítl.', ok: false });
              paintCard('shell', c.args, 'Zamítnuto uživatelem.', false);
              continue;
            }
            approvedOnce.add(cmdKey);
          }
        }
        // Bez otevřeného projektu dřív viselo modální okno "Kam to uložit?" a AI stálo.
        // Teď si samo založí pracovní složku (Plocha/NolimitCoder/<název>) a jede dál.
        if (['write_file', 'append_file', 'download_file', 'edit_file', 'create_dir'].includes(c.name) && !prefs.activeProject && !String(c.args.path || c.args.to || '').match(/^([a-zA-Z]:[\\/]|\\\\|\/)/)) {
          const auto = await autoWorkspace(convo);
          if (auto) {
            prefs.activeProject = auto;
            try { await window.api.setStore({ activeProject: auto }); } catch {}
            dlog('autoproj', { path: auto });
          }
        }
        paintActivity(activityFor(c.name, c.args));
        // Nástroj míří mimo aktivní složku? → smooth dotaz (pokud už nebylo "vždy").
        if (!askAlways && ['write_file', 'append_file', 'edit_file', 'create_dir', 'delete_file', 'move_file', 'copy_file', 'download_file', 'shell', 'open_path'].includes(c.name)) {
          const raw = String((c.args || {}).path || (c.args || {}).to || (c.args || {}).from || '').trim();
          const outside = raw ? outsideProject(/^([a-zA-Z]:[\\/]|\\\\)/.test(raw) ? raw : null) : null;
          if (outside) {
            const v = await askAccess(outside);
            if (v === 'no') {
              convo.messages.push({ role: 'tool', tool: c.name, args: c.args, result: 'Zamítnuto uživatelem — AI nesmí do této složky.', ok: false });
              paintCard(c.name, c.args, 'Zamítnuto uživatelem.', false);
              paintActivity('');
              continue;
            }
          }
        }
        const emptyWhy = emptyCallReason(c.name, c.args || {}, c);
        if (!emptyWhy) {
          planTrail.push({ name: c.name, args: c.args, st: 'live' });
          paintTrail(planTrail, planTrail.length - 1);
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
            paintActivity('Chybí ' + missId + ' — stahuji a instaluji automaticky…');
            paintCard('env_install', { id: missId }, 'Automatická instalace ' + missId + '…', true);
            let inst;
            try {
              inst = await window.api.toolsExec({ tool: 'env_install', args: { id: missId }, root: prefs.activeProject, fullAccess: true });
            } catch (e) { inst = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
            convo.messages.push({ role: 'tool', tool: 'env_install', args: { id: missId }, result: String((inst && inst.output) || ''), ok: !!(inst && inst.ok) });
            paintCard('env_install', { id: missId }, String((inst && inst.output) || ''), !!(inst && inst.ok));
            if (inst && inst.ok) {
              paintActivity(activityFor(c.name, c.args) + ' (po instalaci znovu)');
              try {
                res = await window.api.toolsExec({ tool: c.name, args: withBackend(c.name, c.args), root: prefs.activeProject, fullAccess: true });
              } catch (e) { res = { ok: false, output: 'Chyba: ' + (e.message || e) }; }
            }
          }
          // Vlastní lámavý ověřovací one-liner (rozbité závorky/cesty s mezerami)? Soubory se kontrolují přes file_info, ne přes shell.
          if (c.name === 'shell' && /ParserError|Missing closing|was unexpected|unexpected token/i.test(String(res.output || ''))) {
            res = Object.assign({}, res, { output: String(res.output || '') + '\n[POZOR: tvůj kontrolní shell one-liner má chybu syntaxe (závorky/cesty s mezerami). Soubory příště ověřuj VŽDY nástrojem file_info {"path": "..."} — žádné vlastní powershell/cmd kontrolní příkazy.]' });
            dlog('parsehint', { cmd: String((c.args || {}).command || '').slice(0, 120) });
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
        // Selhaný nástroj už zapisuje main (IPC tools:exec) — tady by vznikl duplikát
        // každé chyby. Tahle větev se loguje jen pro záznam viz níže (emptycall jde do dlog).
        if (res && res.ok && ['write_file', 'append_file', 'edit_file', 'shell', 'env_install'].includes(c.name)) roundProductive = true;
        if (!emptyWhy) {
          // Stráží zachycené prázdné volání se v chatu neukazuje (nic se nestalo) — jen v logu a v kontextu modelu.
          paintCard(c.name, c.args, String((res && res.output) || ''), !!(res && res.ok), res && res.diff, !!(res && res.cached));
          // show_panel: AI otevřelo výsledek do výsuvného panelu — hned ho ukaž.
          if (c.name === 'show_panel' && res && res.ok && !emptyWhy) {
            try { openSidePanelFor(c.args.path || c.args.target, c.args.mode); } catch (e) { errLog('panel/open', e && e.message); }
          }
          planTrail[planTrail.length - 1].st = (res && res.ok) ? 'done' : 'bad';
          paintTrail(planTrail, planTrail.length - 1);
        }
      }
      // Zaseknutá smyčka: kola jen čtou a nic se neděje.
      // DŮLEŽITÉ: místo toho, abychom to zabili po 4. kole a ukázali "Nedokončeno",
      // do toho JDEME — postupně posíláme direktivy. Model, který jen čte, potřebuje
      // říct, ať přestane čtít a začne psát. Teprve když ani ta nejtvrdší direktiva
      // nepomůže, skončíme. Poctivá stavba to nezasáhne (zápis vynuluje počítadlo).
      if (roundProductive) { staleRounds = 0; writeDirectiveLevel = 0; }
      else staleRounds++;
      if (staleRounds >= 3 && writeDirectiveLevel < 1) {
        writeDirectiveLevel = 1;
        convo.messages.push({ role: 'user', internal: true, content: WRITE_DIRECTIVE_1 });
        dlog('write-directive', { level: 1, rounds });
        paintActivity('Tlačím k akci…');
      }
      if (staleRounds >= 5 && writeDirectiveLevel < 2) {
        writeDirectiveLevel = 2;
        convo.messages.push({ role: 'user', internal: true, content: WRITE_DIRECTIVE_2 });
        dlog('write-directive', { level: 2, rounds });
        paintActivity('Tlačím k akci…');
        // Čtecí nástroje vypneme — model musí psát, ne číst. Bez toho by zase
        // začal procházet kód a nikdy by nezačal pracovat.
        toolSet = toolSet.filter(t => !['read_file', 'list_dir', 'glob_file', 'file_info', 'search_files'].includes(t));
        dlog('tools', { after: 'write-directive-2', kept: toolSet.length });
      }
      // Teprve po 7. čtecím kole skončíme — a řekneme to poctivě
      if (staleRounds >= 7) {
        const didWorkSoFar = runToolMsgs(convo).some(m => !m.skipped && m.ok && (['write_file', 'append_file', 'edit_file'].includes(m.tool) || m.tool === 'shell' || m.tool === 'env_install'));
        if (didWorkSoFar || rounds >= 8) {
          /* AUTO-RETRY: když model jen čte a nezapíše nic, necháme to běžet znovu
             s tvrdou direktivou — uživatel nemusí psát znovu. Druhé kolo už má
             v kontextu všechno přečtené, takže model jde rovnou k zápisu. */
          if (!autoRetried && isWorkRequest(lastUserText(convo))) {
            autoRetried = true;
            rounds = 0; staleRounds = 0; writeDirectiveLevel = 2;
            toolSet = toolSet.filter(t => !['read_file', 'list_dir', 'glob_file', 'file_info', 'search_files'].includes(t));
            convo.messages.push({ role: 'user', internal: true, content: WRITE_DIRECTIVE_2 });
            dlog('auto-retry', { rounds, reads: runToolMsgs(convo).filter(m => ['read_file', 'list_dir', 'glob_file', 'file_info', 'search_files'].includes(m.tool)).length });
            paintActivity('Zkouším to znovu…');
            continue;
          }
          const s = buildRunSummary(runToolMsgs(convo), lastErr, lastUserText(convo));
          if (s) { finalText = s; dlog('final', { kind: 'stale-break', rounds }); break; }
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
      const lastTools = runToolMsgs(convo).slice(-TOOLS_IN_CONTEXT).map(t => {
        const h = sumHash(t);
        if (summarized.has(h)) return '[' + t.tool + ' ' + (t.ok ? 'OK' : 'CHYBA') + ']\n(stejný výsledek jako výše — neopakuji)';
        summarized.add(h);
        return '[' + t.tool + ' ' + ((t.ok ? 'OK' : 'CHYBA')) + ']\n' + String(t.result).slice(0, TOOL_RESULT_CHARS);
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
          paintActivity('Tlačím k akci…');
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
    if (!finalText && !chatState.stopRequested) {
      const doneSummary = buildRunSummary(runToolMsgs(convo), lastErr, lastUserText(convo));
      if (doneSummary) {
        finalText = doneSummary;
        dlog('final', { kind: 'summary', finalLen: finalText.length });
      } else {
        // O běžné otázce ("ahoj", "diky") NEPSE stav práce — vrátilo by to
        // "v chatu nic neproběhla…". Závěr si zaslouží jen skutečný úkol.
        const wasWork = isWorkRequest(lastUserText(convo));
        if (!wasWork) {
          finalText = 'Jsem tu. Co chceš udělat?';
          dlog('final', { kind: 'smalltalk' });
        } else try {
          paintActivity('Sepisuji výsledek…');
          const rec = await oneShot([
            { role: 'user', content: '[Napiš stručně textem, v jakém stavu práce je a kde je výsledek (cesta k souboru/exe). Žádné nástroje, jen 2-4 věty.]' }
          ], 1024, null, null, { convoId: convo.id, noTools: true });
          if (rec && rec.text) finalText = rec.text;
          dlog('final', { kind: 'model', finalLen: finalText.length });
        } catch {}
      }
    }
    // Po práci VŽDY následuje výsledek: když text nezní hotově, shrnutí se připíše (slib se nahradí fakty).
    if (finalText && !chatState.stopRequested) {
      const acts = runToolMsgs(convo).filter(m => !m.skipped && (
        ['write_file', 'append_file', 'edit_file'].includes(m.tool) ||
        ((m.tool === 'shell' || m.tool === 'env_install') && m.ok)
      ));
      if (acts.length && !looksDone(finalText)) {
        const s = buildRunSummary(runToolMsgs(convo), lastErr, lastUserText(convo));
        if (s) {
          if (looksPromise(finalText)) { dlog('final', { kind: 'past-rewrite' }); finalText = s; }
          else { dlog('final', { kind: 'append-summary' }); finalText = finalText + '\n\n' + s; }
        }
      }
    }
    finalText = sanitizeResponse(finalText || '');
    // Uživatel zrušil generování → žádná HTTP chyba, prosté "zastaveno".
    if (chatState.stopRequested) {
      if (!finalText || looksPromise(finalText) || finalText.length < 12) finalText = 'Generování bylo zastaveno.';
    } else if (!finalText && lastErr) {
      finalText = 'Nedokončeno — ' + publicErr(lastErr) + ' Zkus to prosím znovu za chvíli.';
    }
    
    dlog('final', { finalLen: finalText.length, finalHead: finalText.slice(0, 200), rounds });
    convo.messages.push({ role: 'assistant', content: finalText || 'Nedostala jsem od AI žádnou odpověď (prázdný stream). Zkus to prosím poslat znovu.', thinking: lastThinking });
    saveConvos();
    // Pozadí chat NESMÍ překreslit právě otevřenou konverzaci — šeptalo by do jiného chatu.
    if (convo.id === activeConvoId) { renderMessages(); paintFooter('Hotovo'); }
    renderChatList();
    playDone();
    // Video project: primárním výstupem je MP4 — po každém zápisu reklamy ho rovnou automaticky nahraj
    // (index.html zůstává uvnitř jako zdroj, ze kterého se nahrává). index.html musí ve složce VŽDY být:
    // když ho AI jen vypsala do chatu, pojistka ho vytáhne a zapíše sama, jak bývalo zvykem.
    try {
      if (activeProjectType() === 'video' && !chatState.stopRequested) {
        const writes = runToolMsgs(convo).filter(m => !m.skipped && m.ok && ['write_file', 'append_file', 'edit_file'].includes(m.tool));
        let htmlReady = writes.length > 0;
        if (!htmlReady) {
          htmlReady = await ensureVideoHtml(convo);
          if (htmlReady) saveConvos();
        }
        if (htmlReady) {
          try { reloadPreviewFrame(); } catch {} // video je vidět INSTANTNĚ, MP4 se donahraje potom
          paintFooter('Nahrávám MP4…');
          await videoExportRun();
          paintFooter('Hotovo · MP4 nahráno');
        }
      }
    } catch {}
  } catch (e) {
    if (bubble && isVisible()) bubble.innerHTML = mdToHtml('Chyba: ' + (e.message || e));
    if (convo.id === activeConvoId) paintFooter('Chyba');
  } finally {
    // Odstraň chat ze streaming stavu — ostatní chaty můžou dál generovat
    streamingChats.delete(convo.id);
    if (convo.id === activeConvoId) {
      paintActivity(null); hidePlanBox();
      setSendBusy(false);
      try { if (activeProjectType() === 'video') refreshVideoEmpty(); } catch {}
      // Po Stopu se fronta maže — nic dalšího se už nespustí. Jinak jede další zpráva ve frontě.
      if (chatState.stopRequested && pendingQueue.length) { pendingQueue.length = 0; }
      if (pendingQueue.length) { const nx = pendingQueue.shift(); updateQueue(); sendMessage(nx); }
      else updateQueue();
    }
    renderChatList(); // Aktualizuj indikátory generování v seznamu chatů
  }
}
/* Deterministické shrnutí úkolu Z DAT (bez modelu — ten by zase jen něco slíbil) */
function buildRunSummary(toolMsgs, lastErr, userText) {
  /* Závěrečný souhrn běhu — vždy s emoji, co se stalo a co se udělalo,
     každá položka na vlastním řádku. Lehce delší, lidsky, česky. */
  const ms = (toolMsgs || []).filter(m => !m.skipped);
  if (!ms.length) return '';
  const uniq = (a) => [...new Set(a)];
  const short = (p) => String(p || '').split(/[\\/]/).slice(-2).join('/');
  const writes = uniq(ms.filter(m => ['write_file', 'append_file', 'edit_file'].includes(m.tool) && m.ok)
    .map(m => short((m.args || {}).path || (m.args || {}).to)));
  const writesBad = uniq(ms.filter(m => ['write_file', 'append_file', 'edit_file'].includes(m.tool) && !m.ok)
    .map(m => short((m.args || {}).path || (m.args || {}).to)));
  const shellsOk = ms.filter(m => m.tool === 'shell' && m.ok).map(m => String((m.args || {}).command || '').slice(0, 80));
  const shellsBad = ms.filter(m => m.tool === 'shell' && !m.ok);
  const envOk = uniq(ms.filter(m => m.tool === 'env_install' && m.ok).map(m => String((m.args || {}).id || ((m.args || {}).ids || []).join(', ')) || 'nástroje'));
  const reads = ms.filter(m => ['read_file', 'list_dir', 'glob_file', 'file_info'].includes(m.tool)).length;
  const didWork = writes.length > 0 || shellsOk.length > 0 || envOk.length > 0;
  const req = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const lines = [];
  if (shellsBad.length && !didWork) {
    // Selhalo driv, nez se neco povedlo
    lines.push('❌ Nedokončeno — poslední příkaz selhal dřív, než se něco uložilo.');
    if (req) lines.push('📩 Požadavek: "' + req + '"');
    lines.push('');
    const last = shellsBad[shellsBad.length - 1];
    const err = String(last.result || '').split('\n').map(s => s.trim())
      .filter(s => /chyba|error|fail|není|neni|not found|nelze|selhal|exit [1-9]|nenalezen|syntax/i.test(s))[0]
      || String(last.result || '').slice(0, 200);
    lines.push('⚠️ Co se pokazilo:');
    lines.push('• `' + String((last.args || {}).command || '').slice(0, 80) + '`');
    lines.push('• Chyba: ' + err.slice(0, 220));
    if (writes.length) { lines.push(''); lines.push('📝 Přesto se stihlo zapsat:'); writes.forEach(w => lines.push('• ' + w)); }
    lines.push('');
    lines.push('💡 Zkus to poslat znovu — nebo napiš, co má být jinak.');
  } else if (didWork) {
    lines.push('✅ Hotovo! ' + (req ? 'Požadavek "' + req + '" je splněný.' : 'Práce je hotová.'));
    lines.push('');
    if (writes.length) {
      lines.push(writes.length === 1 ? '📝 Zapsaný soubor:' : '📝 Zapsané soubory (' + writes.length + '):');
      writes.forEach(w => lines.push('• ' + w));
    }
    if (shellsOk.length) {
      lines.push('⚙️ Spuštěné příkazy (' + shellsOk.length + '):');
      uniq(shellsOk).slice(-5).forEach(c => lines.push('• `' + c + '`'));
      if (uniq(shellsOk).length > 5) lines.push('• …a další (' + (uniq(shellsOk).length - 5) + '×)');
    }
    if (envOk.length) {
      lines.push('📦 Doinstalované nástroje:');
      envOk.forEach(e => lines.push('• ' + e));
    }
    if (writesBad.length) {
      lines.push('⚠️ Neuložilo se (' + writesBad.length + '):');
      writesBad.forEach(w => lines.push('• ' + w));
    }
    if (shellsBad.length) {
      const last = shellsBad[shellsBad.length - 1];
      const err = String(last.result || '').split('\n').map(s => s.trim())
        .filter(s => /chyba|error|fail|není|neni|not found|nelze|selhal|exit [1-9]|nenalezen/i.test(s))[0]
        || String(last.result || '').slice(0, 160);
      lines.push('⚠️ Poslední příkaz sice selhal, ale výsledek už je uložený:');
      lines.push('• `' + String((last.args || {}).command || '').slice(0, 80) + ': ' + err.slice(0, 160));
    }
    // kde je vysledek: exe / html v koreni projektu
    const exeLike = writes.filter(w => /\.exe$/i.test(w));
    const htmlLike = writes.filter(w => /\.html?$/i.test(w) && !/\.exe$/i.test(w));
    if (exeLike.length || htmlLike.length) {
      lines.push('');
      lines.push('📂 Výsledek najdeš tady:');
      exeLike.forEach(w => lines.push('• ' + w));
      htmlLike.slice(0, 3).forEach(w => lines.push('• ' + w));
    }
  } else {
    // Jen se cetlo, nic se neudelalo
    lines.push('🔍 Prošel jsem kód, ale nic jsem nezapsal ani nespustil.');
    if (req) lines.push('📩 Požadavek: "' + req + '"');
    lines.push('');
    lines.push(isWorkRequest(userText)
      ? '👁️ Prohlédnutých souborů: ' + reads + ' — ale žádný jsem nezměnil.'
      : '👁️ Jen jsem se podíval (čtení: ' + reads + ').');
    lines.push('💡 Zkus to poslat znovu — nebo řekni přesněji, co mám udělat (třeba "oprav chybu v calc-engine.js").');
  }
  if (lastErr) lines.push('ℹ️ Poznámka: ' + publicErr(lastErr).slice(0, 120));
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
/* Bez otevřeného projektu nechceme AI zastavit dotazem — založíme jí vlastní
   pracovní složku na Ploše a rovnou ji zapíšeme jako aktivní projekt. */
function slugFor(t) {
  const s = String(t || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'projekt';
}
async function autoWorkspace(convo) {
  try {
    const f = await window.api.knownFolders();
    const base = (f && f.documents) || f.desktop || f.downloads;
    if (!base) return null;
    let root = base.replace(/[\\/]+$/, '') + '\\NolimitCoder';
    // číselná složka, aby se projekty navzájem nepřepsaly
    let n = 1;
    let name = slugFor(lastUserText(convo));
    let path = root + '\\' + name;
    while (projectRegistry.some(p => p && p.path === path)) {
      n++;
      path = root + '\\' + name + '-' + n;
    }
    const mk = await window.api.toolsExec({ tool: 'create_dir', args: { path }, root: root, fullAccess: true });
    if (!mk || !mk.ok) return null;
    const entry = { name: baseName(path) || name, path, type: 'universal', framework: 'html' };
    projectRegistry.push(entry); saveRegistry(); renderProjects();
    return path;
  } catch { return null; }
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
  const pb = $('#playerBar'); if (pb) pb.style.display = on ? '' : 'none';
  if (on) { try { showLiveTab(); } catch {} }
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
      try { window.api.previewWatch(root); } catch {} // hlídej složku: jakýkoliv nový soubor = instantní reload
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
/* Empty video project → the frame is transparent (website glow shines through),
   plus the waiting text on top. As soon as index.html exists, the real ad shows. */
const VIDEO_EMPTY_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<body style="margin:0;background:transparent">');
/* Tvrdý reload náhledu — po vygenerování se video ukáže INSTANTNĚ, nečeká se na nic. */
function reloadPreviewFrame() {
  const frame = $('#previewFrame');
  if (!frame) return;
  try {
    const url = $('#previewUrl') ? $('#previewUrl').textContent : '';
    if (url && url.startsWith('http')) {
      const cur = String(frame.src || '');
      if (cur === url || cur === url + '/') {
        try { frame.contentWindow.location.reload(); return; } catch {}
      }
      frame.src = url;
    }
  } catch {}
}
async function refreshVideoEmpty() {
  const empty = $('#videoEmpty'), frame = $('#previewFrame'), stage = $('#previewStage');
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
  try { if (stage) stage.classList.toggle('clean', hasIndex); } catch {}
  if (hasIndex) {
    empty.style.display = 'none';
    reloadPreviewFrame();
    fitVideoFrame();
  } else {
    try { if (String(frame.src || '') !== VIDEO_EMPTY_PAGE) frame.src = VIDEO_EMPTY_PAGE; } catch {}
    empty.style.display = '';
    fitVideoFrame();
  }
}
/* Z největšího ```html bloku v textu vytáhni hotové HTML (aspoň 200 znaků, musí vypadat jako stránka). */
function extractHtmlBlock(text) {
  const t = String(text || '');
  const re = /```(?:html|HTML)\s*\n([\s\S]*?)```/g;
  let m, best = '';
  while ((m = re.exec(t))) { if (m[1].length > best.length) best = m[1]; }
  best = String(best || '').trim();
  if (best.length < 200) return '';
  if (!/<(html|!doctype|div|body|head|style)\b/i.test(best)) return '';
  return best;
}
/* Video pojistka: index.html musí ve složce VŽDY být, jak bývalo zvykem.
   Když ho AI jen vypsala do chatu a nezapsala nástrojem, vytáhni ho a zapiš sám. */
async function ensureVideoHtml(convo) {
  try {
    if (activeProjectType() !== 'video' || !prefs.activeProject) return false;
    let has = false;
    try {
      const r = await window.api.projectFiles(prefs.activeProject, false);
      if (r && r.ok) {
        const paths = (r.tree || []).map(x => String(x.path || '').toLowerCase());
        has = paths.includes('index.html') || paths.includes('dist/index.html');
      }
    } catch {}
    if (has) return true;
    const msgs = (convo.messages || []).slice(currentReqStart(convo));
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || !m.content) continue;
      const html = extractHtmlBlock(m.content);
      if (!html) continue;
      const res = await window.api.toolsExec({ tool: 'write_file', args: { path: 'index.html', content: html }, root: prefs.activeProject, fullAccess: true });
      if (res && res.ok) {
        convo.messages.push({ role: 'tool', tool: 'write_file', args: { path: 'index.html' }, result: 'HTML z chatu uloženo jako index.html (' + html.length + ' znaků).', ok: true });
        renderToolCard('write_file', { path: 'index.html' }, 'HTML z chatu uloženo jako index.html.', true);
        return true;
      }
      return false;
    }
    return false;
  } catch { return false; }
}
/* MP4 player: recorded video with play/pause + seek bar under it (Live HTML | MP4 tabs). */
function mp4Url() {
  try {
    const base = $('#previewUrl') ? $('#previewUrl').textContent : '';
    if (!base || !base.startsWith('http') || !lastVideoPath) return '';
    const file = String(lastVideoPath).split(/[\\/]/).pop();
    return base.replace(/\/$/, '') + '/' + encodeURIComponent(file);
  } catch { return ''; }
}
function showMp4Tab() {
  const v = $('#mp4Player'); if (!v) return false;
  const url = mp4Url(); if (!url) return false;
  const f = $('#previewFrame'); if (f) f.style.display = 'none';
  const bl = $('#videoBlocker'); if (bl) bl.style.display = 'none';
  const em = $('#videoEmpty'); if (em) em.style.display = 'none';
  v.style.display = ''; v.src = url;
  const tL = $('#tabLive'), tM = $('#tabMp4');
  if (tL) tL.classList.remove('active'); if (tM) tM.classList.add('active');
  const pc = $('#playerControls'); if (pc) pc.style.display = '';
  try { v.play().catch(() => {}); syncMp4Btn(); } catch {}
  return true;
}
function showLiveTab() {
  const v = $('#mp4Player');
  if (v) { try { v.pause(); } catch {} try { v.removeAttribute('src'); } catch {} v.style.display = 'none'; }
  const f = $('#previewFrame'); if (f) f.style.display = '';
  const tL = $('#tabLive'), tM = $('#tabMp4');
  if (tL) tL.classList.add('active'); if (tM) tM.classList.remove('active');
  const pc = $('#playerControls'); if (pc) pc.style.display = 'none';
  try { refreshVideoEmpty(); } catch {}
}
function syncMp4Btn() { const b = $('#mp4Play'), v = $('#mp4Player'); if (b && v) b.textContent = v.paused ? '▶ Play' : '⏸ Pause'; }
function fmtClock(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function setVideoProgress(t) { const p = $('#videoProgress'); if (p) p.textContent = t || ''; }
async function videoExportRun() {
  if (videoExporting) return;
  if (!prefs.activeProject) { setVideoProgress('No project selected'); return; }
  const { w, h } = videoResWH();
  videoExporting = true;
  try { showLiveTab(); } catch {} // nahrává se nové — zpět na živé HTML
  const btn = $('#videoExport'); if (btn) btn.disabled = true;
  const dl = $('#videoDownload'); if (dl) dl.style.display = 'none';
  setVideoProgress('Preparing…');
  try {
    const r = await window.api.videoExport({ root: prefs.activeProject, width: w, height: h, durationSec: videoDur, fps: 30 });
    if (r && r.ok) {
      lastVideoPath = r.path;
      setVideoProgress('Done: ' + r.file + ' (' + r.mb + ', ' + fmtDur(videoDur) + ')');
      if (dl) dl.style.display = '';
      try { showMp4Tab(); } catch {} // hotové video se rovnou ukáže v přehrávači
      playDone();
    } else {
      const errMsg = String((r && r.error) || 'unknown error');
      setVideoProgress(/cancelled/i.test(errMsg) ? 'Zastaveno' : 'Export failed: ' + errMsg.slice(0, 160));
    }
  } catch (e) {
    const errMsg = String((e && e.message) || e);
    setVideoProgress(/cancelled/i.test(errMsg) ? 'Zastaveno' : 'Export failed: ' + errMsg.slice(0, 160));
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
  try { if (prefs.activeProject) window.api.previewUnwatch(prefs.activeProject); } catch {}
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  bindEls();
  // Login hned jako první — dřív než jakékoliv await (store, verze, projekty),
  // aby se bez ověření nedalo kliknout ani psát.
  try { initLoginGate(); } catch {}
  // Windows: systémová tlačítka (min/max/close) zabírají pravý horní roh → posun login tlačítka mimo ně
  try { if (navigator.userAgent && /Windows/i.test(navigator.userAgent)) document.body.classList.add('win'); } catch {}
  try { const s = await window.api.getStore(); prefs = Object.assign(prefs, s || {}); } catch {}
  // po startu: uložený aktivní chat mohl patřit jinému projektu — srovnat
  if (!activeConvo() || !projectMatch(activeConvo())) {
    const rest = conversations.filter(projectMatch);
    activeConvoId = rest.length ? rest[rest.length - 1].id : null;
    try { localStorage.setItem('nlc_active', activeConvoId || ''); } catch {}
  }
  try { const v = await window.api.getVersion(); if ($('#sideVer')) $('#sideVer').textContent = 'NolimitCoder ' + v; } catch {}
  // Očista starých klíčů (localStorage); klíče v config.json mažou main.js v getStore()
  try { ['nlc_mode', 'nlc_agent'].forEach(k => localStorage.removeItem(k)); } catch {}
  // Slider rychlosti je pryč — tokenový limit je pevný (MAX_TOKENS).
  try { updateTokenMeter(null, null); } catch {}
  updateModelLabel(); renderModelList(); renderProjects(); showView('projects');
  renderChatList(); renderMessages();
  try { const d = await window.api.projectsDir(); if ($('#projectsDirPath')) $('#projectsDirPath').textContent = d; } catch {}
  // model picker — dropdown se vždy vejde do okna (posune se doleva, když by přetekl vpravo)
  el.modelCurrent.addEventListener('click', (e) => { e.stopPropagation(); el.modelDropdown.classList.toggle('open'); if (el.modelDropdown.classList.contains('open')) { clampDropdown(); setTimeout(() => el.modelSearch.focus(), 30); } });
  window.addEventListener('resize', () => { try { clampDropdown(); } catch {} });
  document.addEventListener('click', (e) => { if (!el.modelSelector.contains(e.target)) closeModels(); });
  bindComposerMeta();
  el.modelSearch.addEventListener('input', () => { searchQuery = el.modelSearch.value; renderModelList(); });
  $('#fetchZenBtn').addEventListener('click', (e) => { e.preventDefault(); refreshZenLive(); });
  // Řádek "Zobrazit využití" a odkaz na plány v dropdownu modelu
  const mdUsage = $('#mdUsage');
  if (mdUsage) mdUsage.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); closeModels();
    const i = tokState.in || 0, o = tokState.out || 0;
    setFooter((i || o)
      ? ('Využití posledního běhu: ' + fmtTok(i) + ' vstup + ' + fmtTok(o) + ' výstup tokenů (limit ' + fmtTok(tokState.max || MAX_TOKENS) + ')')
      : 'Zatím žádné využití — odpověz něčím a uvidíš spotřebu.');
  });
  const mdPlans = $('#mdPlans');
  if (mdPlans) mdPlans.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); closeModels(); openPrefs();
  });
  // Indikátor složky: klik = změna
  const fpill = $('#folderPill');
  if (fpill) fpill.addEventListener('click', changeFolder);
  setFolderLabel();
  // composer
  el.promptInput.addEventListener('input', autoGrow);
  el.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  // (listener na sendBtn je níže — sdílí funkci Stop i Send)
  // ===== Obrázky: Ctrl+V v chatu, tlačítko +, drag&drop =====
  const atBtn = $('#attachBtn'), atIn = $('#attachInput');
  if (atBtn && atIn) atBtn.addEventListener('click', () => atIn.click());
  if (atIn) atIn.addEventListener('change', async (e) => {
    await addImageFiles(e.target.files);
    e.target.value = '';
  });
  el.promptInput.addEventListener('paste', async (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from((dt.files || []));
    if (!files.some(f => /^image\//.test(f.type || ''))) return;
    e.preventDefault();
    await addImageFiles(files);
  });
  // Drag & drop obrázku přímo do chatu
  const drop = (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) addImageFiles(files);
  };
  el.promptInput.addEventListener('dragover', (e) => { e.preventDefault(); el.promptInput.classList.add('drag'); });
  el.promptInput.addEventListener('dragleave', () => el.promptInput.classList.remove('drag'));
  el.promptInput.addEventListener('drop', (e) => { el.promptInput.classList.remove('drag'); drop(e); });
  // Ctrl+V mimo textarea (tělo okna) — aby šlo vložit i když je fokus jinde
  document.addEventListener('paste', async (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.some(f => /^image\//.test(f.type || ''))) return;
    e.preventDefault();
    await addImageFiles(files);
  });
  // Zastavit = klik na generující tlačítko (už žádné samostatné Stop).
  el.sendBtn.addEventListener('click', () => { if (activeConvoId && streamingChats.has(activeConvoId)) { stopEverything(); return; } sendMessage(); });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newConvo(); renderMessages(); } });
  // MP4 player shortcuts: space = play/pause, arrows = seek 5 s (only when the video is visible, never while typing)
  document.addEventListener('keydown', (e) => {
    try {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const v = $('#mp4Player');
      if (!v || v.style.display === 'none' || !v.src) return;
      if (e.code === 'Space') { e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); syncMp4Btn(); }
      else if (e.code === 'ArrowRight' && v.duration) { v.currentTime = Math.min(v.duration, v.currentTime + 5); }
      else if (e.code === 'ArrowLeft' && v.duration) { v.currentTime = Math.max(0, v.currentTime - 5); }
    } catch {}
  });
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
  // Výsuvný panel: tlačítko vpravo nahoře, ✕ v hlavičce, ↻ přenačte iframe.
  const ptg = $('#panelToggle');
  if (ptg) ptg.addEventListener('click', () => toggleSidePanel());
  const pcl = $('#sidePanelClose');
  if (pcl) pcl.addEventListener('click', () => toggleSidePanel(false));
  const prl = $('#sidePanelReload');
  if (prl) prl.addEventListener('click', () => {
    const f = document.querySelector('#sidePanelBody iframe');
    if (f) { try { f.contentWindow.location.reload(); } catch { try { f.src = f.src; } catch {} } }
  });
  // video: resolution + length + export to MP4 + download
  const vres = $('#videoRes');
  if (vres) {
    vres.value = videoRes;
    vres.addEventListener('change', () => {
      videoRes = vres.value;
      try { localStorage.setItem('nlc_videores', videoRes); } catch {}
      // ultra-smooth bubble pop on resolution switch + celé HTML se přenačte v nové velikosti
      try {
        const fr = $('#previewFrame');
        if (fr) { fr.classList.remove('res-pop'); void fr.offsetWidth; fr.classList.add('res-pop'); }
      } catch {}
      fitVideoFrame();
      try { reloadPreviewFrame(); } catch {}
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
  // player tabs + controls (play/pause + seek bar + time)
  const tL = $('#tabLive'); if (tL) tL.addEventListener('click', showLiveTab);
  const tM = $('#tabMp4'); if (tM) tM.addEventListener('click', () => { if (!showMp4Tab()) setVideoProgress('No MP4 yet — generate first'); });
  const mp = $('#mp4Play');
  if (mp) mp.addEventListener('click', () => { const v = $('#mp4Player'); if (!v) return; try { if (v.paused) v.play().catch(() => {}); else v.pause(); } catch {} syncMp4Btn(); });
  const ms = $('#mp4Seek');
  if (ms) {
    const fillSeek = () => { try { ms.style.setProperty('--fill', (parseFloat(ms.value) / 10) + '%'); } catch {} };
    ms.addEventListener('input', () => { const v = $('#mp4Player'); if (v && v.duration) { try { v.currentTime = (parseFloat(ms.value) / 1000) * v.duration; } catch {} } fillSeek(); });
    fillSeek();
  }
  const mv = $('#mp4Player');
  if (mv) {
    mv.addEventListener('timeupdate', () => {
      const t = $('#mp4Time');
      if (t) t.textContent = fmtClock(mv.currentTime) + ' / ' + fmtClock(mv.duration);
      const s = $('#mp4Seek');
      if (s && mv.duration) { s.value = String(Math.round(mv.currentTime / mv.duration * 1000)); try { s.style.setProperty('--fill', (mv.currentTime / mv.duration * 100) + '%'); } catch {} }
    });
    mv.addEventListener('loadedmetadata', () => { const t = $('#mp4Time'); if (t) t.textContent = '0:00 / ' + fmtClock(mv.duration); });
    mv.addEventListener('play', syncMp4Btn); mv.addEventListener('pause', syncMp4Btn); mv.addEventListener('ended', syncMp4Btn);
  }
  try {
    // záměrně ticho: žádná čára ani sekundy průběhu, jen výsledek (Done/chybu píše videoExportRun sám)
    window.api.onVideoProgress(() => {});
  } catch {}
  // file watcher: jakýkoliv soubor ve složce projektu = náhled se hned sám přenačte (žádné ruční REFRESH)
  try {
    window.api.onPreviewFileChanged((d) => {
      try {
        if (!d || !d.root || !prefs.activeProject) return;
        const a = String(d.root).replace(/\\/g, '/').toLowerCase();
        const b = String(prefs.activeProject).replace(/\\/g, '/').toLowerCase();
        if (a !== b) return;
        const pane = $('#previewPane');
        if (!pane || pane.style.display === 'none') return;
        reloadPreviewFrame();
        if (isVideoMode()) refreshVideoEmpty();
      } catch {}
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
  // Error Log — přepínač zápisu chyb
  const ple = $('#errLogCheck');
  if (ple) ple.addEventListener('change', async (e) => { await saveErrPref({ logErrors: e.target.checked }); });
  const eob = $('#errOpenBtn'); if (eob) eob.addEventListener('click', async () => { const r = await window.api.errOpen(); if (!r || !r.ok) { const v = $('#errLogView'); if (v) v.textContent = (r && r.error) || 'Log zatím neexistuje.'; } });
  const erb = $('#errRefreshBtn'); if (erb) erb.addEventListener('click', refreshErrLog);
  const ecb = $('#errCopyBtn'); if (ecb) ecb.addEventListener('click', async () => {
    try { const r = await window.api.errRead(); await navigator.clipboard.writeText((r && r.text) || ''); const v = $('#errLogView'); if (v) v.textContent = (v.textContent || '') + '\n\n[Zkopírováno do schránky.]'; } catch (e) { errLog('errlog/copy', e && e.message); }
  });
  const eclb = $('#errClearBtn'); if (eclb) eclb.addEventListener('click', async () => { await window.api.errClear(); await refreshErrLog(); });
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
  initAccount();
  initLoginGate();
  initBlockGate();
  autoGrow();
});

// ---------- Login gate: app starts only after Google login ----------
function setGate(show) {
  const g = $('#loginGate');
  if (g) g.style.display = show ? 'flex' : 'none';
}
function hideVeil() {
  const v = $('#bootVeil');
  if (!v || v.classList.contains('hide')) return;
  v.classList.add('hide');
  setTimeout(() => { try { v.remove(); } catch {} }, 300);
}
let loginGateInit = false;
function initLoginGate() {
  if (loginGateInit) return;
  loginGateInit = true;
  const btn = $('#gateGoogleBtn');
  const errBox = $('#gateErr');
  const showErr = (m) => { if (errBox) { errBox.textContent = m; errBox.style.display = m ? '' : 'none'; } };
  if (btn) btn.addEventListener('click', async () => {
    showErr('');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Waiting for browser…';
    try {
      const r = await window.api.authLogin();
      if (r && r.loggedIn) setGate(false);
      else showErr((r && r.error) || 'Login failed.');
    } catch (e) {
      showErr('Login failed: ' + (e && e.message || e));
    }
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Continue with Google';
  });
  // Boot: brána je vidět od prvního vykreslení (HTML default display:flex).
  // Bez ověřeného loginu se do aplikace nedostaneš — ani na 15 sekund.
  // Fail-safe timeout — if the check hangs, show the gate rather than spinning forever.
  let veiled = false;
  let bootOk = false; // ověřený login při startu — pak už bránu nic znovu neukáže
  const settle = (loggedIn) => { if (loggedIn) bootOk = true; setGate(!loggedIn); if (!veiled) { veiled = true; hideVeil(); } };
  const statusP = (() => { try { return window.api.authStatus(); } catch { return Promise.resolve(null); } })();
  // Pomalá síť: původní check běží dál — když doběhne kladně, bránu schová i zpětně.
  statusP.then((s) => { if (s && s.loggedIn) settle(true); }).catch(() => {});
  // Rychlá cesta (5 s): když visí, ukaž bránu prozatímně, ne navždy.
  Promise.race([statusP, new Promise((res) => setTimeout(() => res(null), 5000))])
    .then((s) => settle(!!(s && s.loggedIn))).catch(() => settle(false));
  // Fail-safe JEN když se nic nedozvědělo — nikdy po ověřeném loginu.
  setTimeout(() => { if (!bootOk) settle(false); }, 10000);
  try { window.api.onAuthChanged((p) => settle(!!p)); } catch {}
}

// ---------- Blokace nepovolené verze (LIVE z repa NolimitCoder-Download) ----------
// Kazdou minutu prijde bud app:blocked (ukaže se okno), nebo app:unblocked
// (okno se samo schova — verze se mezitim stala aktualni). Kdyz v repu neni
// vubec nic, ukazuje se "nedostupna" misto "update". Warning je live text
// z WARNING.md v repu.
function initBlockGate() {
  try {
    if (!window.api || !window.api.onAppBlocked) return;
    // Progress samo-aktualizace (váže se jen jednou)
    if (window.api.onUpdateProgress && !window.__blkProgBound) {
      window.__blkProgBound = true;
      window.api.onUpdateProgress((p) => {
        try {
          if (!p) return;
          const fill = $('#blockFill'), st = $('#blockStatus'), prog = $('#blockProg');
          const up = $('#blockUpdate'), dl = $('#blockDownload');
          if (p.error) {
            if (st) st.textContent = 'Aktualizace selhala: ' + p.error + ' — zkus ruční stažení níže.';
            if (prog) prog.classList.remove('on');
            if (up) up.disabled = false;
            if (dl) dl.disabled = false;
          } else if (p.done) {
            if (fill) fill.style.width = '100%';
            if (st) st.textContent = p.replacing
              ? 'Mažu starou verzi a instaluji novou… aplikace se za chvíli sama restartuje.'
              : 'Instaluji… aplikace se za chvíli sama restartuje.';
          } else if (p.pct >= 0) {
            if (fill) fill.style.width = p.pct + '%';
            if (st) st.textContent = 'Stahuji novou verzi… ' + p.pct + '% (' + (p.mb || 0) + ' z ' + (p.totalMb || '?') + ' MB)';
          } else {
            if (st) st.textContent = 'Stahuji novou verzi… ' + (p.mb || 0) + ' MB';
          }
        } catch {}
      });
    }
    window.api.onAppBlocked((d) => {
      try {
        const g = $('#blockGate');
        if (!g) return;
        // Nedostupna (v repu nic neni) vs zastarala (je tam novejsi).
        const unav = !!(d && d.unavailable);
        const t = $('#blockTitle');
        if (t) t.textContent = unav ? 'Aplikace je momentálně nedostupná' : 'Update required';
        if (d && d.reason) {
          const r = $('#blockReason');
          if (r) r.textContent = String(d.reason);
        }
        // Live warning z GitHubu (WARNING.md). Pryc, kdyz zadny neni.
        const w = $('#blockWarn');
        if (w) {
          const wt = String((d && d.warning) || '').trim().slice(0, 500);
          if (wt) { w.textContent = '⚠ ' + wt; w.style.display = ''; }
          else { w.textContent = ''; w.style.display = 'none'; }
        }
        const url = d && d.latest && d.latest.download_url;
        const dl = $('#blockDownload');
        if (dl) {
          dl.style.display = url ? '' : 'none';
          dl.disabled = false;
          dl.onclick = () => { try { window.api.openExternal(url); } catch {} };
        }
        const up = $('#blockUpdate');
        const prog = $('#blockProg'), fill = $('#blockFill'), st = $('#blockStatus');
        if (up) {
          up.style.display = url ? '' : 'none';
          up.disabled = false;
          up.querySelector('span').textContent = 'Aktualizovat software';
          if (prog) prog.classList.remove('on');
          if (fill) fill.style.width = '0%';
          if (st) st.textContent = '';
          up.onclick = async () => {
            if (!url) return;
            try { up.disabled = true; if (dl) dl.disabled = true; } catch {}
            if (prog) prog.classList.add('on');
            if (fill) fill.style.width = '0%';
            if (st) st.textContent = 'Stahuji novou verzi…';
            try { await window.api.startUpdate(url); }
            catch (e) {
              if (st) st.textContent = 'Aktualizace selhala: ' + (e && e.message || e);
              try { up.disabled = false; if (dl) dl.disabled = false; } catch {}
            }
          };
        }
        g.style.display = 'flex';
      } catch {}
    });
    // Verze se mezitim stala aktualni (pribyla do repa) -> okno samo zmizi.
    if (window.api.onAppUnblocked) {
      window.api.onAppUnblocked(() => {
        try { const g = $('#blockGate'); if (g) g.style.display = 'none'; } catch {}
      });
    }
  } catch {}
}

// ---------- Google account (desktop OAuth, main process does the flow) ----------
function renderAccount(profile) {
  const label = $('#accountLabel'), ico = $('#accountIco');
  const name = $('#acctName'), mail = $('#acctMail'), ava = $('#acctAva');
  const gBtn = $('#acctGoogleBtn'), outBtn = $('#acctLogout'), err = $('#acctErr');
  if (err) err.style.display = 'none';
  const pvAva = $('#pvAva'), pvName = $('#pvName');
  if (profile) {
    const first = (profile.name || profile.email || 'U').split(' ')[0];
    if (pvName) pvName.textContent = first;
    if (pvAva) pvAva.innerHTML = profile.picture ? `<img src="${profile.picture}" alt="">` : '👤';
    if (label) label.textContent = first;
    if (ico) ico.innerHTML = profile.picture ? `<img src="${profile.picture}" alt="" style="width:18px;height:18px;border-radius:50%">` : '👤';
    if (name) name.textContent = profile.name || profile.email || 'Logged in';
    if (mail) mail.textContent = profile.email || '';
    if (ava) ava.innerHTML = profile.picture ? `<img src="${profile.picture}" alt="">` : '👤';
    if (gBtn) gBtn.style.display = 'none';
    if (outBtn) outBtn.style.display = '';
  } else {
    if (pvName) pvName.textContent = 'Log in';
    if (pvAva) pvAva.textContent = '👤';
    if (label) label.textContent = 'Log in';
    if (ico) ico.textContent = '👤';
    if (name) name.textContent = 'Not logged in';
    if (mail) mail.textContent = 'Log in with Google to link your account.';
    if (ava) ava.textContent = '👤';
    if (gBtn) { gBtn.style.display = ''; gBtn.disabled = false; gBtn.querySelector('span').textContent = 'Continue with Google'; }
    if (outBtn) outBtn.style.display = 'none';
  }
}
function initAccount() {
  const open = () => $('#accountModal').classList.add('open');
  const close = () => $('#accountModal').classList.remove('open');
  $('#accountBtn').addEventListener('click', open);
  const pvBtn = $('#pvAccount');
  if (pvBtn) pvBtn.addEventListener('click', open);
  $('#accountClose').addEventListener('click', close);
  $('#accountBackdrop').addEventListener('click', close);
  const showErr = (m) => { const e = $('#acctErr'); if (e) { e.textContent = m; e.style.display = m ? '' : 'none'; } };
  $('#acctGoogleBtn').addEventListener('click', async () => {
    const btn = $('#acctGoogleBtn');
    showErr('');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Waiting for browser…';
    try {
      const r = await window.api.authLogin();
      if (r && r.loggedIn) { renderAccount(r.profile); close(); }
      else showErr((r && r.error) || 'Login failed.');
    } catch (e) {
      showErr('Login failed: ' + (e && e.message || e));
    }
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Continue with Google';
  });
  $('#acctLogout').addEventListener('click', async () => {
    try { await window.api.authLogout(); } catch {}
    renderAccount(null);
  });
  try { window.api.onAuthChanged((p) => renderAccount(p || null)); } catch {}
  window.api.authStatus().then((s) => renderAccount(s && s.loggedIn ? s.profile : null)).catch(() => renderAccount(null));
}

/* ---------- proxy pool UI odstraněno ----------
   Rotace proxy při přetížení běží potichu v main procesu. Uživatel nikdy
   nevidí nic o quotě, limitech ani proxy — proto tu není žádný badge,
   žádný listener ani žádné hlášky. (window.api.proxyStatus/proxyRefresh
   v preloadu zůstávají pro interní potřeby main procesu.) */
