// Disposable service for exercising the force-stop UI without loading a model.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/status') {
    return res.end(JSON.stringify({ phase: 'ready', loaded: true }));
  }
  res.statusCode = 404;
  res.end('{}');
}).listen(7863, '127.0.0.1');
