// Run the existing H3 application on an internal port without changing its files.
// Fail closed when its known startup code changes instead of starting unguarded.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = process.argv[2];
const port = Number(process.env.FORGE_H3_INTERNAL_PORT);
if (!root || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw Error('Invalid guarded H3 configuration.');
}
const filename = path.join(root, 'server.js');
const source = fs.readFileSync(filename, 'utf8');
const oldDeclaration = 'const ROOT = __dirname, PORT = 8274;';
if (source.split(oldDeclaration).length !== 2) {
  throw Error('H3 startup code changed; the guarded service cannot start safely.');
}
const bodyCheck = 'let b;try{b=await body(req)}catch(e){return json(res,{error:e.message},400)}';
if (source.split(bodyCheck).length !== 2) {
  throw Error('H3 submission code changed; the guarded service cannot start safely.');
}
// H3 Studio always renders with sd-cli's fixed default seed (42). Forward an
// optional integer seed from the request so renders can differ or be repeated.
const rngArgs = "'--rng','cpu',";
if (source.split(rngArgs).length !== 2) {
  throw Error('H3 render arguments changed; the guarded service cannot start safely.');
}
// Forge's extra render options (first/last frame, reference clips, larger sizes, guidance, ...)
// are rewritten into the sd-cli arguments by runtime/h3_args.cjs just before the renderer
// starts. If H3's argument loop changed, requests that use them are refused instead of being
// rendered without them.
const referenceLoop = "for(const f of refs)args.push('--ref-image',f);";
const extended = source.split(referenceLoop).length === 2;
const extensionHook = extended
  ? `${referenceLoop}{const x=__forgeH3.extend(args,b,{refs,dir,id});if(x){fs.rmSync(dir,{recursive:true,force:true});return json(res,{error:x},400)}}`
  : referenceLoop;
const extensionCheck = extended
  ? '\n if(b&&b.forge!==undefined){const x=__forgeH3.check(b);if(x)return json(res,{error:x},400)}'
  : "\n if(b&&b.forge!==undefined)return json(res,{error:'This H3 Studio version cannot apply the new video options.'},400);";
const h3Args = path.join(__dirname, 'h3_args.cjs');
// Another request can finish uploading while this request awaits its body.
// Recheck synchronously before launching so only one renderer can be started.
const guardedSource = `const __forgeH3=require(${JSON.stringify(h3Args)});\n${source}`
  .replace(
    oldDeclaration,
    'const ROOT = __dirname, PORT = Number(process.env.FORGE_H3_INTERNAL_PORT);',
  )
  .replace(
    rngArgs,
    `${rngArgs}...(Number.isSafeInteger(b.seed)&&b.seed>=0&&b.seed<=2147483647?['--seed',String(b.seed)]:[]),`,
  )
  .replace(referenceLoop, () => extensionHook)
  .replace(
    bodyCheck,
    () =>
      `${bodyCheck}\n if(job && job.state==='running')return json(res,{error:'A video is already generating.'},409);${extensionCheck}`,
  );
const app = new Module(filename, module);
app.filename = filename;
app.paths = Module._nodeModulePaths(root);
// Let Forge ask whether this launcher understands the extra options (see h3_args.cjs).
const http = require('node:http');
const createServer = http.createServer;
http.createServer = function (...args) {
  const at = args.findIndex((value) => typeof value === 'function');
  if (at >= 0) {
    args[at] = require('./h3_args.cjs').withCapabilities(args[at]);
  }
  return createServer.apply(this, args);
};
try {
  app._compile(guardedSource, filename);
} finally {
  http.createServer = createServer;
}
