/* Test helperů opravených podle chyb z Error Log.txt (19:54 – 20:13). */
const fs = require('fs'), path = require('path'), vm = require('vm');

// ---- 1) tools.js: shellFileWriteGuard + preferredShellOrder + normalizeShell ----
const t = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tools.js'), 'utf8');
function grab(re) {
  const m = re.exec(t);
  if (!m) throw new Error('nenalezeno: ' + re);
  return m[0];
}
const ctx = { console, require, process, module: {}, exports: {}, Buffer, setTimeout, setInterval };
vm.createContext(ctx);
vm.runInContext(grab(/function shellFileWriteGuard[\s\S]*?\n}\n/), ctx);
vm.runInContext(grab(/const PS_ONLY = [\s\S]*?function preferredShellOrder[\s\S]*?\n}\n/), ctx);
vm.runInContext(grab(/function normalizeShell[\s\S]*?\n  \}\)\.join\('\'\);\n}\n/), ctx);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n); } };

console.log('--- 1) zapisovani souboru pres shell se odmitne ---');
const here = "powershell -NoProfile -Command \"$c = @'\n<!DOCTYPE html>\n<html>\n" + 'x'.repeat(12000) + "\n'@\"";
ok('PowerShell here-string (13 KB z logu) zamitnut', !!ctx.shellFileWriteGuard(here));
ok('kratky here-string taky zamitnut', !!ctx.shellFileWriteGuard("$c = @'\nhello\n'@"));
ok('Set-Content zamitnut', !!ctx.shellFileWriteGuard("Set-Content -Path a.txt -Value 'x'"));
ok('Out-File zamitnut', !!ctx.shellFileWriteGuard("out-file a.txt"));
ok('bash heredoc zamitnut', !!ctx.shellFileWriteGuard("cat > a.js <<'EOF'\ncode\nEOF"));
ok('dlouhy redirect zamitnut', !!ctx.shellFileWriteGuard('echo "' + 'x'.repeat(900) + '" > index.html'));
console.log('--- ... ale legitni prikazy projdou ---');
ok('dir /b src projdou', !ctx.shellFileWriteGuard('dir /b src 2>nul'));
ok('2>nul neni zamitnuto', !ctx.shellFileWriteGuard('tasklist /FI "IMAGENAME eq a.exe" & tasklist /FI "IMAGENAME eq b.exe"'));
ok('kratky redirect do logu projde', !ctx.shellFileWriteGuard('npm test > out.txt 2>&1'));
ok('git commit projdou', !ctx.shellFileWriteGuard('git add . & git commit -m "x"'));
ok('npm run dist projdou', !ctx.shellFileWriteGuard('npm run dist'));

console.log('--- 2) volba shell backendu podle dialektu ---');
ok('PowerShell syntax -> powershell first', ctx.preferredShellOrder('$env:COMSPEC; Get-ChildItem')[0] === 'powershell');
ok('cmd syntax -> cmd first', ctx.preferredShellOrder('if exist a.txt (echo yes) else (echo no)')[0] === 'cmd');
ok('cmd %VAR% -> cmd first', ctx.preferredShellOrder('echo %TEMP%')[0] === 'cmd');
ok('neznamy -> cmd first (default)', ctx.preferredShellOrder('node index.js')[0] === 'cmd');
ok('vsechny tri backendy vzdy zkusen', ctx.preferredShellOrder('$env:X').length === 3);

console.log('--- 3) normalizeShell: `;` musi jit na `&` pro cmd ---');
const n1 = ctx.normalizeShell('node -v; if exist node_modules\\electron-builder\\cli.js (echo ok) else (echo no)', false);
ok('`;` prelozeno na `&`', /node -v\s*&/.test(n1) && !/;\s*if exist/.test(n1));
ok('puvodni chyba "bad option -v;" zmizela', !/-v;/.test(n1));
console.log('      -> ' + n1);
const n2 = ctx.normalizeShell('$env:PATH; npm install', true);
ok('powershell (`light`) si `;` nechava', /\$env:PATH;\s*npm install/.test(n2));

console.log('--- 4) renderer: detekce zameru ---');
const src2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const rctx = { console, window: {}, document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(rctx);
const parts2 = [];
for (const re of [/const ACT_WORDS = [\s\S]*?\n/, /const ASK_WORDS = [\s\S]*?\n/, /const ASK_WORDS_CS = [\s\S]*?\n/,
  /const ASK_MID_CS = [\s\S]*?\n/, /const CONTINUE_WORDS = [\s\S]*?const WRITEISH_TOOLS = new Set\(\[[\s\S]*?\]\);/,
  /function convoDidWork[\s\S]*?return false;\n\}/, /function detectIntent[\s\S]*?return 'chat';\n\}/]) {
  const m = re.exec(src2);
  if (!m) throw new Error('renderer: nenalezeno ' + re);
  parts2.push(m[0]);
}
vm.runInContext(parts2.join('\n'), rctx);

ok('"bro je to furt stejný" -> build', rctx.detectIntent('bro je to furt stejný') === 'build');
ok('"zase to nefunguje" -> build', rctx.detectIntent('zase to nefunguje') === 'build');
ok('"pořád stejný" -> build', rctx.detectIntent('pořád stejný') === 'build');
ok('"dokonči to prosím" -> build', rctx.detectIntent('dokonči to prosím') === 'build');
ok('"try again" -> build', rctx.detectIntent('try again') === 'build');
ok('ciste "ahoj" -> chat', rctx.detectIntent('ahoj') === 'chat');
ok('ciste "co znamená 17" -> chat', rctx.detectIntent('co znamená 17') === 'chat');
ok('"jak opravit X?" -> build', rctx.detectIntent('jak opravit X?') === 'build');
ok('delsi zadani -> build', rctx.detectIntent('udelej mi kalkulacku ktera ma spoustu tlacidla a') === 'build');

console.log('--- 5) convoDidWork: krizove rozhodne o sadě nastroju ---');
const W = rctx.convoDidWork && (() => {
  // Set je lexikální, ne na window — zjistíme ho z funkce pres test chování
  return { has: (t) => rctx.convoDidWork({ messages: [{ role: 'tool', tool: t }] }) === true };
})();
ok('konverzace se zapisem -> true', rctx.convoDidWork({ messages: [{ role: 'tool', tool: 'write_file' }] }) === true);
ok('konverzace se shell -> true', rctx.convoDidWork({ messages: [{ role: 'tool', tool: 'shell' }] }) === true);
ok('konverzace jen se ctenim -> false', rctx.convoDidWork({ messages: [{ role: 'tool', tool: 'read_file' }] }) === false);
ok('prazdna konverzace -> false', rctx.convoDidWork({ messages: [] }) === false);
ok('preskoceny tool se nepocita', rctx.convoDidWork({ messages: [{ role: 'tool', tool: 'write_file', skipped: true }] }) === false);
ok('edit_file taky -> true', rctx.convoDidWork({ messages: [{ role: 'tool', tool: 'edit_file' }] }) === true);
ok('WRITEISH obsahuje shell', W.has('shell') && W.has('write_file') && W.has('env_install'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
