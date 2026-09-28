// NolimitCoder elevated helper: runs as administrator (launched via UAC),
// connects back to the app via a pipe and executes shell commands without further prompts.
// No window, no single-instance lock, exits when the pipe breaks.
const net = require('net');

function send(sock, obj) {
  try { sock.write(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') + '\n'); } catch {}
}

function run(pipeName) {
  const T = require('./tools');
  let buf = '';
  const sock = net.connect(pipeName);
  sock.on('connect', () => {
    send(sock, { hello: true, pid: process.pid });
  });
  sock.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8')); } catch { continue; }
      if (!msg || msg.id === undefined) continue;
      try {
        const r = await T.runCmd(String(msg.cmd || ''), String(msg.cwd || process.cwd()), Math.min(Math.max(parseInt(msg.timeout) || 120000, 1000), 900000));
        send(sock, { id: msg.id, ok: r.ok, output: r.output });
      } catch (e) {
        send(sock, { id: msg.id, ok: false, output: 'Helper error: ' + (e.message || e) });
      }
    }
  });
  const die = () => { try { process.exit(0); } catch {} };
  sock.on('close', () => setTimeout(die, 1000));
  sock.on('error', () => {});
  // safety valve: if nobody responds within 60 s (dead pipe), exit
  let alive = false;
  sock.on('connect', () => { alive = true; });
  setTimeout(() => { if (!alive) die(); }, 60000);
}

module.exports = { run };
