/* Overeni, ze Electron main proces umi cist app.asar pres fs (pro build_exe verifikaci). */
const fs = require('fs'), path = require('path');
const asar = 'C:\\Users\\PAXI\\Downloads\\Permr\\dist\\win-unpacked\\resources\\app.asar';
console.log('electron:', !!(process.versions && process.versions.electron));
console.log('asar existuje:', fs.existsSync(asar));
for (const f of ['package.json', 'main.js', 'index.html', 'styles.css', 'calc-engine.js', 'app.js', 'preload.js']) {
  let ok = false;
  try { ok = fs.existsSync(path.join(asar, f)); } catch (e) { ok = 'ERR ' + e.message; }
  console.log('  ' + f + ': ' + ok);
}
try {
  const files = fs.readdirSync(asar);
  console.log('root asar:', files.slice(0, 20).join(', '));
} catch (e) { console.log('readdir ERR: ' + e.message); }
process.exit(0);
