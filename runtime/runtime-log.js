import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultDirectory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.forge-runtime');

// A slow or failed disk must not stall inference or grow an unbounded queue.
// Lost output is counted, so diagnostics never silently implies a complete log.
export function createRuntimeLog({directory=process.env.FORGE_RUNTIME_DIR||defaultDirectory}={}){
  let stream=null,blocked=false,dropped=0,closed=false;
  try{
    fs.mkdirSync(directory,{recursive:true});
    stream=fs.createWriteStream(path.join(directory,'runtime-worker.log'),{flags:'a',highWaterMark:256*1024});
    stream.on('error',error=>{stream=null;console.error(`Runtime log unavailable: ${error.message}`)});
    stream.on('drain',()=>{
      blocked=false;
      if(dropped&&stream&&!closed){const lost=dropped;dropped=0;blocked=!stream.write(`\n${new Date().toISOString()} WARN Runtime log dropped ${lost} bytes while storage was slow.\n`)}
    });
  }catch(error){console.error(`Runtime log unavailable: ${error.message}`)}
  return {
    write(level,message,raw=false){
      if(closed)return;
      const data=raw?message:`${new Date().toISOString()} ${level} ${message}\n`;
      if(!stream){process.stderr.write(data);return}
      if(blocked){dropped+=Buffer.byteLength(data);return}
      blocked=!stream.write(data);
    },
    close(){if(closed)return;closed=true;stream?.end()},
  };
}
