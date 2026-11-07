import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureChatReady,isStudioQwen} from '../src/chat-autostart.js';
const connection={provider:'compatible',endpoint:'http://127.0.0.1:8098/v1'};
const missing=()=>Object.assign(Error('connection refused'),{code:'server_unreachable'});
const signal=()=>new AbortController().signal;
test('only the local Qwen alias is eligible for automatic startup',()=>{
 assert.equal(isStudioQwen({...connection,model:'qwen3.8-27b'}),true);
 for(const other of [{provider:'openai',endpoint:connection.endpoint,model:'qwen3.8-27b'},{...connection,endpoint:'http://127.0.0.1:1234/v1',model:'qwen3.8-27b'},{...connection,model:'other'},{...connection,endpoint:'http://localhost:8098/v1?foo=1',model:'qwen3.8-27b'}])assert.equal(isStudioQwen(other),false);
});
test('starts an unavailable local server once and waits for readiness',async()=>{
 let probes=0,starts=0,clock=0;const statuses=[];
 await ensureChatReady({connection,model:'qwen3.8-27b',signal:signal(),probe:async()=>{if(++probes<3)throw missing()},isLoading:async()=>true,start:async()=>{starts++},sleep:async()=>{clock+=2000},now:()=>clock,onStatus:v=>statuses.push(v)});
 assert.equal(starts,0);assert.equal(probes,3);assert.match(statuses[0],/Loading Qwen/);
 probes=0;clock=0;
 await ensureChatReady({connection,model:'qwen3.8-27b',signal:signal(),probe:async()=>{if(++probes<3)throw missing()},isLoading:async()=>false,start:async()=>{starts++},sleep:async()=>{clock+=2000},now:()=>clock});
 assert.equal(starts,1);assert.equal(probes,3);
});
test('leaves a ready or nonlocal server alone and surfaces unrelated errors',async()=>{
 let starts=0,probes=0;const start=async()=>{starts++};
 await ensureChatReady({connection,model:'qwen3.8-27b',signal:signal(),probe:async()=>{probes++},start});
 await ensureChatReady({connection:{...connection,endpoint:'http://127.0.0.1:1234/v1'},model:'qwen3.8-27b',signal:signal(),probe:async()=>{probes++},start});
 assert.equal(starts,0);assert.equal(probes,1);
 await assert.rejects(ensureChatReady({connection,model:'qwen3.8-27b',signal:signal(),probe:async()=>{throw Object.assign(Error('unauthorized'),{status:401})},start}),/unauthorized/);
 assert.equal(starts,0);
});
test('startup failure and cancellation never submit a message',async()=>{
 let clock=0;const controller=new AbortController();
 await assert.rejects(ensureChatReady({connection,model:'qwen3.8-27b',signal:controller.signal,probe:async()=>{throw missing()},isLoading:async()=>false,start:async()=>{},sleep:async()=>{clock+=2000},now:()=>clock}),/did not become ready/);
 controller.abort();await assert.rejects(ensureChatReady({connection,model:'qwen3.8-27b',signal:controller.signal,probe:async()=>{},start:async()=>{}}),e=>e.name==='AbortError');
});

test('a concurrent startup is awaited instead of starting a second model',async()=>{
 let checks=0,probes=0,clock=0;
 await ensureChatReady({connection,model:'qwen3.8-27b',signal:signal(),probe:async()=>{if(++probes===1)throw missing()},isLoading:async()=>++checks>1,start:async()=>{throw Error('Queue already reserved')},sleep:async()=>{clock+=2000},now:()=>clock});
 assert.equal(checks,2);assert.equal(probes,2);
});
