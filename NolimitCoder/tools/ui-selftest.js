/* Kontrola novych UI elementu prázdného stavu (OpenCode styl). */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };

console.log('--- HTML ---');
ok('#mainCol existuje', html.includes('id="mainCol"'));
for (const id of ['composerMeta', 'metaProj', 'metaProjName', 'metaBranch', 'metaBranchName', 'metaBranchIco']) {
  ok('#' + id + ' je v HTML', html.includes('id="' + id + '"'));
}
ok('#metaAgent pryč (agent systém odstraněn)', !html.includes('id="metaAgent"'));
ok('#agentSelector pryč', !html.includes('id="agentSelector"'));
ok('meta řádek je uvnitř composer-wrap', /composer-foot[\s\S]*?composer-meta[\s\S]*?<\/div>\s*<\/div>/.test(html));

console.log('--- CSS ---');
for (const sel of ['.main.is-empty .chat-container', '.main.is-empty .composer', '.main.is-empty .composer-meta',
  '.empty-mark', '.empty-word', '.empty-hint', '.empty-sugg-inline', '.meta-pill', '.meta-sep', '.meta-chev',
  '@keyframes emptyRise', '.main.is-empty .messages{display:none}', '.main.is-empty .composer-foot{display:none}']) {
  ok(sel + ' je definován', css.includes(sel));
}
ok('wordmark je bledý (průhledná výplň + clip)', /background-clip:text/.test(css) && /color:transparent/.test(css));
ok('composer má max-width 880 v prázdném stavu', /\.main\.is-empty \.composer\{max-width:880px/.test(css));

console.log('--- JS: funkce ---');
for (const fn of ['setEmptyState', 'renderEmptyState', 'updateComposerMeta', 'bindComposerMeta',
  'scrollBottomSmooth', 'scrollStick', 'scrollStickSafe', 'openProjects']) {
  ok('function ' + fn + '()', new RegExp('function\\s+' + fn + '\\s*\\(').test(js));
}
ok('renderMessages volá setEmptyState', /function renderMessages[\s\S]{0,2200}setEmptyState\(/.test(js));
ok('renderMessages volá renderEmptyState', /renderEmptyState\(\)/.test(js));
ok('renderMessages volá updateComposerMeta', /updateComposerMeta\(\);/.test(js));
ok('bindComposerMeta je zavolaná v initu', /bindComposerMeta\(\);/.test(js));
ok('stream drží scroll (updateThink)', /scrollStickSafe\(\);\s*\/\/ myšlení také roste/.test(js));
ok('stream drží scroll (bubble.innerHTML)', /bindThink\(bubble\); scrollStickSafe\(\);/.test(js));

console.log('--- JS: žádné mrtvé třídy ---');
ok('is-blurred se nepoužívá (CSS ani JS)', !/is-blurred/.test(js) && !/is-blurred/.test(css));
ok('starý .chat-empty se nepřekresluje jako .empty-title', !js.includes('class="empty-title"'));

console.log('--- logika scrollu ---');
const hasStickPx = /SCROLL_STICK_PX\s*=\s*140/.test(js);
ok('SCROLL_STICK_PX existuje', hasStickPx);
ok('scrollBottomSmooth respektuje odrolování nahoru', /if \(!nearBottom && mode === 'auto'\) return;/.test(js));
ok('scrollStick má fallback na scrollTop', /c\.scrollTop = c\.scrollHeight/.test(js));
ok('smooth scroll přes scrollTo({behavior})', /c\.scrollTo\(\{ top: target, behavior: mode \}\)/.test(js));
ok('RAF se ruší při rychlém opakování', /cancelAnimationFrame\(smoothScrollRaf\)/.test(js));

console.log('--- stavový řádek ---');
ok('metaProject = basename cesty', /textContent = \(prefs\.activeProject \|\| ''\)\.split/.test(js));
ok('agent pill pryč', !/metaAgentName/.test(js));
ok('git větev přes shell git rev-parse', /git rev-parse --abbrev-ref HEAD/.test(js));
ok('cache větve po rootu', /metaBranchCache\.root === root/.test(js));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
