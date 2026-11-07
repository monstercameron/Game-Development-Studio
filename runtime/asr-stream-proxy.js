import net from 'node:net';
import {localAsrUrl} from './asr-client.js';

// The browser speaks the upstream PCM16 protocol unchanged. This is a fixed
// route to a fixed local origin, not an arbitrary HTTP or WebSocket proxy.
export function attachAsrStreamProxy(server,{baseUrl=process.env.FORGE_ASR_URL||'http://127.0.0.1:8282'}={}){
  const upstream=localAsrUrl(baseUrl);
  server.on('upgrade',(request,socket,head)=>{
    const host=request.headers.host||'',origin=request.headers.origin,key=request.headers['sec-websocket-key'];
    const reject=(status,reason)=>{if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)};
    if(request.url!=='/api/asr/realtime')return reject(404,'Not Found');
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)||(origin&&origin!==`http://${host}`))return reject(403,'Forbidden');
    if(request.method!=='GET'||String(request.headers.upgrade).toLowerCase()!=='websocket'||request.headers['sec-websocket-version']!=='13'||typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key))return reject(400,'Bad Request');
    const target=net.createConnection({host:upstream.hostname==='[::1]'?'::1':upstream.hostname,port:Number(upstream.port||80)});
    let connected=false,rejected=false;
    target.setTimeout(5000,()=>target.destroy());
    target.once('connect',()=>{
      connected=true;target.setTimeout(0);
      target.write(`GET /v1/audio/transcriptions/realtime HTTP/1.1\r\nHost: ${upstream.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
      if(head.length)target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error',()=>{if(!connected){rejected=true;reject(503,'Service Unavailable')}else socket.destroy()});
    target.on('close',()=>{if(!connected){if(!rejected)reject(503,'Service Unavailable')}else if(!socket.destroyed)socket.destroy()});
    socket.on('error',()=>target.destroy());socket.on('close',()=>target.destroy());
  });
}
