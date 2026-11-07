import { fork } from 'node:child_process';

// Owns the HTTP host but not the engines, whose handles remain in the parent.
export class HostSupervisor {
  constructor({port,engines,log=console.error,onStopped=()=>{},onFatal=()=>{},
    forkHost=fork,hostUrl=new URL('./http-server.js',import.meta.url),env=process.env,restartDelay=250}={}){
    this.port=port;this.engines=engines;this.log=log;this.onStopped=onStopped;this.onFatal=onFatal;
    this.forkHost=forkHost;this.hostUrl=hostUrl;this.env=env;this.restartDelay=restartDelay;
    this.child=null;this.timer=null;this.stopTimer=null;this.stopping=false;this.finished=false;this.failures=0;
  }
  scheduleRestart(started,reason){
    if(this.stopping||this.finished)return;
    this.failures=(Date.now()-started>30000?0:this.failures)+1;
    const delay=Math.min(this.restartDelay*2**Math.min(this.failures-1,6),10000);
    this.log(`Forge HTTP host ${reason}; restarting in ${delay} ms.`);
    this.timer=setTimeout(()=>{this.timer=null;this.start()},delay);
  }
  hostStopped(host,started,code,signal){
    if(this.child!==host)return;
    this.child=null;
    if(this.stopping){this.finishStop();return}
    if(code===78){this.finished=true;this.log('Forge cannot start. Resolve the startup error and try again.');this.onFatal();return}
    this.scheduleRestart(started,`exited (${code??signal??'spawn failed'})`);
  }
  start(){
    if(this.stopping||this.finished||this.child||this.timer)return;
    const started=Date.now();let host;
    try{host=this.forkHost(this.hostUrl,[String(this.port)],{execArgv:[],env:{...this.env,FORGE_SERVICE_SUPERVISOR_PID:String(process.pid),FORGE_ENGINE_BROKER:'1'},stdio:['ignore','inherit','inherit','ipc'],windowsHide:true})}
    catch(error){this.log(`Forge HTTP host error: ${error.message}`);this.scheduleRestart(started,'could not start');return}
    this.child=host;
    host.on('message',message=>{
      if(message?.type!=='engine_request')return;
      const reply=(result,error)=>{if(host.connected)host.send({type:'engine_reply',id:message.id,result,error},()=>{})};
      const allowed={status:()=>this.engines.status(),speechActivity:()=>this.engines.speechActivity(),gameActivity:()=>this.engines.gameActivity(),requestGameLoad:()=>this.engines.requestGameLoad(),start:()=>this.engines.start(message.params?.id,message.params?.options),startAll:()=>this.engines.startAll(),offload:()=>this.engines.offload(message.params?.id),forceStop:()=>this.engines.forceStop(message.params?.id),removeModel:()=>this.engines.removeModel(message.params?.id,message.params?.retry===true)};
      if(!Object.hasOwn(allowed,message.method)){reply(undefined,'Unknown engine operation.');return}
      Promise.resolve().then(allowed[message.method]).then(result=>reply(result,undefined),error=>reply(undefined,error.message));
    });
    host.on('error',error=>{this.log(`Forge HTTP host error: ${error.message}`);if(host.pid==null)this.hostStopped(host,started,null,null)});
    host.once('exit',(code,signal)=>this.hostStopped(host,started,code,signal));
  }
  finishStop(){
    if(this.finished)return;
    this.finished=true;clearTimeout(this.stopTimer);this.onStopped();
  }
  stop(){
    if(this.stopping||this.finished)return;
    this.stopping=true;clearTimeout(this.timer);this.timer=null;
    const host=this.child;if(!host){this.finishStop();return}
    try{if(host.connected)host.send({type:'shutdown'},()=>{})}catch{}
    this.stopTimer=setTimeout(()=>{host.kill();this.finishStop()},5000);this.stopTimer.unref();
  }
}
