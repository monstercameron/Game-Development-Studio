import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { audioPayload } from '../src/audio-payload.js';
import { JobQueue, estimateFromJobs } from '../runtime/jobs.js';
import { rerunRequest } from '../src/rerun-request.js';

test('audio settings map to the supported worker parameters and respect overrides',()=>{
  const music=audioPayload('music','project',{prompt:'ambient',second:'[Instrumental]',options:['30 seconds','Melody'],seed:'42',musicDuration:'47.5',musicSteps:'24',musicGuidance:'3.2',musicNegative:'drums',musicTitle:'Forest'},{seedGenerator:()=>{throw Error('Must not generate a seed')}});
  assert.deepEqual(music.request,{style:'ambient',lyrics:'[Instrumental]',duration_seconds:47.5,cot:'melody',seed:42,ode_steps:24,title:'Forest',negative:'drums',cfg_scale:3.2});
  const random=audioPayload('music','project',{prompt:'ambient',second:'[Instrumental]',options:['15 seconds','Full arrangement'],seed:''},{seedGenerator:()=>1234});
  assert.equal(random.request.seed,1234);assert.equal(random.request.ode_steps,32);assert.equal(random.request.cfg_scale,null);
  const sfx=audioPayload('sfx','project',{prompt:'door creak',options:['10 seconds','Draft · 4 steps'],soundDuration:'2.5',soundSteps:'11',seed:''});
  assert.deepEqual(sfx.request,{prompt:'door creak',duration:2.5,steps:11,seed:-1});
  const voice=audioPayload('voices','project',{prompt:'hello',second:'whisper',options:['Vivian','English'],voiceMaxTokens:'768'});
  assert.deepEqual(voice.request,{text:'hello',speaker:'Vivian',language:'English',instruct:'whisper',max_new_tokens:768});
});

test('audio settings reject invalid custom values before queueing',()=>{
  const music={prompt:'x',second:'x',options:['15 seconds','Off'],seed:'1'};
  assert.throws(()=>audioPayload('music','p',{...music,musicGuidance:'20.1'}),/Guidance/);
  assert.throws(()=>audioPayload('music','p',{...music,musicSteps:'2.2'}),/Music steps/);
  assert.throws(()=>audioPayload('music','p',{...music,seed:'-1'}),/Seed/);
  assert.throws(()=>audioPayload('sfx','p',{prompt:'x',options:['5 seconds','Balanced · 8 steps'],soundDuration:'381'}),/Sound duration/);
  assert.throws(()=>audioPayload('voices','p',{prompt:'x',options:[],voiceMaxTokens:'63'}),/Voice token limit/);
});

test('reruns preserve fine-tuning while changing only prompt and requested seed',()=>{
  const music={type:'music',request:{style:'ambient',lyrics:'[Instrumental]',duration_seconds:47.5,cot:'melody',seed:42,ode_steps:24,title:'Forest',negative:'drums',cfg_scale:3.2}};
  assert.deepEqual(rerunRequest(music,'orchestral',{seed:77}),{...music.request,style:'orchestral',seed:77});
  assert.equal(music.request.style,'ambient');assert.equal(music.request.seed,42);
  const sound={type:'sfx',request:{prompt:'door creak',duration:2.5,steps:11,seed:8}};
  assert.deepEqual(rerunRequest(sound,'door slam',{seed:99}),{...sound.request,prompt:'door slam',seed:99});
  const voice={type:'voices',request:{text:'Hello',speaker:'Vivian',language:'English',instruct:'whisper',max_new_tokens:768}};
  assert.deepEqual(rerunRequest(voice,'Goodbye',{seed:99}),{...voice.request,text:'Goodbye'});
  const image={type:'images',request:{prompt:'forest',references:['first.png'],width:1024}};
  assert.deepEqual(rerunRequest(image,'forest at night',{reference:'second.png'}).references,['first.png','second.png']);
  assert.deepEqual(image.request.references,['first.png']);
});

test('music timing history distinguishes single and dual guidance branches',()=>{
  const request={duration_seconds:15,cot:'full',ode_steps:32,cfg_scale:1};
  const job={type:'music',status:'completed',request,startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:30Z'};
  assert.equal(estimateFromJobs([job],{type:'music',request}).sampleCount,1);
  assert.equal(estimateFromJobs([job],{type:'music',request:{...request,cfg_scale:2}}).sampleCount,0);
  assert.equal(estimateFromJobs([job],{type:'music',request:{...request,cfg_scale:null}}).sampleCount,1);
});

test('fine-tuned audio inputs persist in the durable queue and invalid guidance is rejected',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-audio-settings-'));
  const projects=path.join(dir,'projects'),folder=path.join(projects,'game'),projectId=randomUUID();
  await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'.forge-project.json'),JSON.stringify({id:projectId}));
  const state=path.join(dir,'runtime');let queue=new JobQueue({directory:state,projects,autoStart:false});
  t.after(()=>queue?.stop());
  const requests=[
    audioPayload('music',projectId,{prompt:'ambient',second:'[Instrumental]',options:['30 seconds','Full arrangement'],seed:'42',musicDuration:'42.5',musicSteps:'16',musicGuidance:'2',musicNegative:'brass'}),
    audioPayload('sfx',projectId,{prompt:'a twig snaps',options:['5 seconds','Balanced · 8 steps'],seed:'123',soundDuration:'2.5',soundSteps:'9'}),
    audioPayload('voices',projectId,{prompt:'Hello',second:'soft',options:['Ryan','English'],voiceMaxTokens:'384'}),
  ];
  const jobs=requests.map(value=>queue.enqueue(value));
  assert.throws(()=>queue.enqueue({...requests[0],request:{...requests[0].request,cfg_scale:21}}),/CFG scale/);
  queue.stop();queue=new JobQueue({directory:state,projects,autoStart:false});
  for(let i=0;i<jobs.length;i++)assert.deepEqual(queue.get(jobs[i].id).request,requests[i].request);
});
