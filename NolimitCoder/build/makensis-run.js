// Builds the FULL CUSTOM dark installer with makensis (no MUI).
// Usage: node build/makensis-run.js   (run "npm run build:app" first)
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function findMakensis() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis');
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'makensis.exe');
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  } catch {}
  throw new Error('makensis.exe not found in electron-builder cache (' + base + ')');
}

const makensis = findMakensis();
const srcDir = path.join(root, 'dist', 'win-unpacked');
if (!fs.existsSync(path.join(srcDir, 'resources', 'app.asar'))) {
  console.error('win-unpacked missing — run "npm run build:app" first');
  process.exit(1);
}

const args = ['/V3',
  '/DAPP_VERSION=' + pkg.version,
  '/DSRC_DIR=' + srcDir,
  '/DOUT_FILE=' + path.join(root, 'dist', 'NolimitCoder V4 Setup.exe'),
  '/DLICENSE_FILE=' + path.join(root, 'build', 'license.txt'),
  '/DLOGO_ICO=' + path.join(root, 'build', 'welcome-logo.ico'),
  '/DAPP_ICON=' + path.join(root, 'src', 'renderer', 'assets', 'icon.ico'),
  '/DAPP_EXE=NolimitCoder V3.exe',
  path.join(root, 'build', 'custom-setup.nsi')];
console.log('makensis: ' + makensis);
execFileSync(makensis, args, { stdio: 'inherit' });
console.log('CUSTOM INSTALLER OK');
