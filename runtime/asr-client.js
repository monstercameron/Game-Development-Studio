// Narrow client for the local NeMo-Speech.cpp transcription service.
// Starting the model and GPU admission remain the caller's responsibility.
const MAX_WAV_BYTES=32*1024*1024;
const MAX_FRAME_BYTES=1024*1024;
const MAX_BUFFERED_BYTES=2*1024*1024;
const MAX_SESSION_BYTES=64*1024*1024;

export function localAsrUrl(value='http://127.0.0.1:8282'){
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Speech service must be a local HTTP origin.');
  return url;
}
function pcmBytes(frame){
  if(!(frame instanceof Uint8Array)||frame.byteLength===0||frame.byteLength%2||frame.byteLength>MAX_FRAME_BYTES)throw Error('Audio frames must contain 16-bit PCM samples and be at most 1 MiB.');
  return frame;
}
export async function transcribeWav(bytes,{baseUrl,timeoutMs=120000,signal,fetcher=fetch}={}){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<44||bytes.byteLength>MAX_WAV_BYTES||Buffer.from(bytes.subarray(0,4)).toString('ascii')!=='RIFF'||Buffer.from(bytes.subarray(8,12)).toString('ascii')!=='WAVE')throw Error('Provide a RIFF/WAVE file between 44 bytes and 32 MiB.');
  const form=new FormData();form.set('file',new Blob([bytes],{type:'audio/wav'}),'audio.wav');
  const timeout=AbortSignal.timeout(timeoutMs);
  const response=await fetcher(new URL('/v1/audio/transcriptions',localAsrUrl(baseUrl)),{method:'POST',body:form,signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
  const body=await response.json();
  if(!response.ok)throw Error(`Speech service returned HTTP ${response.status}: ${String(body?.error?.message||'Transcription failed.').slice(0,500)}`);
  if(typeof body?.text!=='string')throw Error('Speech service returned an invalid transcript.');
  return {text:body.text};
}

// Emits the server's original partial and final events, without inventing
// timestamps or treating partial text as committed. Every session is isolated.
export function openTranscriptionStream({baseUrl,sampleRate=16000,onEvent=()=>{},WebSocketImpl=WebSocket,timeoutMs=15000,completionTimeoutMs=120000}={}){
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000)throw Error('Sample rate must be 8000 to 96000 Hz.');
  const url=localAsrUrl(baseUrl);url.protocol='ws:';url.pathname='/v1/audio/transcriptions/realtime';
  const socket=new WebSocketImpl(url);socket.binaryType='arraybuffer';
  let settled=false,configured=false,finished=false,closed=false,total=0,readyResolve,readyReject,doneResolve,doneReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
  const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject});
  // A consumer can attach handlers after opening without triggering an unhandled rejection.
  ready.catch(()=>{});done.catch(()=>{});
  let timer=setTimeout(()=>fail(Error('Speech session did not become ready.')),timeoutMs);timer.unref?.();
  function fail(error){if(settled)return;settled=true;clearTimeout(timer);readyReject(error);doneReject(error);try{socket.close()}catch{}}
  socket.addEventListener('message',event=>{
    let data;try{data=JSON.parse(event.data)}catch{return fail(Error('Speech service sent an invalid event.'))}
    if(data.type==='session.created'){socket.send(JSON.stringify({type:'session.update',session:{sample_rate:sampleRate}}));return}
    if(data.type==='session.updated'){configured=true;clearTimeout(timer);readyResolve();return}
    if(data.type==='error')return fail(Error(String(data.message||'Speech service error.').slice(0,500)));
    if(data.type==='conversation.item.input_audio_transcription.delta'||data.type==='conversation.item.input_audio_transcription.completed'){
      try{onEvent(data)}catch(error){return fail(error instanceof Error?error:Error('Speech event handler failed.'))}
      if(data.type.endsWith('.completed')&&finished&&!settled){settled=true;doneResolve(data);socket.close()}
    }
  });
  socket.addEventListener('error',()=>fail(Error('Speech service connection failed.')));
  socket.addEventListener('close',()=>{closed=true;if(!settled)fail(Error('Speech service connection closed before transcription completed.'))});
  return {ready,done,send(frame){
    if(!configured||settled||closed||finished||socket.readyState!==1)throw Error('Speech session is not accepting audio.');
    const data=pcmBytes(frame);if(socket.bufferedAmount+data.byteLength>MAX_BUFFERED_BYTES)throw Error('Speech service is not consuming audio fast enough.');
    if(total+data.byteLength>MAX_SESSION_BYTES)throw Error('Speech session audio exceeds 64 MiB.');
    total+=data.byteLength;socket.send(data);
  },commit(){if(!configured||settled||closed||finished||socket.readyState!==1)throw Error('Speech session is not accepting audio.');finished=true;timer=setTimeout(()=>fail(Error('Speech transcription did not finish in time.')),completionTimeoutMs);timer.unref?.();socket.send(JSON.stringify({type:'input_audio_buffer.commit'}))},close(){fail(Error('Speech session was cancelled.'))}};
}
