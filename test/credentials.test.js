import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import {createCredentialStore} from '../runtime/credentials.js';
import {credentialService} from '../credential-service.js';
import {chatService} from '../chat-service.js';
import {findConfiguredHuggingFaceToken,createManagedSoundTokenProvider} from '../runtime/sound-credentials.js';

const fakeSecret='sk-fixture-only-NotARealCredential1234';
async function temporaryStore(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-credentials-test-'));
 t.after(async()=>{const resolved=await fs.realpath(dir),base=await fs.realpath(os.tmpdir());if(path.dirname(resolved)!==base||!path.basename(resolved).startsWith('forge-credentials-test-'))throw Error('Unexpected test path');await fs.rm(resolved,{recursive:true,force:true})});
 return {dir,store:createCredentialStore({directory:dir})};
}
async function listen(app){const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server}

test('Windows DPAPI encrypts stored keys and supports replace and remove', {skip:process.platform!=='win32'},async t=>{
 const {dir,store}=await temporaryStore(t);assert.equal(await store.get('openai'),'');assert.equal(store.status()[0].saved,false);
 await store.set('openai',fakeSecret);assert.equal(await store.get('openai'),fakeSecret);assert.equal(store.status()[0].saved,true);
 assert.equal((await fs.readFile(path.join(dir,'keys.sqlite'))).includes(Buffer.from(fakeSecret)),false);
 await store.set('openai','sk-fixture-replacement');assert.equal(await store.get('openai'),'sk-fixture-replacement');
 await store.set('huggingface','hf_fixture123');assert.equal(await store.get('huggingface'),'hf_fixture123');
 store.remove('openai');assert.equal(await store.get('openai'),'');assert.equal(await store.get('huggingface'),'hf_fixture123');
 await assert.rejects(store.set('other','x'),/provider/i);await assert.rejects(store.set('openai','bad\nkey'),/valid/i);
});

test('credential API requires local origin and never returns stored secrets',async t=>{
 const {store}=await temporaryStore(t);const app=express();credentialService({store}).configureServer({middlewares:app});const server=await listen(app);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
 const origin=`http://127.0.0.1:${server.address().port}`;const post=(route,body,headers={})=>fetch(`${origin}/api/credentials/${route}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Forge-Request':'credentials',...headers},body:JSON.stringify(body)});
 assert.equal((await post('save',{provider:'openai',secret:fakeSecret},{Origin:'http://evil.example'})).status,403);
 if(process.platform==='win32'){
  let response=await post('save',{provider:'openai',secret:fakeSecret});assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/fixture/);
  response=await post('status',{});const text=await response.text();assert.doesNotMatch(text,/fixture/);assert.equal(JSON.parse(text).credentials.find(c=>c.provider==='openai').saved,true);
  response=await post('remove',{provider:'openai'});assert.equal(response.status,200);assert.equal(await store.get('openai'),'');
 }
 assert.equal((await post('save',{provider:'openai',secret:'bad\nkey'})).status,400);
});

test('saved OpenAI key is used only for OpenAI, with a temporary key taking precedence',async t=>{
 let read=0,observed=[];const store={get:async provider=>{read++;assert.equal(provider,'openai');return fakeSecret}};
 const fetchImpl=async (target,options)=>{observed.push({host:target.host,auth:options.headers.Authorization});return Response.json({data:[{id:'test-model'}]})};
 const app=express();chatService({store,fetchImpl}).configureServer({middlewares:app});const server=await listen(app);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
 const origin=`http://127.0.0.1:${server.address().port}`;const post=body=>fetch(`${origin}/api/chat/models`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Forge-Request':'chat'},body:JSON.stringify(body)});
 assert.equal((await post({provider:'openai'})).status,200);assert.deepEqual(observed[0],{host:'api.openai.com',auth:`Bearer ${fakeSecret}`});
 assert.equal((await post({provider:'openai',apiKey:'temporary-fixture'})).status,200);assert.equal(observed[1].auth,'Bearer temporary-fixture');
 assert.equal((await post({provider:'compatible',endpoint:'http://127.0.0.1:1234/v1'})).status,200);assert.equal(observed[2].auth,undefined);assert.equal(read,1);
});

test('saved Hugging Face key is preferred and only provided to a managed sound worker',async()=>{
 let sharedReads=0;const readShared=async()=>{sharedReads++;return 'hf_shared_fixture'};
 const saved=await findConfiguredHuggingFaceToken({store:{get:async()=> 'hf_saved_fixture'},readShared});assert.equal(saved,'hf_saved_fixture');assert.equal(sharedReads,0);
 assert.equal(await findConfiguredHuggingFaceToken({store:{get:async()=>''},readShared}),'hf_shared_fixture');assert.equal(sharedReads,1);
 await assert.rejects(findConfiguredHuggingFaceToken({store:{get:async()=>{throw Error('locked')}},readShared}),/locked/);assert.equal(sharedReads,1);
 const readToken=async()=>saved;assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:false}}),readToken})(),'');
 assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:true}}),readToken})(),'hf_saved_fixture');
 assert.equal(await createManagedSoundTokenProvider({ownership:async()=>({sfx:{managed:true}}),readToken,customEndpoint:true})(),'');
});
