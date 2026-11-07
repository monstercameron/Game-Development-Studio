import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {EngineManager} from '../runtime/engines.js';
import {createRecoverService} from '../runtime/recover-service.js';
import {createHunyuanPreparation} from '../runtime/hunyuan-preparation.js';
import {createHyMotionPreparation} from '../runtime/hymotion-preparation.js';
import {createMotionBricksPreparation} from '../runtime/motionbricks-preparation.js';
import {createSam31Preparation} from '../runtime/sam31-preparation.js';
import {createTtsPreparation} from '../runtime/tts-preparation.js';
import {createServicePreparation} from '../runtime/service-preparation.js';
import {createAsrStarter} from '../runtime/asr-preparation.js';

function managerFixture(){
  const definition={id:'3d-trellis',quiesce:'trellis-v1',port:8285};
  const manager=Object.create(EngineManager.prototype);
  Object.assign(manager,{definitions:[definition],recoveryDefinitions:new Map([[definition.id,definition]]),recoveryStates:new Map([[definition.id,'recovered']]),recoveryLock:{held:true},
    children:new Map(),closed:false,log:()=>{}});
  return {manager,definition};
}

test('a managed TRELLIS worker cannot be offloaded after the ownership lock is lost',async()=>{
  const {manager}=managerFixture();
  manager.children.set('3d-trellis',{child:{pid:42,exitCode:null,killed:false},record:{},controlToken:'token',stopping:false});
  manager.recoveryLock.held=false;manager.recoveryStates.set('3d-trellis','unresolved');
  assert.equal(manager.canOffload('3d-trellis'),false);
  await assert.rejects(manager.offload('3d-trellis'),/cannot|ownership/i);
});

test('late recovery attaches the authenticated journal record to the existing worker',async()=>{
  const {manager,definition}=managerFixture();
  const record={id:'3d-trellis',nonce:'a'.repeat(64),token:'b'.repeat(64)};
  const entry={child:{pid:41,exitCode:null,killed:false},nonce:record.nonce,controlToken:record.token,binding:Promise.resolve(false),stopping:false};
  manager.children.set('3d-trellis',entry);
  manager.recovery={reconcile:async()=>({state:'recovered',record,process:{verified:true,pid:42}})};
  await manager.reconcileRecovery(definition);
  assert.equal(entry.record,record);
});

test('an unknown recovered-worker stop result remains reconcilable',async()=>{
  const {manager,definition}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{},controlToken:'token',recovered:true,stopping:false};
  manager.children.set('3d-trellis',entry);
  manager.recovery={check:async()=>({verified:true})};
  let monitorCalls=0;manager.monitorRecovered=()=>{monitorCalls++};
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Connection dropped')};
  try{await assert.rejects(manager.stopRecoveredEngine(entry,definition,'3d-trellis'),/unknown/i)}finally{globalThis.fetch=oldFetch}
  assert.ok(!entry.stopping||monitorCalls>0,'an indeterminate stop must not permanently disable both retry and monitoring');
});

test('an unknown stop for a newly spawned guarded worker remains reconcilable', {timeout:5000}, async()=>{
  const {manager,definition}=managerFixture();
  const child=Object.assign(new EventEmitter(),{pid:42,exitCode:null,killed:false});
  const entry={child,record:{nonce:'a'.repeat(64)},controlToken:'token',stopping:false};
  manager.children.set(definition.id,entry);
  let monitorCalls=0;manager.monitorRecovered=()=>{monitorCalls++};
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Connection dropped')};
  try{await assert.rejects(manager.stopGuardedEngine(entry,definition,definition.id),/verify|unknown/i)}finally{globalThis.fetch=oldFetch}
  assert.ok(!entry.stopping||monitorCalls>0,'an indeterminate stop must not permanently disable both retry and monitoring');
});

test('an unknown stop resumes only an authenticated worker that is still alive',async()=>{
  const {manager,definition}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:true,stopUnknown:true};
  manager.children.set(definition.id,entry);manager.recoveryStates.set(definition.id,'unresolved');
  manager.recovery={alive:async()=> 'alive',check:async()=>({verified:true})};
  let requests=0;const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{requests++;assert.match(url,/\/api\/forge\/resume$/);assert.equal(options.headers['X-Forge-Engine-Token'],'token');return {ok:true,json:async()=>({resumed:true})}};
  try{await manager.reconcileUnknownStop(entry,definition)}finally{globalThis.fetch=oldFetch}
  assert.equal(requests,1);assert.equal(entry.stopping,false);assert.equal(entry.stopUnknown,false);
  assert.equal(manager.recoveryStates.get(definition.id),'recovered');
});

test('an unknown stop does not resume a worker that fails the identity challenge',async()=>{
  const {manager,definition}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:true,stopUnknown:true};
  manager.children.set(definition.id,entry);manager.recoveryStates.set(definition.id,'unresolved');
  manager.recovery={alive:async()=> 'alive',check:async()=>({verified:false})};
  let requests=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw Error('Must not send')};
  try{await manager.reconcileUnknownStop(entry,definition)}finally{globalThis.fetch=oldFetch}
  assert.equal(requests,0);assert.equal(entry.stopping,true);assert.equal(entry.stopUnknown,true);
  assert.equal(manager.recoveryStates.get(definition.id),'unresolved');
});

test('an unknown stop clears a confirmed exited worker, but fences indeterminate liveness',async()=>{
  const {manager,definition}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:true,stopUnknown:true};
  manager.children.set(definition.id,entry);manager.recoveryStates.set(definition.id,'unresolved');
  let state='indeterminate',clears=0,checks=0;
  manager.recovery={alive:async()=>state,check:async()=>{checks++;return {verified:true}},journal:{clear:async(id,nonce)=>{assert.equal(id,definition.id);assert.equal(nonce,entry.record.nonce);clears++;return true}}};
  await manager.reconcileUnknownStop(entry,definition);
  assert.equal(manager.children.get(definition.id),entry);assert.equal(entry.stopping,true);
  assert.equal(manager.recoveryStates.get(definition.id),'unresolved');assert.equal(clears,0);assert.equal(checks,0);
  state='exited_or_reused';await manager.reconcileUnknownStop(entry,definition);
  assert.equal(clears,1);assert.equal(manager.children.has(definition.id),false);
  assert.equal(manager.recoveryStates.get(definition.id),'none');
});

test('losing the ownership lock during liveness probing keeps an unknown stop fenced',async()=>{
  const {manager,definition}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:true,stopUnknown:true};
  manager.children.set(definition.id,entry);manager.recoveryStates.set(definition.id,'unresolved');
  let finish;const gate=new Promise(resolve=>{finish=resolve});let clears=0;
  manager.recovery={alive:async()=>{await gate;return 'exited_or_reused'},journal:{clear:async()=>{clears++}}};
  const pending=manager.reconcileUnknownStop(entry,definition);manager.recoveryLock.held=false;finish();await pending;
  assert.equal(clears,0);assert.equal(manager.children.get(definition.id),entry);assert.equal(entry.stopping,true);
});

test('concurrent offloads do not send two stop requests while identity is being verified',async()=>{
  const {manager}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:false};
  manager.children.set('3d-trellis',entry);
  let release;const gate=new Promise(resolve=>{release=resolve});let checks=0,stops=0;
  manager.recovery={check:async()=>{checks++;await gate;return {verified:true}},alive:async()=> 'exited_or_reused',journal:{clear:async()=>true}};
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{stops++;return {ok:true,status:200,json:async()=>({stopping:true})}};
  try{
    const outcomes=Promise.allSettled([manager.offload('3d-trellis'),manager.offload('3d-trellis')]);
    await new Promise(resolve=>setImmediate(resolve));release();
    await outcomes;
    assert.equal(stops,1);assert.equal(checks,1);
  }finally{release();globalThis.fetch=oldFetch}
});

test('a lost ownership lock during verification prevents the stop request',async()=>{
  const {manager}=managerFixture();
  const entry={child:{pid:42,exitCode:null,killed:false},record:{nonce:'a'.repeat(64)},controlToken:'token',recovered:true,stopping:false};
  manager.children.set('3d-trellis',entry);
  let release;const gate=new Promise(resolve=>{release=resolve});manager.recovery={check:async()=>{await gate;return {verified:true}}};
  let stops=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{stops++;throw Error('Must not send')};
  try{
    const result=assert.rejects(manager.offload('3d-trellis'),/ownership/i);
    await new Promise(resolve=>setImmediate(resolve));manager.recoveryLock.held=false;release();await result;
    assert.equal(stops,0);
  }finally{release();globalThis.fetch=oldFetch}
});

test('unresolved ownership is surfaced instead of endlessly starting or reconnecting a worker',async()=>{
  const startEngine=async()=>({status:'recovery_unresolved',message:'Previous worker cannot be verified.'});
  const recovery=createRecoverService({env:{},startEngine});
  for(const type of ['trellis','3d','motion','motion-bricks','segmentation','voices']){
    const result=await recovery(type);
    assert.equal(result?.status,'needs_attention',type);assert.match(result.error,/cannot be verified/);
  }
  const factories=[createHunyuanPreparation,createHyMotionPreparation,createMotionBricksPreparation,createSam31Preparation,createTtsPreparation];
  for(const factory of factories){
    const prepare=factory({startEngine,loadModel:async()=>{throw Error('Not expected')}});
    const result=await prepare({reachable:false,health:null,claimLoad:()=>true});
    assert.equal(result?.status,'needs_attention',factory.name);assert.match(result.error,/cannot be verified/);
  }
  const images=createServicePreparation({startEngine,autoStart:()=>true});
  assert.equal((await images({type:'images',reachable:false})).status,'needs_attention');
});

test('unresolved ASR ownership retains its load barrier and reports an unknown result',async()=>{
  const starter=createAsrStarter({hardware:async()=>({devices:[{freeMiB:100000}]}),services:async()=>[],
    startEngine:async()=>({status:'recovery_unresolved',message:'Previous worker cannot be verified.'}),
    checkFile:async()=>{},modelFile:'test',baseUrl:'http://127.0.0.1:8282',fetcher:async()=>{throw Error('offline')}});
  const result=await starter(()=>true);
  assert.equal(result.status,503);assert.equal(result.body.code,'load_unknown');assert.equal(result.keepBarrier,true);
  assert.match(result.body.message,/cannot be verified/);
});
