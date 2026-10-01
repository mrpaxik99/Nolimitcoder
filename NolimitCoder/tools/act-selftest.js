/* Test logiky "model jen čte" — direktivy, auto-retry, vypnutí čtení. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };

console.log('--- direktivy existují a jsou silné ---');
ok('WRITE_DIRECTIVE_1 definována', /const WRITE_DIRECTIVE_1 = '\[Dost čtení/.test(src));
ok('WRITE_DIRECTIVE_2 definována', /const WRITE_DIRECTIVE_2 = '\[STOP\. Přestaň číst/.test(src));
ok('D1 říká přestat číst', /Žádné další read_file/.test(src));
ok('D2 �íká STOP', /Přestaň číst/.test(src));
ok('D2 hrozí selháním', /úloha selže/.test(src));

console.log('--- stav proměnných ---');
ok('writeDirectiveLevel deklarována', /let writeDirectiveLevel = 0/.test(src));
ok('autoRetried deklarována', /let autoRetried = false/.test(src));
ok('toolSet je let (lze měnit)', /let toolSet = \(effMode === 'build'\)/.test(src));

console.log('--- eskalace: 3 kola = direktiva 1 ---');
ok('staleRounds >= 3 → level 1', /staleRounds >= 3 && writeDirectiveLevel < 1/.test(src));
ok('level 1 pushne D1', /writeDirectiveLevel = 1;\s*\n\s*convo\.messages\.push\(\{ role: 'user', internal: true, content: WRITE_DIRECTIVE_1 \}\)/.test(src));

console.log('--- eskalace: 5 kola = direktiva 2 + vypnutí čtení ---');
ok('staleRounds >= 5 → level 2', /staleRounds >= 5 && writeDirectiveLevel < 2/.test(src));
ok('level 2 pushne D2', /writeDirectiveLevel = 2;\s*\n\s*convo\.messages\.push\(\{ role: 'user', internal: true, content: WRITE_DIRECTIVE_2 \}\)/.test(src));
ok('level 2 vypne čtecí nástroje', /toolSet = toolSet\.filter\(t => !\['read_file', 'list_dir', 'glob_file', 'file_info', 'search_files'\]/.test(src));

console.log('--- auto-retry místo mrtvého konce ---');
ok('auto-retry je v cyklu (continue)', /if \(!autoRetried && isWorkRequest\(lastUserText\(convo\)\)\) \{\s*\n\s*autoRetried = true;/.test(src));
ok('auto-retry resetuje rounds', /autoRetried = true;\s*\n\s*rounds = 0; staleRounds = 0; writeDirectiveLevel = 2;/.test(src));
ok('auto-retry vypne čtení', /toolSet = toolSet\.filter\(t => !\['read_file', 'list_dir', 'glob_file', 'file_info', 'search_files'\]/.test(src));
ok('auto-retry pushne D2', /convo\.messages\.push\(\{ role: 'user', internal: true, content: WRITE_DIRECTIVE_2 \}\);/.test(src));
ok('auto-retry pokračuje (continue)', /paintActivity\('Zkouším to znovu…'\);\s*\n\s*continue;/.test(src));
ok('auto-retry jen jednou', /!autoRetried/.test(src));

console.log('--- konec až po 7. koli (dříve 4) ---');
ok('stale-break až >= 7', /if \(staleRounds >= 7\)/.test(src));
ok('starý >= 4 je pryč', !/staleRounds >= 4/.test(src));

console.log('--- zpráva na konci (emoji) ---');
ok('uspech ma ✅ Hotovo', /✅ Hotovo!/.test(src));
ok('chyba ma ❌ Nedokončeno', /❌ Nedokončeno/.test(src));
ok('jen-cteni ma 🔍', /🔍 Prošel jsem kód, ale nic jsem nezapsal/.test(src));
ok('nevinuje uživatele', !/Zadej požadavek znovu nebo ho upřesni/.test(src));
ok('polozky pod sebe (•)', src.includes("'• ' + w"));

console.log('--- systémový prompt ---');
ok('agent-config.js je smazaný', !fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'agent-config.js')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
