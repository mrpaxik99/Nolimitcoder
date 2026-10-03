/* Testy "dokonalost": %TEMP% expanze, backup guard, destruktivni shell, quote split, emoji summary. */
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const tsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(re) {
  const m = re.exec(tsrc);
  if (!m) throw new Error('tools.js: nenalezeno ' + re);
  return m[0];
}
const tctx = { console, require, process, module: {}, exports: {}, Buffer, setTimeout, os, fs, path, __dirname: path.join(__dirname, '..', 'src', 'main') };
vm.createContext(tctx);
for (const re of [/function expandEnvVars[\s\S]*?\n}\n/, /function backupJunkGuard[\s\S]*?\n}\n/,
  /function destructiveShellGuard[\s\S]*?\n}\n/, /function splitShellSegments[\s\S]*?\n}\n/,
  /function normalizeShell[\s\S]*?\n  \}\)\.join\(''\);\n}\n/, /function decodeConsole[\s\S]*?\n}\n/,
  /function guiTargetExists[\s\S]*?\n}\n/]) {
  vm.runInContext(grab(re), tctx);
}
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };

console.log('--- 1) expandEnvVars ---');
const realTmp = process.env.TEMP || process.env.TMP || os.tmpdir();
ok('%TEMP% expanduje', tctx.expandEnvVars('%TEMP%\\nolimitcoder\\x') === path.join(realTmp, 'nolimitcoder\\x') || tctx.expandEnvVars('%TEMP%/a') === realTmp + '/a');
ok('%temp% mala pismena', tctx.expandEnvVars('%temp%\\a').toLowerCase() === (realTmp + '\\a').toLowerCase());
ok('$env:TEMP expanduje', tctx.expandEnvVars('$env:TEMP\\a') === realTmp + '\\a');
ok('$HOME expanduje', tctx.expandEnvVars('$HOME/a') === os.homedir() + '/a');
ok('~ expanduje', tctx.expandEnvVars('~/a') === os.homedir() + '/a');
ok('nezname %FOO% zustane', tctx.expandEnvVars('%FOO_BAR_X%\\a') === '%FOO_BAR_X%\\a');
ok('obycejna cesta netknuta', tctx.expandEnvVars('src\\a.js') === 'src\\a.js');

console.log('--- 2) backupJunkGuard ---');
ok('.uibak blokovan', !!tctx.backupJunkGuard('C:\\p\\.uibak\\index.html'));
ok('.bak blokovan', !!tctx.backupJunkGuard('C:\\p\\.bak\\x'));
ok('xxx-backup blokovan', !!tctx.backupJunkGuard('C:\\p\\app-backup\\x.js'));
ok('xxx-old blokovan', !!tctx.backupJunkGuard('C:\\p\\app-old'));
ok('soubor .bak blokovan', !!tctx.backupJunkGuard('C:\\p\\index.html.bak'));
ok('soubor ~ blokovan', !!tctx.backupJunkGuard('C:\\p\\index.html~'));
ok('normalni index.html projde', !tctx.backupJunkGuard('C:\\p\\index.html'));
ok('src/ projde', !tctx.backupJunkGuard('C:\\p\\src\\a.js'));
ok('vendor/ projde', !tctx.backupJunkGuard('C:\\p\\vendor\\three.module.js'));
ok('dist/ projde', !tctx.backupJunkGuard('C:\\p\\dist\\App.exe'));

console.log('--- 3) destructiveShellGuard ---');
ok('rmdir /s /q %TEMP% blokovan', !!tctx.destructiveShellGuard('rmdir /s /q "%TEMP%" 2>nul'));
ok('rmdir /s /q C:\\Windows blokovan', !!tctx.destructiveShellGuard('rmdir /s /q C:\\Windows\\Temp'));
ok('del /s /q C:\\ blokovan', !!tctx.destructiveShellGuard('del /s /q C:\\*.*'));
ok('format blokovan', !!tctx.destructiveShellGuard('format D: /q'));
ok('format C: blokovan', !!tctx.destructiveShellGuard('cmd /c format C: /q'));
ok('Format-Volume blokovan', !!tctx.destructiveShellGuard('Format-Volume -DriveLetter D'));
// PowerShellský výpis a --format nesmějí spadnout pod zákaz formátování disku
ok('Format-List projde', !tctx.destructiveShellGuard('Get-Process | Where-Object {$_.Id -gt 0} | Format-List'));
ok('Format-Table projde', !tctx.destructiveShellGuard('Get-ChildItem . | Format-Table Name,Length'));
ok('--format projde', !tctx.destructiveShellGuard('yt-dlp --format bv* https://example.com/a'));
ok('bez /s /q projde', !tctx.destructiveShellGuard('rmdir projekt\\old'));
ok('npm run dist projde', !tctx.destructiveShellGuard('npm run dist'));
ok('dir projde', !tctx.destructiveShellGuard('dir /b src'));
ok('bez mazani projde', !tctx.destructiveShellGuard('copy /Y a b'));

console.log('--- 3b) guiTargetExists (%TEMP% expanze) ---');
const tmpExe = path.join(realTmp, 'nl-selftest-target.exe');
try { fs.writeFileSync(tmpExe, 'x'); } catch {}
ok('%TEMP% cesta existuje', tctx.guiTargetExists('%TEMP%\\nl-selftest-target.exe', realTmp) === true);
ok('%TEMP% cesta v uvozovkach existuje', tctx.guiTargetExists('"%TEMP%\\nl-selftest-target.exe"', realTmp) === true);
ok('neexistujici %TEMP% cesta false', tctx.guiTargetExists('%TEMP%\\nl-selftest-missing-xyz.exe', realTmp) === false);
ok('holé \\ je false', tctx.guiTargetExists('\\', realTmp) === false);
try { fs.rmSync(tmpExe, { force: true }); } catch {}

console.log('--- 4) splitShellSegments (quote-aware) ---');
const segs1 = tctx.splitShellSegments('node -e "const a=1;const b=2"');
ok('node -e s ; uvnitr se nedeli', segs1.length === 1);
const segs2 = tctx.splitShellSegments('node -v; if exist a (echo x)');
ok('; mimo uvozovky se deli', segs2.length === 3 && segs2[1] === ';');
const segs3 = tctx.splitShellSegments("echo 'a;b' && dir");
ok('single quotes chranene', segs3.filter(s => s === ';').length === 0 && segs3.includes('&&'));
const segs4 = tctx.splitShellSegments('echo "a && b"');
ok('&& uvnitr uvozovek se nedeli', !segs4.includes('&&'));

console.log('--- 5) normalizeShell end-to-end ---');
const nn1 = tctx.normalizeShell('node -e "const fs=require(\'fs\');const s=1"', false);
ok('node -e zustane cele (zadne &)', !nn1.includes('&const') && nn1.includes(';const'));
const nn2 = tctx.normalizeShell('node -v; if exist a (echo ok)', false);
ok('; mimo uvozovky -> &', /node -v&\s*if exist/.test(nn2));

console.log('--- 6) emoji summary (renderer) ---');
const rsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function rgrab(re) {
  const m = re.exec(rsrc);
  if (!m) throw new Error('renderer.js: nenalezeno ' + re);
  return m[0];
}
const rctx = { console };
vm.createContext(rctx);
for (const re of [/function publicErr[\s\S]*?\n}\n/, /function isWorkRequest[\s\S]*?\n}\n/]) vm.runInContext(rgrab(re), rctx);
// buildRunSummary: od zacatku funkce po dalsi komentar/funkci
const bStart = rsrc.indexOf('function buildRunSummary(');
const bEnd = rsrc.indexOf('/* Přesný tvar parametrů');
if (bStart < 0 || bEnd < 0) throw new Error('buildRunSummary nenalezena');
vm.runInContext(rsrc.slice(bStart, bEnd), rctx);
const S = rctx.buildRunSummary;
const W = [{ role: 'tool', tool: 'write_file', args: { path: 'C:\\p\\index.html' }, result: 'ok', ok: true },
  { role: 'tool', tool: 'shell', args: { command: 'npm run dist' }, result: 'ok', ok: true }];
const sOk = S(W, '', 'udelej mi kalkulacku');
ok('uspech zacina ✅ Hotovo', sOk.startsWith('✅ Hotovo!'));
ok('ma 📝 sekci', sOk.includes('📝'));
ok('ma ⚙️ sekci', sOk.includes('⚙️'));
ok('polozky pod sebe (•)', sOk.includes('• index.html') || sOk.includes('• p/index.html'));
ok('obsahuje pozadavek', sOk.includes('kalkulacku'));
const sBad = S([{ role: 'tool', tool: 'shell', args: { command: 'npm run dist' }, result: 'exit 1\nchyba: neco', ok: false }], '', 'udelej mi kalkulacku');
ok('chyba zacina ❌', sBad.startsWith('❌ Nedokončeno'));
ok('chyba ma ⚠️', sBad.includes('⚠️'));
ok('chyba ma 💡', sBad.includes('💡'));
const sRead = S([{ role: 'tool', tool: 'read_file', args: { path: 'a.js' }, result: 'x', ok: true }], '', 'oprav chybu v app');
ok('jen cteni zacina 🔍', sRead.startsWith('🔍'));
ok('jen cteni ma 👁️', sRead.includes('👁️'));
ok('prazdne -> prazdne', S([], '', 'ahoj') === '');

console.log('--- 7) skip-rebuild + lock handling (tools.js) ---');
ok('hashProjectState existuje', tsrc.includes('function hashProjectState'));
ok('isFileLocked existuje', tsrc.includes('function isFileLocked'));
ok('skip pri BEZE ZMENY', tsrc.includes('BEZE ZMENY'));
ok('stav se uklada (.nlc-build.json)', tsrc.includes('.nlc-build.json'));
ok('kill pred rebuildem', tsrc.includes('killNames') || tsrc.includes('killBeforeBuild'));
ok('retry pri zamku (bldAttempt)', tsrc.includes('bldAttempt'));
ok('lock probe pred rebuildem', tsrc.includes('lockProbe'));
ok('lokalni builder bin (.bin)', tsrc.includes('.bin') && tsrc.includes('electron-builder.cmd'));
ok('zadne hole npx (sileny major)', !/npx electron-builder/.test(tsrc));
ok('plny vystup do souboru (build-fail-)', tsrc.includes('build-fail-'));
ok('output vzdy dist (ne release)', tsrc.includes("directories.output ' + pkg.build.directories.output + ' -> dist") || tsrc.includes('directories.output -> dist'));
ok('manual build poznan (exe novejsi nez zdroje)', tsrc.includes('novejsi nez vsechny zdroje'));
// dist2 musi byt PRYC z produkce — jedina zbyla zminka je Mazani stareho dist2.
ok('zadne dist2 jako vystup (zadny outName, zadny output=dist2)', !/outName/.test(tsrc) && !/output\s*=\s*'dist2'/.test(tsrc) && !/output === 'dist2'/.test(tsrc));
ok('hash se pocita az po buildu (finalHash)', tsrc.includes('finalHash'));
ok('zamceny dist se odlozi stranou (ne dist2)', tsrc.includes('nlc-dist-aside') && tsrc.includes('nlc-dist-old'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
