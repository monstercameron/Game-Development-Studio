// The HTTP host forwards engine operations without owning engine processes.
export class EngineBroker {
  constructor(){
    this.nextId=0;this.pending=new Map();
    process.on('message',message=>{
      if(message?.type!=='engine_reply')return;
      const pending=this.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.result);
    });
    process.on('disconnect',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Engine supervisor disconnected.'))}this.pending.clear()});
  }
  call(method,params){
    if(!process.connected)return Promise.reject(new Error('Engine supervisor is unavailable.'));
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Engine supervisor request timed out.'))},method==='forceStop'?55000:32000);
      this.pending.set(id,{resolve,reject,timer});
      process.send({type:'engine_request',id,method,params},error=>{if(error&&this.pending.has(id)){clearTimeout(timer);this.pending.delete(id);reject(error)}});
    });
  }
}
