import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('TRELLIS.2 MCP tools forward rendering, loading and guarded offload',async t=>{
  const requests=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({path:req.url,body:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'application/json'});res.end('{}')});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const client=new Client({name:'trellis-mcp-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],env:{...process.env,FORGE_STUDIO_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'}));
  const projectId=randomUUID(),reference=`${randomUUID()}.png`;
  assert.notEqual((await client.callTool({name:'forge_queue_trellis',arguments:{projectId,reference,seed:7,steps:3,texture_size:512}})).isError,true);
  assert.deepEqual(requests[0],{path:'/api/runtime/jobs',body:{type:'trellis',projectId,request:{seed:7,steps:3,texture_size:512,references:[reference]}}});
  assert.notEqual((await client.callTool({name:'forge_load_trellis_model',arguments:{}})).isError,true);
  assert.notEqual((await client.callTool({name:'forge_offload_model',arguments:{id:'3d-trellis'}})).isError,true);
  assert.deepEqual(requests.slice(1).map(item=>item.path),['/api/runtime/models/3d-trellis/load','/api/runtime/models/3d-trellis/offload']);
  assert.equal((await client.callTool({name:'forge_queue_trellis',arguments:{projectId,reference,steps:51}})).isError,true);
});
