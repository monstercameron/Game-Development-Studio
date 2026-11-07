import {credentialStore} from './runtime/credentials.js';
import { Readable } from 'node:stream';
import os from 'node:os';

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
function destination(input){
 if(input.provider==='openai')return new URL('https://api.openai.com/v1/');
 if(input.provider==='lmstudio')return new URL('http://127.0.0.1:1234/v1/');
 if(input.provider!=='compatible')throw Error('Choose a supported connection.');
 let u;try{u=new URL(input.endpoint)}catch{throw Error('Enter a valid compatible server URL.')}
 const h=u.hostname.toLowerCase(), parts=h.split('.').map(Number);
 const privateV4=parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(parts[0]===127||parts[0]===10||(parts[0]===192&&parts[1]===168)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31));
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!(h==='localhost'||privateV4))throw Error('Use localhost or a private IPv4 address for compatible servers.');
 u.pathname=u.pathname.replace(/\/+$/,'')+'/';return u;
}
function sanitize(message,key){return String(message||'Request failed.').slice(0,1600).split(key||'\u0000').join('[redacted]')}
export function chatService({store=credentialStore,fetchImpl=fetch}={}){
 function attach(server){server.middlewares.use('/api/chat',async(req,res)=>{
  const host=req.headers.host;
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host||'')||req.headers.origin!==`http://${host}`||req.headers['x-forge-request']!=='chat'||req.method!=='POST')return json(res,403,{error:'Local studio requests only.'});
  let raw='',input;try{for await(const chunk of req){raw+=chunk;if(raw.length>1000000)return json(res,413,{error:'Chat request is too large.'})}input=JSON.parse(raw)}catch{return json(res,400,{error:'Invalid request.'})}
  const route=new URL(req.url,'http://127.0.0.1').pathname;
  if(route==='/status')return json(res,200,{freeMemoryGiB:Math.round(os.freemem()/107374182.4)/10,estimatedModelGiB:18.75});
  let target;try{target=destination(input)}catch(e){return json(res,400,{error:e.message})}
  let key='';
  if(input.provider==='openai'){
   key=typeof input.apiKey==='string'?input.apiKey.trim():'';
   if(!key){try{key=await store.get('openai')}catch{return json(res,500,{error:'Could not unlock the saved OpenAI key. Check the studio Windows account.'})}}
   key=key||process.env.OPENAI_API_KEY||'';
   if(!key)return json(res,400,{error:'Save an OpenAI API key in studio settings, enter one here, or set OPENAI_API_KEY.'});
  }
  const headers={'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})};
  const abort=new AbortController();let timer=setTimeout(()=>abort.abort(),route==='/models'?15000:600000);res.on('close',()=>{clearTimeout(timer);abort.abort()});
  try{
   if(route==='/models'){
    const upstream=await fetchImpl(new URL('models',target),{headers,redirect:'error',signal:abort.signal});const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok)return json(res,upstream.status,{error:sanitize(data?.error?.message||`Server returned ${upstream.status}.`,key)});
    const models=Array.isArray(data.data)?data.data.filter(x=>typeof x.id==='string').map(x=>x.id).slice(0,1000):[];return json(res,200,{models});
   }
   if(route!=='/completions')return json(res,404,{error:'Not found.'});
   if(typeof input.model!=='string'||!input.model.trim()||input.model.length>300||!Array.isArray(input.messages)||!input.messages.length||input.messages.length>150)return json(res,400,{error:'Choose a model and provide a conversation.'});
   if(!input.messages.every(m=>['system','user','assistant'].includes(m.role)&&typeof m.content==='string'&&m.content.length<=100000))return json(res,400,{error:'Invalid conversation.'});
   const payload={model:input.model,messages:input.messages,stream:true,temperature:Math.min(2,Math.max(0,Number(input.temperature)||0))};
   // Request real completion-token counts on providers known to support this
   // OpenAI streaming option. Other compatible servers may reject it.
   if(input.provider==='openai'||(input.provider==='compatible'&&['127.0.0.1','localhost'].includes(target.hostname)&&target.port==='8098'))payload.stream_options={include_usage:true};
   const maxTokens=input.maxTokens===undefined?1024:Number(input.maxTokens);
   if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>262144)return json(res,400,{error:'Maximum output tokens must be a whole number from 1 to 262,144.'});
   if(input.provider==='openai')payload.max_completion_tokens=maxTokens;else payload.max_tokens=maxTokens;
   if(input.effort!==undefined&&input.effort!=='auto'){
    if(!['none','low','medium','high'].includes(input.effort))return json(res,400,{error:'Choose a valid thinking effort.'});
    payload.reasoning_effort=input.effort;
    // llama.cpp supports a per-request thinking budget; other compatible
    // servers may not understand that extension, so do not send it to them.
    if(input.provider==='compatible'&&target.hostname==='127.0.0.1'&&target.port==='8098'&&input.effort!=='none'){
     payload.chat_template_kwargs={enable_thinking:true};
     payload.reasoning_budget_tokens={low:256,medium:768,high:1536}[input.effort];
    }
   }
   if(input.format==='json')payload.response_format={type:'json_object'};
   if(input.format==='schema'){
    if(!input.schema||typeof input.schema!=='object'||Array.isArray(input.schema))return json(res,400,{error:'Enter a valid JSON schema object.'});
    payload.response_format={type:'json_schema',json_schema:{name:'studio_output',strict:true,schema:input.schema}};
   }
   const upstream=await fetchImpl(new URL('chat/completions',target),{method:'POST',headers,body:JSON.stringify(payload),redirect:'error',signal:abort.signal});
   if(!upstream.ok){const data=await upstream.json().catch(()=>({}));return json(res,upstream.status,{error:sanitize(data?.error?.message||`Server returned ${upstream.status}.`,key)})}
   if(!upstream.body)return json(res,502,{error:'The model server returned an empty response.'});
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
   Readable.fromWeb(upstream.body).on('error',()=>res.destroy()).pipe(res);
  }catch(error){if(!res.headersSent&&!res.destroyed)json(res,502,{error:sanitize(error.name==='AbortError'?'The model server timed out or the request was stopped.':`Could not connect to the model server: ${error.message}`,key),...(error.cause?.code==='ECONNREFUSED'?{code:'server_unreachable'}:{})});else if(!res.destroyed)res.destroy()}
  finally{if(!res.headersSent)clearTimeout(timer)}
 })}
 return {name:'forge-chat',configureServer:attach,configurePreviewServer:attach};
}
