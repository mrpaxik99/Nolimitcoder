/* Test detekce useknutého obsahu (truncatedCodeReason + write_file).
   Opraveno podle Error Logu 1. 10. 2026 — původní verze hlásila useknutí
   i na HOTOVÝCH souborech (HTML končící </html>, JS s komentáři), AI pak
   přepisovala celé soubory nanovo a Error Log se plnil jejich obsahem. */
const fs = require('fs');
const path = require('path');
const T = require(path.join(__dirname, '..', 'src', 'main', 'tools.js'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };
const reason = (file, content) => T.truncatedCodeReason(content, file);

// ---- 1) HOTOVÉ soubory: žádný falešný poplach ----
console.log('--- 1) hotove soubory se NEhlasi ---');
const html = '<!DOCTYPE html>\n<html lang="cs">\n<head><title>X</title></head>\n<body>\n'
  + '  <div class="stage" id="stage">\n    <span class="brand">AURA<b>3D</b></span>\n'
  + '    <p>Text s (zavorkou) a \'apostrofem\'.</p>\n  </div>\n'
  + '  <script src="src/app.js"></script>\n</body>\n</html>\n';
ok('HTML koncici </html> (drive useknute)', reason('index.html', html) === '');
ok('HTML uprostred textu (posledni znak neni >)', reason('a.html', '<div class="x">text') === '');
const js = "// don't panic\n/* vice ' radku */\nconst a = 1;\n\nfunction f(x) {\n  // trida ma byt hotova\n  return x * 2;\n}\n\nconsole.log(f(a));\n";
ok('JS s komentari a apostrofy', reason('app.js', js) === '');
ok('JS bez stredniku na konci', reason('a.js', 'const el = document.querySelector(".x")\nel.classList.add("ready")') === '');
ok('JS s regexem a delenim', reason('a.js', 'const r = /ab[()c]+/g\nconst d = 10 / 2 / 1\n') === '');
ok('sablona ${…} zavrena', reason('a.js', 'const s = `ahoj ${1 + 2} svete`\n') === '');
ok('CSS s protocol-relative url', reason('a.css', '.a { background: url(//cdn.x/p.png); }') === '');
ok('SCSS komentar s apostrofem', reason('a.scss', ".a {\n  color: red; // don't\n}\n") === '');
ok('JSON', reason('a.json', '{"a": 1, "b": [1, 2]}') === '');
ok('Markdown (drive useknute)', reason('README.md', '# Nadpis\n\nText s (nevyvazenou zavorkou a <div tagem.\n') === '');
ok('Python s docstringem', reason('a.py', '"""Docstring ( zavorkou."""\ndef f():\n    return 1\n') === '');

// ---- 2) USEKNUTÉ soubory: musí se chytit ----
console.log('--- 2) useknute soubory se zachyti ---');
ok('HTML useknute uprostred znacky', !!reason('index.html', html.slice(0, html.indexOf('<script') + 5)));
ok('HTML bez uzavreni </html> v polovine', !!reason('index.html', html.slice(0, Math.floor(html.length * 0.6))));
ok('HTML s neuzavrenym <script>', !!reason('index.html', html.replace('</script>', '')));
ok('HTML s neuzavrenym komentarem', !!reason('index.html', html + '<!-- dalsi'));
ok('JS useknuta zavora', !!reason('a.js', 'function f(a) {\n  return a +'));
ok('JS useknuty retezec', !!reason('a.js', 'const a = "text se usekl'));
ok('JS useknuta sablona', !!reason('a.js', 'const a = `text se usekl'));
ok('JS useknuty if bez zavorek', !!reason('a.js', 'const a = 1\nif (a'));
ok('CSS useknute uprostred pravidla', !!reason('a.css', '.a {\n  color: red;'));
ok('JSON useknuty', !!reason('a.json', '{"a": 1, "b": [1, 2'));
ok('Python useknuta zavora', !!reason('a.py', 'def f():\n    return 1\n\nx = f('));
ok('prazdny obsah', reason('a.js', '   ') === 'prázdný obsah');

// ---- 3) write_file: useknutý obsah nesmí přepsat hotový soubor ----
console.log('--- 3) write_file chrani existujici soubor ---');
const root = path.join(require('os').tmpdir(), 'nlc-trunc-selftest');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
(async () => {
  const good = html;
  let r = await T.execTool({ tool: 'write_file', args: { path: 'index.html', content: good }, root, fullAccess: true });
  ok('kompletni obsah -> ok', r.ok === true);
  r = await T.execTool({ tool: 'write_file', args: { path: 'index.html', content: good.slice(0, 40) }, root, fullAccess: true });
  ok('useknute pres existujici -> odmitnuto', r.ok === false);
  ok('puvodni soubor zustal zachovan', fs.readFileSync(path.join(root, 'index.html'), 'utf8') === good);
  r = await T.execTool({ tool: 'write_file', args: { path: 'novy.js', content: 'function f(a) {\n  return a +' }, root, fullAccess: true });
  ok('useknute NOVEHO souboru -> varovani, soubor vznikne', r.ok === false && fs.existsSync(path.join(root, 'novy.js')));
  ok('hlaska rika duvod', /NEDOKONČENÝ/.test(String(r.output || '')));
  fs.rmSync(root, { recursive: true, force: true });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
