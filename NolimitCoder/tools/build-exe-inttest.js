/* Plny integracni test build_exe proti Permr: inventura -> rebuild -> verifikace -> launch-test. */
const T = require('../src/main/tools.js');
(async () => {
  console.log('=== build_exe proti C:\\Users\\PAXI\\Downloads\\Permr ===');
  const t0 = Date.now();
  const r = await T.execTool({ tool: 'build_exe', args: {}, root: 'C:\\Users\\PAXI\\Downloads\\Permr', fullAccess: true });
  console.log('--- vysledek: ok=' + r.ok + ' (' + Math.round((Date.now() - t0) / 1000) + ' s) ---');
  console.log(r.output);
  process.exit(r.ok ? 0 : 1);
})().catch(e => { console.log('FATAL: ' + (e && e.message)); process.exit(2); });
