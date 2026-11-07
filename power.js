import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function powerService() {
  let child = null, starting = null, lastError = null;
  const script = fileURLToPath(new URL('./keep-awake.ps1', import.meta.url));
  function stop() { if (child) { child.kill(); child = null; } }
  async function start() {
    if (child) return;
    if (starting) return starting;
    if (process.platform !== 'win32') throw new Error('Keep awake is available on Windows only.');
    starting = new Promise((resolve, reject) => {
      const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false, errors = '';
      const timer = setTimeout(() => fail('The keep-awake helper did not respond.'), 10000);
      function fail(message) { if (settled) return; settled = true; clearTimeout(timer); helper.kill(); lastError = message; reject(new Error(message)); }
      helper.stderr.on('data', data => { errors += data.toString(); });
      helper.stdout.on('data', data => {
        if (!settled && data.toString().includes('READY')) { settled = true; clearTimeout(timer); child = helper; lastError = null; resolve(); }
      });
      helper.on('error', error => fail(error.message));
      helper.on('exit', () => {
        if (!settled) fail(errors.trim() || 'The keep-awake helper exited.');
        else if (child === helper) { child = null; lastError = errors.trim() || 'The keep-awake helper stopped.'; }
      });
    }).finally(() => { starting = null; });
    return starting;
  }
  function attach(server) {
    server.middlewares.use('/api/power', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') { res.end(JSON.stringify({ awake: !!child, error: lastError })); return; }
      const origin = req.headers.origin, host = req.headers.host;
      const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '');
      if (req.method !== 'POST' || !localHost || origin !== `http://${host}` || req.headers['x-forge-request'] !== 'power') { res.statusCode = 403; res.end(JSON.stringify({ error: 'Local studio requests only.' })); return; }
      try {
        let body = '';for await (const chunk of req) { body += chunk; if (body.length > 1000) throw new Error('Request too large.'); }
        const input = JSON.parse(body);if (typeof input.enabled !== 'boolean') throw new Error('Expected an enabled setting.');
        if (input.enabled) await start(); else { if (starting) await starting; stop(); lastError = null; }
        res.end(JSON.stringify({ awake: !!child, error: lastError }));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    server.httpServer?.once('close', stop);
  }
  process.once('exit', stop);
  return { name: 'forge-power-service', configureServer: attach, configurePreviewServer: attach };
}
