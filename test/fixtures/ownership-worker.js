import http from 'node:http';

let token='',nonce='',engine='',mode='normal';
const server=http.createServer((req,res)=>{
  if(req.url!=='/api/forge/identity'||req.headers['x-forge-engine-token']!==token){res.writeHead(403);return res.end('{}')}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({engine,nonce:mode==='wrong-nonce'?'0'.repeat(64):nonce,pid:mode==='wrong-pid'?process.ppid:process.pid}));
});
process.on('message',message=>{
  if(message.type==='start'){
    ({token,nonce,engine}=message);server.listen(message.port,'127.0.0.1',()=>process.send?.({type:'ready'}));
  }else if(message.type==='mode'){mode=message.mode;process.send?.({type:'mode-ready'})}
  else if(message.type==='stop')server.close(()=>process.exit(0));
});
