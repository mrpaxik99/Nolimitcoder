/* Unit test build_exe helperu (bez buildu). */
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(re) {
  const m = re.exec(src);
  if (!m) throw new Error('nenalezeno: ' + re);
  return m[0];
}
const ctx = { console, require, process, module: {}, exports: {}, Buffer, setTimeout, setInterval, __dirname: path.join(__dirname, '..', 'src', 'main') };
vm.createContext(ctx);
for (const re of [/function collectHtmlRefs[\s\S]*?\n}\n/, /function findHtmlDuplicates[\s\S]*?\n}\n/]) {
  vm.runInContext(grab(re), ctx);
}
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };

console.log('--- collectHtmlRefs na realnem projektu ---');
const sampleHtml = '<!DOCTYPE html><html><head>'
  + '<link rel="stylesheet" href="styles.css">'
  + '<script src="calc-engine.js"></script>'
  + '<script src="calc-engine.js"></script>'
  + '<script src="app.js"></script></head>'
  + '<body><img src="assets/logo.png"><style>.a{background:url(bg.png)}</style></body></html>';
const refs = ctx.collectHtmlRefs(sampleHtml);
console.log('      refs:', refs.join(', '));
ok('najde styles.css', refs.includes('styles.css'));
ok('najde calc-engine.js', refs.includes('calc-engine.js'));
ok('najde app.js', refs.includes('app.js'));
ok('najde img src', refs.includes('assets/logo.png'));
ok('najde css url', refs.includes('bg.png'));
ok('bez duplikatu v refs', refs.length === new Set(refs).size);

console.log('--- findHtmlDuplicates ---');
const dups = ctx.findHtmlDuplicates(sampleHtml);
console.log('      dups:', dups.join(', '));
ok('odhalí duplicitní calc-engine.js', dups.includes('calc-engine.js'));

console.log('--- Kalkulacka/index.html (vse inline) ---');
let kRefs = null;
try {
  const kHtml = fs.readFileSync('C:\\Users\\PAXI\\Downloads\\Kalkulačka\\index.html', 'utf8');
  kRefs = ctx.collectHtmlRefs(kHtml);
  ok('zadne lokalni refy', kRefs.length === 0);
} catch { console.log('(projekt neni k dispozici - preskoceno)'); }

console.log('--- edge cases ---');
ok('http se ignoruje', ctx.collectHtmlRefs('<script src="https://x.com/a.js"></script>').length === 0);
ok('data: se ignoruje', ctx.collectHtmlRefs('<img src="data:image/png;base64,xx">').length === 0);
ok('css url() se najde', ctx.collectHtmlRefs('<style>.a{background:url(bg.png)}</style>').includes('bg.png'));
ok('query string se oř�zne', ctx.collectHtmlRefs('<script src="a.js?v=2"></script>').includes('a.js'));
ok('./ prefix se normalizuje', ctx.collectHtmlRefs('<script src="./a.js"></script>').includes('a.js'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
