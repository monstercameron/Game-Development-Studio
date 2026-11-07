import {EngineManager,engineDefinitions} from '../../runtime/engines.js';
import {fileURLToPath} from 'node:url';

const config=JSON.parse(process.env.FORGE_TEST_RECOVERY_CONFIG);
const id=config.id||'3d-trellis';
const original=engineDefinitions.find(item=>item.id===id);
const args=[...original.args],portIndex=args.indexOf('--port');args[portIndex+1]=String(config.port);
if(id==='images')args[args.indexOf('--engine-dir')+1]=fileURLToPath(new URL('./qwen-stub',import.meta.url));
const definition={...original,port:config.port,args,env:{...original.env,FORGE_RUNTIME_DIR:config.directory}};
const manager=new EngineManager({definitions:[definition],logDir:config.directory});
await manager.recoveryReady;
if(config.mode==='start'){
  const started=await manager.start(id);
  if(started.status!=='starting')throw Error(`Unexpected start status: ${started.status}`);
  const entry=manager.children.get(id);
  if(!await entry.binding)throw Error('Could not bind recovery identity.');
  process.send({type:'ready',pid:entry.record.pid});
}else{
  process.send({type:'ready',managed:manager.owns(id),recovered:!!manager.children.get(id)?.recovered});
}
process.on('message',async message=>{
  if(message?.type==='offload'){
    try{const result=await manager.offload(id);process.send({type:'offloaded',result})}
    catch(error){process.send({type:'offloaded',error:error.message})}
  }else if(message?.type==='shutdown'){
    manager.closed=true;await manager.recoveryLock?.release();process.exit(0);
  }
});
