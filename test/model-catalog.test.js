import test from 'node:test';
import assert from 'node:assert/strict';
import {buildModelCatalog,modelCatalog} from '../runtime/model-catalog.js';
import {managedModels} from '../runtime/model-inventory.js';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Client as ModernClient} from '@modelcontextprotocol/client';
import {StdioClientTransport as ModernStdio} from '@modelcontextprotocol/client/stdio';

test('catalog separates definitions, service state, storage and supporting checkpoints',()=>{
 const source={state:'ready',observedAt:'2026-01-01T00:00:00Z',entries:[{id:'tts',installed:true,bytes:10,files:2,path:'C:/models/tts',error:null}]};
 const result=buildModelCatalog({services:[{id:'tts',status:'reachable',modelLoaded:false}],inventory:source,managedIds:managedModels.map(m=>m.id)});
 assert.equal(result.runtimeAvailable,true);assert.equal(new Set(result.models.map(m=>m.id)).size,result.models.length);
 assert.equal(result.models.find(m=>m.id==='tts').storage.bytes,10);assert.equal(result.models.find(m=>m.id==='tts').service.modelLoaded,false);
 assert.equal(result.models.find(m=>m.id==='images').storage.managed,false);assert.equal(result.models.find(m=>m.id==='images').storage.installed,null);
 assert.equal(result.models.find(m=>m.id==='trellis-encoder').role,'dependency');assert.equal(result.models.find(m=>m.id==='chat').service,null);
 assert.ok(result.models.every(m=>m.name&&m.purpose&&Array.isArray(m.inputs)&&Array.isArray(m.outputs)));
 assert.equal(buildModelCatalog().runtimeAvailable,false);
 for(const id of ['worldgen','hy-world','chat'])assert.ok(modelCatalog.some(m=>m.id===id&&!m.role),`${id} should be selectable`);
});

test('stdio MCP exposes the catalog through the read-only forge_models tool',async t=>{
 let request;const http=createServer((req,res)=>{request={method:req.method,path:req.url};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({models:[{id:'images',purpose:'Create images'}]}))});
 http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
 const client=new Client({name:'catalog-stdio-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(()=>client.close());
 await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],env:{...process.env,FORGE_STUDIO_URL:`http://127.0.0.1:${http.address().port}`},stderr:'pipe'}));
 const tool=(await client.listTools()).tools.find(tool=>tool.name==='forge_models');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);
 const result=await client.callTool({name:'forge_models',arguments:{}});assert.equal(JSON.parse(result.content[0].text).models[0].id,'images');assert.deepEqual(request,{method:'GET',path:'/api/models'});
});

test('stdio supports the 2026-07-28 protocol and the model catalog',async t=>{
 const http=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({models:[{id:'chat',purpose:'Chat'}]}))});
 http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
 const client=new ModernClient({name:'modern-stdio-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(()=>client.close());
 await client.connect(new ModernStdio({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],env:{...process.env,FORGE_STUDIO_URL:`http://127.0.0.1:${http.address().port}`},stderr:'pipe'}));
 assert.equal(client.getProtocolEra(),'modern');assert.equal(client.getNegotiatedProtocolVersion(),'2026-07-28');
 assert.ok((await client.listTools()).tools.some(tool=>tool.name==='forge_models'));
 const result=await client.callTool({name:'forge_models',arguments:{}});assert.equal(JSON.parse(result.content[0].text).models[0].id,'chat');
});

test('stdio rejects the older MCP protocol',async t=>{
 const client=new Client({name:'old-stdio-test',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
 t.after(()=>client.close());
 await assert.rejects(client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],stderr:'pipe'})));
});
