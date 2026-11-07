import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('music MCP forwards guidance and negative style to the durable queue API',async t=>{
  const submissions=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    submissions.push({path:req.url,body:JSON.parse(body)});
    res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({job:{id:'test-job'}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const client=new Client({name:'audio-payload-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../runtime/mcp.js',import.meta.url))],env:{...process.env,FORGE_STUDIO_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'}));
  const projectId=randomUUID();
  const input={projectId,style:'piano',lyrics:'[Instrumental]',duration_seconds:20,seed:12,cot:'full',ode_steps:24,negative:'brass',cfg_scale:3};
  const response=await client.callTool({name:'forge_queue_music',arguments:input});
  assert.equal(response.isError,false);assert.equal(submissions.length,1);assert.equal(submissions[0].path,'/api/runtime/jobs');
  const {projectId:_,...request}=input;
  assert.deepEqual(submissions[0].body,{type:'music',projectId,request:{...request,title:''}});
  const rejected=await client.callTool({name:'forge_queue_music',arguments:{...input,cfg_scale:21}});
  assert.equal(rejected.isError,true);assert.equal(submissions.length,1);
});
