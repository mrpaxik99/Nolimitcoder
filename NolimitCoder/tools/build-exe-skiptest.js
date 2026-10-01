/* Overeni skip-rebuildu na Kalkulacce: 1. beh buildi, 2. beh musi skoncit za par sekund. */
const T = require('../src/main/tools.js');
const ROOT = 'C:\\Users\\PAXI\\Downloads\\Kalkulačka';
(async () => {
  console.log('=== beh 1 (plny rebuild) ===');
  let t0 = Date.now();
  const r1 = await T.execTool({ tool: 'build_exe', args: {}, root: ROOT, fullAccess: true });
  console.log('ok=' + r1.ok + ' cas=' + Math.round((Date.now() - t0) / 1000) + 's');
  console.log(r1.output.split('\n').slice(-4).join('\n'));
  if (!r1.ok) { console.log('BEH1 SELHAL'); process.exit(1); }
  console.log('');
  console.log('=== beh 2 (musi preskocit) ===');
  t0 = Date.now();
  const r2 = await T.execTool({ tool: 'build_exe', args: {}, root: ROOT, fullAccess: true });
  const s2 = Math.round((Date.now() - t0) / 1000);
  console.log('ok=' + r2.ok + ' cas=' + s2 + 's');
  console.log(r2.output);
  const skipped = /BEZE ZMENY|bez rebuildu/i.test(r2.output);
  console.log('');
  console.log(skipped && s2 < 30 ? 'SKIP-FUNKCE OK' : 'SKIP-FUNKCE SELHALA');
  process.exit(skipped && s2 < 30 ? 0 : 1);
})().catch(e => { console.log('FATAL: ' + (e && e.message)); process.exit(2); });
