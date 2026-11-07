import http from 'node:http';
let busy = false;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/busy') {
      busy = true;
      return res.end('{}');
    }
    if (req.url === '/idle') {
      busy = false;
      return res.end('{}');
    }
    if (req.url === '/api/status') {
      return res.end(JSON.stringify({ phase: busy ? 'generating' : 'ready', loaded: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  })
  .listen(Number(process.argv[2]), '127.0.0.1');
