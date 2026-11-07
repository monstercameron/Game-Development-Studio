import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { RuntimeSupervisor } from '../runtime/supervisor.js';
import { parseNvidiaCsv } from '../runtime/gpu-worker.js';
import { interpretStatus, configuredServices } from '../runtime/catalog.js';
import { estimateFromJobs, JobQueue } from '../runtime/jobs.js';
import { createModelLoader, planModelLoad } from '../runtime/model-load.js';
import { EngineManager } from '../runtime/engines.js';
import { createMusicPreparation } from '../runtime/music-preparation.js';
import { createServicePreparation } from '../runtime/service-preparation.js';
import { createVideoPreparation } from '../runtime/video-preparation.js';
import { createImagePreparation } from '../runtime/image-preparation.js';
import { createSoundLoader, createSoundPreparation } from '../runtime/sound-preparation.js';
import { createTtsLoader, createTtsPreparation } from '../runtime/tts-preparation.js';
import { findSharedHuggingFaceToken, createManagedSoundTokenProvider } from '../runtime/sound-credentials.js';
import { stageReference, stageProjectAsset, readReferences } from '../runtime/references.js';

async function waitFor(fn,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timed out waiting for runtime');}

test('GPU parser retains unavailable devices without inventing memory values',()=>{
  assert.deepEqual(parseNvidiaCsv('0, GPU, 98304, 2000, 96304\n1, NPU, [N/A], [N/A], [N/A]\n'),[
    {index:0,name:'GPU',totalMiB:98304,usedMiB:2000,freeMiB:96304},
    {index:1,name:'NPU',totalMiB:null,usedMiB:null,freeMiB:null},
  ]);
});

test('voice loading checks GPU memory and retains an uncertain load barrier',async()=>{
  let posts=0, free=1000;
  const fetcher=async(url,options={})=>{
    if(url.endsWith('/api/status'))return {ok:true,json:async()=>({engine:'forge-qwen3-tts-v1',phase:'idle',loaded:false,model_downloaded:true})};
    if(options.method==='POST'){posts++;throw Error('Connection lost after sending request')}
    throw Error('Unexpected request');
  };
  const load=createTtsLoader({hardware:async()=>({devices:[{freeMiB:free}]}),services:async()=>[],baseUrl:'http://127.0.0.1:8281',fetcher});
  assert.equal((await load()).body.code,'insufficient_gpu_memory');assert.equal(posts,0);
  free=50000;assert.equal((await load()).body.code,'load_unknown');assert.equal(posts,1);
  const prepare=createTtsPreparation({startEngine:async()=>({status:'starting'}),loadModel:load});
  const result=await prepare({reachable:true,health:{phase:'idle',model_downloaded:true},claimLoad:()=>true});
  assert.equal(result.status,'needs_attention');assert.equal(result.loadBarrier,true);
});

test('health interpretation distinguishes files ready from loaded and rejects unrelated services',()=>{
  assert.equal(interpretStatus('h3',{ready:true,files:[]}).modelLoaded,null);
  assert.equal(interpretStatus('mammoth',{api:'ok',model_ready:true,state:'ready'}).modelLoaded,true);
  assert.equal(interpretStatus('mammoth',{status:'ok'}),null);
  assert.equal(interpretStatus('qwen',{status:'not loaded',model_downloaded:true}).modelLoaded,false);
  assert.equal(interpretStatus('yue',{api_version:'1',model:{loaded:true,loading:false}}).modelLoaded,true);
  assert.deepEqual(interpretStatus('motionbricks',{engine:'forge-motionbricks-cuda-experimental-v1',phase:'generating',loaded:true,model_downloaded:true}),{modelLoaded:true,state:'generating',busy:true});
  assert.equal(interpretStatus('motionbricks',{engine:'other',phase:'ready',loaded:true,model_downloaded:true}),null);
});

test('service metadata uses configured local origins and rejects nonlocal addresses',()=>{
  const configured=configuredServices({FORGE_ASR_URL:'http://127.0.0.1:43001',FORGE_TTS_URL:'http://example.com:42',FORGE_MOTIONBRICKS_URL:'http://localhost:49001'});
  assert.equal(configured.find(item=>item.id==='asr').port,43001);
  assert.equal(configured.find(item=>item.id==='motion-bricks').port,49001);
  assert.equal(configured.find(item=>item.id==='tts').port,null);assert.match(configured.find(item=>item.id==='tts').configurationError,/local HTTP origin/);
});

test('estimates use only completed jobs with matching settings and reveal sample size',()=>{
  const request={duration:5,steps:8};
  const sample=(seconds,changes={})=>({type:'sfx',status:'completed',request,startedAt:'2026-01-01T00:00:00.000Z',finishedAt:new Date(Date.parse('2026-01-01T00:00:00.000Z')+seconds*1000).toISOString(),...changes});
  const result=estimateFromJobs([sample(10),sample(20),sample(100,{request:{duration:10,steps:8}}),sample(200,{status:'failed'})],{type:'sfx',request});
  assert.equal(result.sampleCount,2);assert.equal(result.typicalSeconds,10);assert.equal(result.confidence,'limited');
  assert.equal(estimateFromJobs([],{type:'sfx',request}).available,false);
});

test('model loading refuses insufficient or unknown memory and avoids duplicate requests',async()=>{
  assert.equal(planModelLoad({devices:[]},[]).code,'gpu_memory_unavailable');
  const low=planModelLoad({devices:[{name:'GPU',freeMiB:1000}]},[{id:'game',name:'Mammoth',modelLoaded:true,canUnload:false}]);
  assert.equal(low.code,'insufficient_gpu_memory');assert.equal(low.candidates[0].canUnload,false);
  let posts=0;const fetcher=async(url,options={})=>{
    if(url.endsWith('/api/v1/health'))return {ok:true,json:async()=>({api_version:'1',model:{loaded:false,loading:false}})};
    if(url.endsWith('/api/model/load')&&options.method==='POST'){posts++;return {ok:true}};
    throw Error('Unexpected request');
  };
  const blocked=createModelLoader({hardware:async()=>({devices:[{freeMiB:1000}]}),services:async()=>[],fetcher});
  assert.equal((await blocked()).body.code,'insufficient_gpu_memory');assert.equal(posts,0);
  const load=createModelLoader({hardware:async()=>({devices:[{freeMiB:40000}]}),services:async()=>[],fetcher});
  const [first,second]=await Promise.all([load(),load()]);assert.equal(first.body.code,'load_requested');assert.equal(second.body.code,'load_requested');assert.equal(posts,1);
  assert.equal((await load()).body.code,'loading');assert.equal(posts,1);
  const uncertain=createModelLoader({hardware:async()=>({devices:[{freeMiB:40000}]}),services:async()=>[],fetcher:async url=>{if(url.endsWith('/api/v1/health'))return {ok:true,json:async()=>({api_version:'1',model:{loaded:false}})};throw Error('Connection lost after request')}});
  assert.equal((await uncertain()).body.code,'load_unknown');
});

test('GPU admission does not substitute another GPU or a missing reading',async()=>{
  const spare={index:1,name:'Second GPU',freeMiB:80000};
  const missing={index:0,name:'First GPU',freeMiB:null};
  for(const devices of [[missing,spare],[{...missing,freeMiB:500},spare],[{...missing,freeMiB:500},{...spare,freeMiB:null}]]){
    const plan=planModelLoad({devices},[]);assert.equal(plan.code,'gpu_memory_unavailable');
  }
  let posts=0;
  const load=createModelLoader({hardware:async()=>({devices:[missing,spare]}),services:async()=>[],fetcher:async(url,options={})=>{
    if(url.endsWith('/api/v1/health'))return {ok:true,json:async()=>({api_version:'1',model:{loaded:false}})};
    if(options.method==='POST')posts++;
    throw Error('Unexpected request');
  }});
  assert.equal((await load()).body.code,'gpu_memory_unavailable');assert.equal(posts,0);
  const prepare=createImagePreparation({hardware:async()=>({devices:[missing,spare]}),services:async()=>[]});
  assert.equal((await prepare()).status,'needs_attention');
});

test('memory choices include an active video renderer even without a loaded-model flag',()=>{
  const hardware={devices:[{index:0,name:'NVIDIA GPU',freeMiB:500},{index:1,name:'NVIDIA NPU',freeMiB:null}]};
  const plan=planModelLoad(hardware,[{id:'video',name:'H3',modelLoaded:null,busy:true,managed:false,canUnload:false},{id:'tts',name:'Voice',modelLoaded:true,busy:true,managed:true,canUnload:true}],4096);
  assert.equal(plan.code,'insufficient_gpu_memory');assert.equal(plan.candidates.length,2);
  assert.deepEqual((({id,name,canUnload,busy,managed})=>({id,name,canUnload,busy,managed}))(plan.candidates[0]),{id:'video',name:'H3',canUnload:false,busy:true,managed:false});
  assert.equal(plan.candidates[1].canUnload,false);
});

test('music preparation starts on demand and pauses for memory without loading a cancelled job',async()=>{
  let starts=0,loads=0;
  const prepare=createMusicPreparation({startEngine:async()=>{starts++;return {status:'starting'}},loadModel:async()=>{loads++;return {status:409,body:{code:'insufficient_gpu_memory',requiredMiB:26624,candidates:[]}}}});
  assert.equal((await prepare({reachable:false})).status,'waiting_engine');assert.equal(starts,1);
  const blocked=await prepare({reachable:true,health:{model:{loaded:false}},claimLoad:()=>true});
  assert.equal(blocked.status,'waiting_memory');assert.equal(blocked.details.code,'insufficient_gpu_memory');assert.equal(loads,1);
  assert.equal(await prepare({reachable:true,health:{model:{loaded:false}},claimLoad:()=>false}),null);assert.equal(loads,1);
  assert.equal((await prepare({reachable:true,health:{model:{error:'load failed'}},claimLoad:()=>true})).status,'needs_attention');assert.equal(loads,1);
});

test('image and sound workers start on demand without loading models or replacing an external worker',async()=>{
  const starts=[];
  const prepare=createServicePreparation({startEngine:async id=>{starts.push(id);return {status:'starting'}},autoStart:type=>type==='images'});
  assert.match((await prepare({type:'images',reachable:false})).stage,/Starting/);assert.deepEqual(starts,['images']);
  assert.match((await prepare({type:'sfx',reachable:false})).stage,/configured/);assert.deepEqual(starts,['images']);
  assert.match((await prepare({type:'images',reachable:true})).stage,/load its model/);assert.deepEqual(starts,['images']);
});

test('sound model loading checks memory and does not expose credentials in results',async()=>{
  let posts=0,free=1000;
  const fetcher=async(url,options={})=>{
    if(url.endsWith('/api/status'))return {ok:true,json:async()=>({phase:'idle',loaded:false})};
    if(url.endsWith('/api/session'))return {ok:true,json:async()=>({session:'session-secret'})};
    if(url.endsWith('/api/load')){posts++;assert.equal(options.headers['X-Lab-Session'],'session-secret');assert.equal(JSON.parse(options.body).token,'user-secret');return {ok:true}};
    throw Error('Unexpected request');
  };
  const load=createSoundLoader({baseUrl:'http://127.0.0.1:1',hardware:async()=>({devices:[{freeMiB:free}]}),services:async()=>[],fetcher});
  assert.equal((await load('user-secret')).body.code,'insufficient_gpu_memory');assert.equal(posts,0);
  free=30000;const result=await load('user-secret');assert.equal(result.body.code,'load_requested');assert.equal(posts,1);
  assert.doesNotMatch(JSON.stringify(result),/user-secret|session-secret/);
  assert.throws(()=>load('bad\nsecret'),/Invalid/);
});

test('sound credentials are read from local Markdown without exposing unrelated content',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-sound-credentials-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'other.md'),'irrelevant example hf_Backup123');
  await fs.writeFile(path.join(dir,'api keys.md'),'other private content\nHF: hf_TestOnly123\n');
  await fs.writeFile(path.join(dir,'ignore.txt'),'hf_Wrong123');
  assert.equal(await findSharedHuggingFaceToken(dir),'hf_TestOnly123');
  let delivered='';const load=createSoundLoader({baseUrl:'http://127.0.0.1:1',hardware:async()=>({devices:[{freeMiB:30000}]}),services:async()=>[],getToken:()=>findSharedHuggingFaceToken(dir),fetcher:async(url,options)=>{
    if(url.endsWith('/api/status'))return {ok:true,json:async()=>({phase:'idle',loaded:false})};
    if(url.endsWith('/api/session'))return {ok:true,json:async()=>({session:'test-session'})};
    delivered=JSON.parse(options.body).token;return {ok:true};
  }});
  const result=await load();assert.equal(delivered,'hf_TestOnly123');assert.doesNotMatch(JSON.stringify(result),/hf_TestOnly123|private content/);
  let reads=0;const readToken=async()=>{reads++;return 'hf_TestOnly123'};
  assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:false}}),readToken})(),'');
  assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:true}}),readToken,customEndpoint:true})(),'');assert.equal(reads,0);
  assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:true}}),readToken})(),'hf_TestOnly123');assert.equal(reads,1);
});

test('sound queue loads on demand and keeps the load barrier after cancellation and restart', {timeout:12000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-sound-load-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'sfx'),{recursive:true});await fs.mkdir(path.join(project,'images'));await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let phase='idle',loaded=false,loads=0,submissions=0;
  const http=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({phase,loaded}));
    if(req.url==='/api/session')return res.end(JSON.stringify({session:'session-secret'}));
    if(req.url==='/api/load'){assert.equal(req.headers['x-lab-session'],'session-secret');let body='';for await(const chunk of req)body+=chunk;assert.equal(JSON.parse(body).token,'');loads++;phase='loading';return res.end('{}')}
    if(req.url==='/api/generate'){submissions++;req.resume();return res.end(JSON.stringify({job_id:'sound-loaded'}))}
    if(req.url==='/api/jobs/sound-loaded')return res.end(JSON.stringify({status:'completed',result:{url:'/audio/sound.wav'}}));
    if(req.url==='/audio/sound.wav')return res.end('RIFF-sound-test');
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_SFX_URL;process.env.FORGE_SFX_URL=`http://127.0.0.1:${http.address().port}`;t.after(()=>{if(previous===undefined)delete process.env.FORGE_SFX_URL;else process.env.FORGE_SFX_URL=previous});
  const loader=createSoundLoader({baseUrl:process.env.FORGE_SFX_URL,hardware:async()=>({devices:[{freeMiB:30000}]}),services:async()=>[]});
  const prepareSound=createSoundPreparation({startEngine:async()=>({status:'already_running'}),loadModel:loader});
  let queue;const create=()=>new JobQueue({directory:path.join(dir,'state'),projects,leaseMs:200,intervalMs:40,prepareSound,onModelLoadBarrier:engine=>{if(engine==='sfx'&&loaded)queue.resumeAfterModelLoad('sfx')}});
  queue=create();t.after(()=>queue.stop());
  const first=queue.enqueue({type:'sfx',projectId:id,request:{prompt:'A bell'}});
  const second=queue.enqueue({type:'sfx',projectId:id,request:{prompt:'Another bell'}});
  await waitFor(()=>queue.get(first.id)?.status==='waiting_engine'&&queue.modelLoadEngine==='sfx'&&queue.modelLoadState==='loading');
  assert.equal(loads,1);assert.equal(queue.cancel(first.id).status,'cancelled');queue.stop();queue=create();
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(queue.modelLoadEngine,'sfx');assert.equal(submissions,0);
  phase='ready';loaded=true;await waitFor(()=>queue.get(second.id)?.status==='completed',8000);
  assert.equal(submissions,1);assert.equal(loads,1);assert.equal(queue.modelLoadState,'idle');
  assert.equal(await fs.readFile(path.join(project,...queue.get(second.id).output.split('/')),'utf8'),'RIFF-sound-test');
  assert.doesNotMatch(JSON.stringify(queue.list()),/session-secret/);
});

test('music queue waits for memory then loads and renders without losing its lease', {timeout:12000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-lazy-music-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'music'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let loaded=false,free=false,submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/v1/health')return res.end(JSON.stringify({api_version:'1',model:{loaded}}));
    if(req.url==='/api/v1/jobs'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({id:'lazy-job'}))}
    if(req.url==='/api/v1/jobs/lazy-job')return res.end(JSON.stringify({status:'done'}));
    if(req.url==='/api/v1/jobs/lazy-job/audio')return res.end('fLaC-lazy-test');
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_MUSIC_URL;process.env.FORGE_MUSIC_URL=`http://127.0.0.1:${http.address().port}`;
  t.after(()=>{if(previous===undefined)delete process.env.FORGE_MUSIC_URL;else process.env.FORGE_MUSIC_URL=previous});
  const prepare=createMusicPreparation({startEngine:async()=>({status:'already_running'}),loadModel:async()=>{
    if(!free)return {status:409,body:{code:'insufficient_gpu_memory',requiredMiB:26624,candidates:[]}};
    await new Promise(resolve=>setTimeout(resolve,350));loaded=true;return {status:202,body:{code:'load_requested'}};
  }});
  let queue;queue=new JobQueue({directory:path.join(dir,'state'),projects,leaseMs:200,intervalMs:40,prepareMusic:prepare,onModelLoadBarrier:()=>{if(loaded)queue.resumeAfterModelLoad()}});t.after(()=>queue.stop());
  const job=queue.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});
  await waitFor(()=>queue.get(job.id)?.status==='waiting_memory');assert.equal(submissions,0);
  assert.equal(queue.get(job.id).details.code,'insufficient_gpu_memory');
  free=true;queue.retry(job.id);
  await waitFor(()=>queue.get(job.id)?.status==='completed',8000);
  assert.equal(submissions,1);
  assert.equal(await fs.readFile(path.join(project,...queue.get(job.id).output.split('/')),'utf8'),'fLaC-lazy-test');
});

test('cancelling a queued music load keeps the persisted barrier across runtime replacement', {timeout:12000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-auto-load-barrier-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'images'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let loaded=false,submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/v1/health')return res.end(JSON.stringify({api_version:'1',model:{loaded,loading:!loaded}}));
    if(req.url==='/api/status')return res.end(JSON.stringify({status:'ready',model_downloaded:true,busy:false}));
    if(req.url==='/api/generate'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({id:'after-load'}))}
    if(req.url==='/api/jobs/after-load')return res.end(JSON.stringify({status:'completed',images:['/outputs/after-load-1.png']}));
    if(req.url==='/outputs/after-load-1.png')return res.end('image-fixture');
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previousMusic=process.env.FORGE_MUSIC_URL,previousImage=process.env.FORGE_IMAGE_URL;
  process.env.FORGE_MUSIC_URL=process.env.FORGE_IMAGE_URL=`http://127.0.0.1:${http.address().port}`;
  t.after(()=>{if(previousMusic===undefined)delete process.env.FORGE_MUSIC_URL;else process.env.FORGE_MUSIC_URL=previousMusic;if(previousImage===undefined)delete process.env.FORGE_IMAGE_URL;else process.env.FORGE_IMAGE_URL=previousImage});
  const prepare=createMusicPreparation({startEngine:async()=>({status:'already_running'}),loadModel:async()=>{throw Error('Already loading should not request another load')}});
  let queue;const create=()=>new JobQueue({directory:path.join(dir,'state'),projects,leaseMs:200,intervalMs:40,prepareMusic:prepare,onModelLoadBarrier:()=>{if(loaded)queue.resumeAfterModelLoad()}});
  queue=create();t.after(()=>queue.stop());
  const music=queue.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});
  const image=queue.enqueue({type:'images',projectId:id,request:{prompt:'A castle',width:512,height:512,num_inference_steps:12}});
  await waitFor(()=>queue.get(music.id)?.status==='waiting_engine'&&queue.modelLoadState==='loading');
  assert.equal(queue.cancel(music.id).status,'cancelled');await new Promise(resolve=>setTimeout(resolve,150));assert.equal(submissions,0);assert.equal(queue.get(image.id).status,'queued');
  queue.stop();queue=create();await new Promise(resolve=>setTimeout(resolve,150));assert.equal(queue.modelLoadState,'loading');assert.equal(submissions,0);
  loaded=true;await waitFor(()=>queue.get(image.id)?.status==='completed',8000);assert.equal(submissions,1);assert.equal(queue.modelLoadState,'idle');
});

test('cancelling while a worker starts cannot resurrect the job or load its model',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-cancel-start-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const http=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({api_version:'1',model:{loaded:false}}))});http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_MUSIC_URL;process.env.FORGE_MUSIC_URL=`http://127.0.0.1:${http.address().port}`;t.after(()=>{if(previous===undefined)delete process.env.FORGE_MUSIC_URL;else process.env.FORGE_MUSIC_URL=previous});
  let entered=false,release;const pending=new Promise(resolve=>{release=resolve});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50,prepareMusic:async({claimLoad})=>{entered=true;await pending;return claimLoad()?{status:'waiting_engine',stage:'Loading'}:null}});
  t.after(()=>queue.stop());
  const job=queue.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});
  await waitFor(()=>entered);assert.equal(queue.cancel(job.id).status,'cancelled');release();
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(queue.get(job.id).status,'cancelled');
});

test('engine manager starts a service and offloads only its own idle process', {timeout:15000},async t=>{
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-engine-'));
  const definition={id:'sfx',name:'Mock sound engine',port,endpoint:'/api/status',kind:'stable-audio',cwd:dir,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/mock-engine.js',import.meta.url)),String(port)]};
  const manager=new EngineManager({definitions:[definition],logDir:dir});t.after(()=>{manager.closed=true;manager.children.get('sfx')?.child.kill()});
  assert.equal((await manager.start('sfx')).status,'starting');
  let ready=false;for(let i=0;i<100&&!ready;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/status`)).ok}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(ready,true);assert.equal(manager.canOffload('sfx'),true);
  const other=new EngineManager({definitions:[definition],logDir:dir});
  assert.equal((await other.start('sfx')).status,'already_running');await assert.rejects(other.offload('sfx'),/cannot safely stop/i);
  const oldPid=manager.children.get('sfx').child.pid;manager.children.get('sfx').child.kill();
  await waitFor(()=>manager.owns('sfx')&&manager.children.get('sfx').child.pid!==oldPid);
  ready=false;for(let i=0;i<100&&!ready;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/status`)).ok}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(ready,true);
  await fetch(`http://127.0.0.1:${port}/busy`);await assert.rejects(manager.offload('sfx'),/busy/);
  await fetch(`http://127.0.0.1:${port}/idle`);assert.equal((await manager.offload('sfx')).stopped,true);
  assert.equal(manager.canOffload('sfx'),false);
});

test('guarded image offload rejects queued submissions and blocks new ones before stopping', {timeout:20000,skip:process.platform!=='win32'},async t=>{
  const python=path.join(os.homedir(),'Desktop','Qwen Image Studio','.venv','Scripts','python.exe');
  try{await fs.access(python)}catch{t.skip('Qwen Python runtime is not installed');return}
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-image-guard-'));
  const definition={id:'images',name:'Guarded image test',port,endpoint:'/api/status',kind:'qwen',cwd:dir,command:python,args:['-u',fileURLToPath(new URL('../runtime/qwen_worker.py',import.meta.url)),'--port',String(port),'--engine-dir',fileURLToPath(new URL('./fixtures/qwen-stub',import.meta.url))],quiesce:'qwen-v1'};
  const manager=new EngineManager({definitions:[definition],logDir:dir});t.after(()=>{manager.closed=true;manager.children.get('images')?.child.kill()});
  assert.equal((await manager.start('images')).status,'starting');
  let ready=false;for(let i=0;i<150&&!ready;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/status`)).ok}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(ready,true);assert.equal(manager.canOffload('images'),true);
  const base=`http://127.0.0.1:${port}`,token=manager.children.get('images').controlToken;
  assert.equal((await fetch(`${base}/api/forge/stop`,{method:'POST'})).status,403);
  assert.equal((await fetch(`${base}/api/generate`,{method:'POST'})).status,200);
  await assert.rejects(manager.offload('images'),/active or queued/);
  await fetch(`${base}/finish`,{method:'POST'});
  assert.equal((await fetch(`${base}/api/forge/stop`,{method:'POST',headers:{'X-Forge-Engine-Token':token}})).status,200);
  assert.equal((await fetch(`${base}/api/generate`,{method:'POST'})).status,503);
  assert.equal((await fetch(`${base}/api/forge/resume`,{method:'POST',headers:{'X-Forge-Engine-Token':token}})).status,200);
  assert.equal((await manager.offload('images')).stopped,true);
  let stopped=false;for(let i=0;i<100&&!stopped;i++){try{await fetch(`${base}/api/status`)}catch{stopped=true}if(!stopped)await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(stopped,true,'Image service still accepts requests after offload.');
});

test('guarded image worker completes a confirmed stop without its supervisor', {timeout:15000,skip:process.platform!=='win32'},async t=>{
  const python=path.join(os.homedir(),'Desktop','Qwen Image Studio','.venv','Scripts','python.exe');
  try{await fs.access(python)}catch{t.skip('Qwen Python runtime is not installed');return}
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-image-stop-'));
  const definition={id:'images',name:'Guarded image test',port,endpoint:'/api/status',kind:'qwen',cwd:dir,command:python,args:['-u',fileURLToPath(new URL('../runtime/qwen_worker.py',import.meta.url)),'--port',String(port),'--engine-dir',fileURLToPath(new URL('./fixtures/qwen-stub',import.meta.url))],quiesce:'qwen-v1'};
  const manager=new EngineManager({definitions:[definition],logDir:dir});t.after(()=>{manager.closed=true;manager.children.get('images')?.child.kill()});await manager.start('images');
  let ready=false;for(let i=0;i<150&&!ready;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/status`)).ok}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,50))}assert.equal(ready,true);
  const entry=manager.children.get('images'),exit=once(entry.child,'exit');manager.closed=true;
  const response=await fetch(`http://127.0.0.1:${port}/api/forge/stop`,{method:'POST',headers:{'X-Forge-Engine-Token':entry.controlToken}});assert.equal(response.status,200);
  let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker did not stop after confirmation.')),6000);timer.unref()})])}finally{clearTimeout(timer)}
});

test('supervisor retries synchronous and asynchronous process-spawn failures',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-spawn-retry-'));
  let attempts=0;
  const forkWorker=(url,args,options)=>{
    attempts++;
    if(attempts===1)throw Error('Simulated temporary spawn failure');
    if(attempts===2)return fork(url,args,{...options,execPath:path.join(dir,'missing-node-executable')});
    return fork(url,args,options);
  };
  const supervisor=new RuntimeSupervisor({restartDelay:25,forkWorker,env:{...process.env,FORGE_RUNTIME_DIR:dir}});
  t.after(()=>supervisor.stop());supervisor.start();
  await waitFor(()=>supervisor.status().ready);
  assert.equal(attempts,3);assert.equal(supervisor.status().restarts,2);
  assert.equal((await supervisor.call('health')).state,'ready');
});

test('stopping a supervisor cancels a pending spawn retry',async()=>{
  let attempts=0;
  const supervisor=new RuntimeSupervisor({restartDelay:25,forkWorker:()=>{attempts++;throw Error('Simulated temporary spawn failure')}});
  supervisor.start();supervisor.stop();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(attempts,1);assert.equal(supervisor.status().ready,false);
});

test('supervisor survives a runtime crash and handles concurrent calls after restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-supervisor-'));
  const supervisor=new RuntimeSupervisor({restartDelay:50,env:{...process.env,FORGE_RUNTIME_DIR:dir}});supervisor.start();t.after(()=>supervisor.stop());
  await waitFor(()=>supervisor.status().ready);
  const first=await supervisor.call('health');
  assert.equal(first.pid,supervisor.status().pid);
  supervisor.child.kill();
  await waitFor(()=>supervisor.status().ready && supervisor.status().pid!==first.pid);
  assert.equal(supervisor.status().restarts,1);
  const replies=await Promise.all(Array.from({length:30},()=>supervisor.call('health')));
  assert.equal(new Set(replies.map(reply=>reply.pid)).size,1);
  assert.notEqual(replies[0].pid,first.pid);
});

test('expired queue owners cannot overwrite a newer owner or release its lease',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-fencing-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const options={directory:path.join(dir,'state'),projects,leaseMs:80,autoStart:false};
  const old=new JobQueue(options),next=new JobQueue(options);t.after(()=>{if(!old.stopped)old.stop();if(!next.stopped)next.stop()});
  const job=old.enqueue({type:'sfx',projectId:id,request:{prompt:'bell'}});
  assert.equal(old.lease(),true);const stale={owner:old.owner,epoch:old.epoch};
  assert.equal(old.update(job.id,{status:'running',remote_id:'one'},stale),true);
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(next.lease(),true);const current={owner:next.owner,epoch:next.epoch};
  assert.notEqual(current.epoch,stale.epoch);
  assert.equal(next.update(job.id,{status:'completed',output:'sfx/result.wav'},current),true);
  assert.equal(old.update(job.id,{status:'failed',error:'stale worker'},stale),false);
  assert.equal(next.get(job.id).status,'completed');
  old.stop();assert.equal(next.db.prepare('SELECT owner FROM runtime_owner WHERE id=1').get().owner,next.owner);
});

test('reacquiring an expired lease fences the previous generation and stops its worker',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-refence-'));
  const queue=new JobQueue({directory:dir,leaseMs:60,autoStart:false});t.after(()=>{queue.active=null;queue.stop()});
  assert.equal(queue.lease(),true);const previous=queue.epoch;let killed=false;
  queue.active={child:{kill(){killed=true}}};
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(queue.lease(),true);assert.notEqual(queue.epoch,previous);assert.equal(killed,true);
});

test('job listing keeps the oldest blocked work visible even with a long history',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-visible-queue-'));
  const queue=new JobQueue({directory:dir,autoStart:false});t.after(()=>queue.stop());
  const insert=queue.db.prepare('INSERT INTO jobs(id,type,project_id,request,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  const blocked=randomUUID();insert.run(blocked,'music',randomUUID(),'{}','waiting_memory','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
  for(let i=0;i<205;i++)insert.run(randomUUID(),'music',randomUUID(),'{}','completed',`2025-01-01T00:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`,`2025-01-01T00:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`);
  const jobs=queue.list();assert.equal(jobs.length,200);assert.equal(jobs[0].id,blocked);
});

test('a crashed preparation is safely rechecked by the next queue owner',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-prepare-recovery-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const options={directory:path.join(dir,'state'),projects,leaseMs:70,autoStart:false};
  const first=new JobQueue(options),second=new JobQueue(options);t.after(()=>{if(!first.stopped)first.stop();if(!second.stopped)second.stop()});
  const job=first.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});
  assert.equal(first.lease(),true);assert.equal(first.update(job.id,{status:'preparing'}),true);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(second.lease(),true);
  assert.equal(second.get(job.id).status,'waiting_engine');
});

test('a manual model load remains a queue barrier after the runtime is replaced',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-load-barrier-'));
  const options={directory:dir,leaseMs:80,autoStart:false};
  const first=new JobQueue(options),second=new JobQueue(options);t.after(()=>{if(!first.stopped)first.stop();if(!second.stopped)second.stop()});
  first.suspendForModelLoad();assert.equal(first.modelLoadState,'checking');
  first.stop();assert.equal(second.lease(),true);assert.equal(second.modelLoadState,'loading');
  assert.throws(()=>second.suspendForModelLoad(),/Wait for the active render/);
  assert.equal(second.resumeAfterModelLoad(),true);assert.equal(second.modelLoadState,'idle');
});

test('a stuck model-load barrier requires confirmation and refuses to clear during an active load',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-clear-load-'));
  const queue=new JobQueue({directory:dir,autoStart:false});queue.suspendForModelLoad();assert.equal(queue.markModelLoadRequested(),true);queue.stop();
  let loading=true;
  const http=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({api_version:'1',model:{loaded:false,loading}}))});
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const supervisor=new RuntimeSupervisor({env:{...process.env,FORGE_RUNTIME_DIR:dir,FORGE_MUSIC_URL:`http://127.0.0.1:${http.address().port}`}});supervisor.start();t.after(()=>supervisor.stop());await waitFor(()=>supervisor.status().ready);
  await assert.rejects(supervisor.call('clearMusicLoadBarrier',{}),/Confirm/);
  await assert.rejects(supervisor.call('clearMusicLoadBarrier',{confirmNotLoading:true}),/still loading/);
  loading=false;
  assert.equal((await supervisor.call('clearMusicLoadBarrier',{confirmNotLoading:true})).cleared,true);
  assert.equal((await supervisor.call('health')).modelLoadBarrier,'idle');
});

test('music queue persists, waits for a loaded engine, cancels queued work, and saves a completed asset', {timeout:45000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-queue-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'music'),{recursive:true});
  await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id,name:'Example'}));
  let loaded=false,submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/v1/health')return res.end(JSON.stringify({api_version:'1',model:{loaded}}));
    if(req.url==='/api/v1/jobs'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({id:'remote-123'}))}
    if(req.url==='/api/v1/jobs/remote-123')return res.end(JSON.stringify({id:'remote-123',status:'done'}));
    if(req.url==='/api/v1/jobs/remote-123/audio'){res.setHeader('Content-Type','audio/flac');return res.end('fLaC-test-fixture')}
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const env={...process.env,FORGE_RUNTIME_DIR:path.join(dir,'state'),FORGE_PROJECTS_DIR:projects,FORGE_MUSIC_URL:`http://127.0.0.1:${http.address().port}`,FORGE_AUTO_PREPARE_MUSIC:'0'};
  const supervisor=new RuntimeSupervisor({restartDelay:50,env});supervisor.start();t.after(()=>supervisor.stop());
  await waitFor(()=>supervisor.status().ready);
  const input={type:'music',projectId:id,request:{style:'orchestral',lyrics:'[Instrumental]',duration_seconds:15}};
  const first=(await supervisor.call('enqueue',input)).job;
  const second=(await supervisor.call('enqueue',input)).job;
  let current;
  for(let i=0;i<100;i++){current=(await supervisor.call('job',{id:first.id})).job;if(current.status==='waiting_engine')break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(current.status,'waiting_engine');assert.equal(submissions,0);
  assert.equal((await supervisor.call('cancel',{id:second.id})).job.status,'cancelled');
  const oldPid=supervisor.status().pid;supervisor.child.kill();
  await waitFor(()=>supervisor.status().ready&&supervisor.status().pid!==oldPid);
  assert.equal((await supervisor.call('job',{id:first.id})).job.status,'waiting_engine');
  loaded=true;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){current=(await supervisor.call('job',{id:first.id})).job;if(['completed','failed','interrupted'].includes(current.status))break;await new Promise(resolve=>setTimeout(resolve,200))}
  assert.equal(current.status,'completed',JSON.stringify(current));assert.equal(submissions,1);
  assert.equal(await fs.readFile(path.join(project,...current.output.split('/')),'utf8'),'fLaC-test-fixture');
  assert.equal((await supervisor.call('job',{id:second.id})).job.status,'cancelled');
});

test('uncertain submission blocks the queue after a crash instead of submitting a duplicate', {timeout:45000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-uncertain-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'music'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/v1/health')return res.end(JSON.stringify({api_version:'1',model:{loaded:true}}));
    if(req.url==='/api/v1/jobs'&&req.method==='POST'){submissions++;req.resume();return} // Simulate a lost acknowledgement.
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>{http.closeAllConnections();http.close()});
  const env={...process.env,FORGE_RUNTIME_DIR:path.join(dir,'state'),FORGE_PROJECTS_DIR:projects,FORGE_MUSIC_URL:`http://127.0.0.1:${http.address().port}`,FORGE_AUTO_PREPARE_MUSIC:'0'};
  const supervisor=new RuntimeSupervisor({restartDelay:50,env});supervisor.start();t.after(()=>supervisor.stop());await waitFor(()=>supervisor.status().ready);
  const input={type:'music',projectId:id,request:{style:'ambient',lyrics:'[Instrumental]'}};
  const first=(await supervisor.call('enqueue',input)).job;
  await waitFor(()=>submissions===1);
  const second=(await supervisor.call('enqueue',input)).job;
  const pid=supervisor.status().pid;supervisor.child.kill();await waitFor(()=>supervisor.status().ready&&supervisor.status().pid!==pid);
  let job;const deadline=Date.now()+30000;
  while(Date.now()<deadline){job=(await supervisor.call('job',{id:first.id})).job;if(job.status==='interrupted')break;await new Promise(resolve=>setTimeout(resolve,200))}
  assert.equal(job.status,'interrupted',JSON.stringify(job));assert.equal(submissions,1);
  assert.equal((await supervisor.call('job',{id:second.id})).job.status,'queued');
  await assert.rejects(supervisor.call('resolve',{id:first.id}),/Confirm/);
  assert.equal((await supervisor.call('resolve',{id:first.id,confirmRemoteNotRunning:true})).job.status,'cancelled');
});

test('sound adapter uses a session and saves the result into its project', {timeout:15000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-sfx-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'sfx'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({phase:'ready',loaded:true}));
    if(req.url==='/api/session')return res.end(JSON.stringify({session:'test-only-key'}));
    if(req.url==='/api/generate'&&req.method==='POST'){assert.equal(req.headers['x-lab-session'],'test-only-key');submissions++;req.resume();return res.end(JSON.stringify({job_id:'sfx-123'}))}
    if(req.url==='/api/jobs/sfx-123')return res.end(JSON.stringify({status:'completed',result:{url:'/audio/sample.wav'}}));
    if(req.url==='/audio/sample.wav'){res.setHeader('Content-Type','audio/wav');return res.end('RIFF-test-fixture')}
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const env={...process.env,FORGE_RUNTIME_DIR:path.join(dir,'state'),FORGE_PROJECTS_DIR:projects,FORGE_SFX_URL:`http://127.0.0.1:${http.address().port}`};
  const supervisor=new RuntimeSupervisor({restartDelay:50,env});supervisor.start();t.after(()=>supervisor.stop());await waitFor(()=>supervisor.status().ready);
  const created=(await supervisor.call('enqueue',{type:'sfx',projectId:id,request:{prompt:'A bell',duration:5,steps:8}})).job;
  let job;const deadline=Date.now()+10000;
  while(Date.now()<deadline){job=(await supervisor.call('job',{id:created.id})).job;if(['completed','failed','interrupted'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(submissions,1);
  assert.equal(await fs.readFile(path.join(project,...job.output.split('/')),'utf8'),'RIFF-test-fixture');
  assert.ok(!JSON.stringify(job).includes('test-only-key'));
  const estimate=await supervisor.call('estimate',{type:'sfx',projectId:id,request:{prompt:'A different sound',duration:5,steps:8}});
  assert.equal(estimate.available,true);assert.equal(estimate.sampleCount,1);assert.equal(estimate.confidence,'limited');
});

test('retrying a failed asset download reuses the completed remote render', {timeout:15000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-retry-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'sfx'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let submissions=0,downloads=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({phase:'ready',loaded:true}));
    if(req.url==='/api/session')return res.end(JSON.stringify({session:'key'}));
    if(req.url==='/api/generate'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({job_id:'existing-job'}))}
    if(req.url==='/api/jobs/existing-job')return res.end(JSON.stringify({status:'completed',result:{url:'/audio/example.wav'}}));
    if(req.url==='/audio/example.wav'){downloads++;if(downloads===1){res.statusCode=503;return res.end('{}')}return res.end('RIFF-recovered')}
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const env={...process.env,FORGE_RUNTIME_DIR:path.join(dir,'state'),FORGE_PROJECTS_DIR:projects,FORGE_SFX_URL:`http://127.0.0.1:${http.address().port}`};
  const supervisor=new RuntimeSupervisor({restartDelay:50,env});supervisor.start();t.after(()=>supervisor.stop());await waitFor(()=>supervisor.status().ready);
  const created=(await supervisor.call('enqueue',{type:'sfx',projectId:id,request:{prompt:'bell'}})).job;
  let job;const until=async status=>{const deadline=Date.now()+8000;while(Date.now()<deadline){job=(await supervisor.call('job',{id:created.id})).job;if(job.status===status)return;await new Promise(resolve=>setTimeout(resolve,75))}throw Error(`Expected ${status}; got ${JSON.stringify(job)}`)};
  await until('failed');assert.equal(job.remoteId,'existing-job');
  await supervisor.call('retry',{id:created.id});await until('completed');
  assert.equal(submissions,1);assert.equal(downloads,2);
  assert.equal(await fs.readFile(path.join(project,...job.output.split('/')),'utf8'),'RIFF-recovered');
});

test('text-to-image adapter saves the completed PNG to the project', {timeout:15000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-image-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'images'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let submissions=0;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({status:'ready',model_downloaded:true,busy:false}));
    if(req.url==='/api/generate'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({id:'image-123'}))}
    if(req.url==='/api/jobs/image-123')return res.end(JSON.stringify({status:'completed',images:['/outputs/image-123-1.png']}));
    if(req.url==='/outputs/image-123-1.png'){res.setHeader('Content-Type','image/png');return res.end('png-test-fixture')}
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const env={...process.env,FORGE_RUNTIME_DIR:path.join(dir,'state'),FORGE_PROJECTS_DIR:projects,FORGE_IMAGE_URL:`http://127.0.0.1:${http.address().port}`};
  const supervisor=new RuntimeSupervisor({restartDelay:50,env});supervisor.start();t.after(()=>supervisor.stop());await waitFor(()=>supervisor.status().ready);
  const created=(await supervisor.call('enqueue',{type:'images',projectId:id,request:{prompt:'A castle',width:1024,height:576,num_inference_steps:12}})).job;
  let job;const deadline=Date.now()+10000;
  while(Date.now()<deadline){job=(await supervisor.call('job',{id:created.id})).job;if(['completed','failed','interrupted'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(submissions,1);
  assert.equal(await fs.readFile(path.join(project,...job.output.split('/')),'utf8'),'png-test-fixture');
});

test('image queue uses snapshotted references and refuses missing inputs before submission', {timeout:15000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-image-reference-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'images'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('reference')]);
  await fs.writeFile(path.join(project,'images','source.png'),png);const reference=await stageProjectAsset(project,'images/source.png');
  await fs.writeFile(path.join(project,'images','source.png'),'changed after staging');
  let submissions=0;
  const http=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({status:'ready',model_downloaded:true,busy:false}));
    if(req.url==='/api/generate'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);assert.equal(input.images[0],`data:image/png;base64,${png.toString('base64')}`);assert.equal(input.references,undefined);assert.equal(input.negative_prompt,'blurred');assert.equal(input.true_cfg_scale,2.5);assert.equal(input.width,512);assert.equal(input.num_inference_steps,12);submissions++;return res.end(JSON.stringify({id:'image-ref'}))}
    if(req.url==='/api/jobs/image-ref')return res.end(JSON.stringify({status:'completed',images:['/outputs/image-ref-1.png']}));
    if(req.url==='/outputs/image-ref-1.png')return res.end('image-test-fixture');
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_IMAGE_URL;process.env.FORGE_IMAGE_URL=`http://127.0.0.1:${http.address().port}`;t.after(()=>{if(previous===undefined)delete process.env.FORGE_IMAGE_URL;else process.env.FORGE_IMAGE_URL=previous});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50});t.after(()=>queue.stop());
  const input={type:'images',projectId:id,request:{prompt:'A castle',width:512,height:512,num_inference_steps:12,references:[reference.id],negative_prompt:'blurred',true_cfg_scale:2.5}};
  assert.equal((await readReferences(project,Array(10).fill(reference.id),{max:10})).length,10);
  assert.throws(()=>queue.estimate({...input,request:{...input.request,references:Array(11).fill(reference.id)}}),/up to 10/);
  const first=queue.enqueue(input);await waitFor(()=>queue.get(first.id)?.status==='completed');assert.equal(submissions,1);
  assert.equal(queue.estimate(input).sampleCount,1);assert.equal(queue.estimate({...input,request:{...input.request,references:[]}}).available,false);
  assert.equal(queue.estimate({...input,request:{...input.request,negative_prompt:'',true_cfg_scale:1}}).available,false);
  assert.throws(()=>queue.enqueue({...input,request:{...input.request,true_cfg_scale:1}}),/negative prompt guidance/i);
  await fs.unlink(path.join(project,'.forge-inputs',reference.id));
  const second=queue.enqueue(input);await waitFor(()=>queue.get(second.id)?.status==='failed');assert.match(queue.get(second.id).error,/reference/i);assert.equal(submissions,1);
});

test('first image render checks memory before the engine loads its model', {timeout:15000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-image-load-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'images'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  let downloaded=false,submissions=0,free=1000;
  const http=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({status:'not loaded',model_downloaded:downloaded,busy:false}));
    if(req.url==='/api/generate'&&req.method==='POST'){submissions++;req.resume();return res.end(JSON.stringify({id:'first-image'}))}
    if(req.url==='/api/jobs/first-image')return res.end(JSON.stringify({status:'completed',images:['/outputs/first-image-1.png']}));
    if(req.url==='/outputs/first-image-1.png')return res.end('image-fixture');
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_IMAGE_URL;process.env.FORGE_IMAGE_URL=`http://127.0.0.1:${http.address().port}`;t.after(()=>{if(previous===undefined)delete process.env.FORGE_IMAGE_URL;else process.env.FORGE_IMAGE_URL=previous});
  const prepareImage=createImagePreparation({hardware:async()=>({devices:[{freeMiB:free}]}),services:async()=>[{id:'music',name:'YuE2',modelLoaded:true,canUnload:true}]});
  const prepareService=createServicePreparation({startEngine:async()=>({status:'starting'}),autoStart:()=>false});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50,prepareImage,prepareService});t.after(()=>queue.stop());
  const first=queue.enqueue({type:'images',projectId:id,request:{prompt:'A castle',width:512,height:512,num_inference_steps:12}});
  await waitFor(()=>queue.get(first.id).status==='needs_attention');assert.match(queue.get(first.id).error,/download/i);assert.equal(submissions,0);
  downloaded=true;queue.retry(first.id);await waitFor(()=>queue.get(first.id).status==='waiting_memory');assert.equal(submissions,0);
  assert.equal(queue.get(first.id).details.candidates[0].id,'music');assert.match(queue.get(first.id).details.estimate,/uncalibrated/);
  free=60000;queue.retry(first.id);await waitFor(()=>queue.get(first.id).status==='completed');
  assert.equal(submissions,1);assert.equal(await fs.readFile(path.join(project,...queue.get(first.id).output.split('/')),'utf8'),'image-fixture');
});

test('video queue checks memory, snapshots references, saves output, and blocks an unknown remote job', {timeout:15000}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-video-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Example'),id=randomUUID();
  await fs.mkdir(path.join(project,'video'),{recursive:true});await fs.mkdir(path.join(project,'images'));await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('reference')]);
  await fs.writeFile(path.join(project,'images','reference.png'),png);
  const reference=await stageProjectAsset(project,'images/reference.png');
  await fs.writeFile(path.join(project,'images','reference.png'),'changed later');
  assert.equal((await readReferences(project,[reference.id]))[0],`data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(stageProjectAsset(project,'../outside.png'),/Invalid/);
  await assert.rejects(stageReference(project,Buffer.from('not an image')),/reference image|images/i);
  let submissions=0,current=null,forget=false,unverifiedDownloads=0;
  const http=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({ready:true,files:[],job:forget?null:current,videos:forget?[{name:'video-2.webm'}]:[]}));
    if(req.url==='/api/generate'&&req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
      assert.equal(input.images[0],`data:image/png;base64,${png.toString('base64')}`);assert.equal(input.steps,8);assert.equal(input.frames,56);submissions++;
      current={id:`video-${submissions}`,state:'complete',output:`video-${submissions}.webm`};return res.end(JSON.stringify({id:current.id}));
    }
    if(req.url==='/videos/video-1.webm')return res.end('video-test-fixture');
    if(req.url==='/videos/video-2.webm'){unverifiedDownloads++;return res.end('possibly-partial-video')}
    res.statusCode=404;res.end('{}');
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const previous=process.env.FORGE_VIDEO_URL;process.env.FORGE_VIDEO_URL=`http://127.0.0.1:${http.address().port}`;t.after(()=>{if(previous===undefined)delete process.env.FORGE_VIDEO_URL;else process.env.FORGE_VIDEO_URL=previous});
  let free=1000;
  const prepareVideo=createVideoPreparation({hardware:async()=>({devices:[{freeMiB:free}]}),services:async()=>[{id:'music',name:'YuE2',modelLoaded:true,canUnload:true}]});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50,prepareVideo});t.after(()=>queue.stop());
  const input={type:'video',projectId:id,request:{prompt:'A castle',references:[reference.id],aspect:'landscape',frames:56,steps:8}};
  const first=queue.enqueue(input);
  await waitFor(()=>queue.get(first.id).status==='waiting_memory');assert.equal(submissions,0);assert.equal(queue.get(first.id).details.candidates[0].id,'music');
  free=10000;queue.retry(first.id);
  await waitFor(()=>queue.get(first.id).status==='completed');const completed=queue.get(first.id);
  assert.equal(submissions,1);assert.equal(await fs.readFile(path.join(project,...completed.output.split('/')),'utf8'),'video-test-fixture');
  assert.equal(queue.estimate(input).sampleCount,1);
  forget=true;const second=queue.enqueue(input);
  await waitFor(()=>queue.get(second.id).status==='interrupted');assert.equal(submissions,2);assert.equal(queue.get(second.id).remoteId,'video-2');assert.equal(unverifiedDownloads,0);assert.match(queue.get(second.id).error,/does not prove/);
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(submissions,2);
});

test('MCP stdio tools connect to the local HTTP API and surface errors',async t=>{
  const http=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/runtime/services')return res.end(JSON.stringify({services:[{id:'images',status:'unavailable'}]}));
    if(req.url==='/api/runtime/asr/transcribe'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;return res.end(JSON.stringify({text:'heard speech',input:JSON.parse(body)}))}
    res.statusCode=503;res.end(JSON.stringify({error:'not ready'}));
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
  const client=new Client({name:'forge-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],env:{...process.env,FORGE_STUDIO_URL:`http://127.0.0.1:${http.address().port}`},stderr:'pipe'});
  t.after(()=>client.close());await client.connect(transport);
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.ok(names.includes('forge_services'));assert.ok(names.includes('forge_hardware'));
  assert.ok(names.includes('forge_load_asr_model'));assert.ok(names.includes('forge_transcribe_project_audio'));
  const services=await client.callTool({name:'forge_services',arguments:{}});
  assert.equal(JSON.parse(services.content[0].text).services[0].id,'images');
  const projectId=randomUUID();const transcription=await client.callTool({name:'forge_transcribe_project_audio',arguments:{projectId,path:'voices/line.wav'}});
  assert.deepEqual(JSON.parse(transcription.content[0].text),{text:'heard speech',input:{projectId,path:'voices/line.wav'}});
  const failure=await client.callTool({name:'forge_hardware',arguments:{}});
  assert.equal(failure.isError,true);
});
