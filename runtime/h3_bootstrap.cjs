// Run the existing H3 application on an internal port without changing its files.
// Fail closed when its known startup code changes instead of starting unguarded.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = process.argv[2];
const port = Number(process.env.FORGE_H3_INTERNAL_PORT);
if (!root || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid guarded H3 configuration.');
const filename = path.join(root, 'server.js');
const source = fs.readFileSync(filename, 'utf8');
const oldDeclaration = 'const ROOT = __dirname, PORT = 8274;';
if (source.split(oldDeclaration).length !== 2) throw Error('H3 startup code changed; the guarded service cannot start safely.');
const bodyCheck = "let b;try{b=await body(req)}catch(e){return json(res,{error:e.message},400)}";
if (source.split(bodyCheck).length !== 2) throw Error('H3 submission code changed; the guarded service cannot start safely.');
// Another request can finish uploading while this request awaits its body.
// Recheck synchronously before launching so only one renderer can be started.
const guardedSource = source
  .replace(oldDeclaration, 'const ROOT = __dirname, PORT = Number(process.env.FORGE_H3_INTERNAL_PORT);')
  .replace(bodyCheck, `${bodyCheck}\n if(job && job.state==='running')return json(res,{error:'A video is already generating.'},409);`);
const app = new Module(filename, module);
app.filename = filename;
app.paths = Module._nodeModulePaths(root);
app._compile(guardedSource, filename);
