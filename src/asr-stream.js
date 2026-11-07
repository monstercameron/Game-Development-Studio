// Browser client for Forge's same-origin PCM16 transcription proxy.
export function openAsrStream({url,sampleRate,onDelta=()=>{},onFinal=()=>{},WebSocketImpl=WebSocket,timeoutMs=15000,completionTimeoutMs=120000}){
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000)throw Error('Microphone sample rate must be between 8 and 96 kHz.');
  const socket=new WebSocketImpl(url);socket.binaryType='arraybuffer';
  let configured=false,committed=false,settled=false,total=0,readyResolve,readyReject,doneResolve,doneReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
  const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject});
  ready.catch(()=>{});done.catch(()=>{});
  let timer=setTimeout(()=>fail(Error('Speech session did not become ready.')),timeoutMs);
  function fail(error){if(settled)return;settled=true;clearTimeout(timer);readyReject(error);doneReject(error);try{socket.close()}catch{}}
  socket.addEventListener('message',event=>{
    let data;try{data=JSON.parse(event.data)}catch{return fail(Error('Speech service sent an invalid event.'))}
    try{
      if(data.type==='session.created'){socket.send(JSON.stringify({type:'session.update',session:{sample_rate:sampleRate}}));return}
      if(data.type==='session.updated'){if(!configured){configured=true;clearTimeout(timer);readyResolve()}return}
      if(data.type==='error')return fail(Error(String(data.message||'Speech service error.').slice(0,500)));
      if(data.type==='conversation.item.input_audio_transcription.delta'){if(typeof data.delta==='string')onDelta(data.delta);return}
      if(data.type==='conversation.item.input_audio_transcription.completed'){
        if(typeof data.transcript!=='string')return fail(Error('Speech service returned an invalid transcript.'));
        onFinal(data.transcript);
        if(committed&&!settled){settled=true;clearTimeout(timer);doneResolve(data);socket.close()}
      }
    }catch(error){fail(error instanceof Error?error:Error('Speech session failed.'))}
  });
  socket.addEventListener('error',()=>fail(Error('Could not connect to the speech service.')));
  socket.addEventListener('close',()=>{if(!settled)fail(Error('Speech service disconnected before the transcript finished.'))});
  return {ready,done,send(bytes){
    if(!configured||committed||settled||socket.readyState!==1)throw Error('Speech session is not accepting audio.');
    if(!(bytes instanceof ArrayBuffer)||!bytes.byteLength||bytes.byteLength%2||bytes.byteLength>1024*1024)throw Error('Invalid microphone audio frame.');
    if(socket.bufferedAmount+bytes.byteLength>2*1024*1024)throw Error('Speech service is not consuming audio fast enough.');
    if(total+bytes.byteLength>64*1024*1024)throw Error('Speech session exceeded its audio limit.');
    total+=bytes.byteLength;socket.send(bytes);
  },commit(){if(!configured||committed||settled||socket.readyState!==1)throw Error('Speech session is not accepting audio.');committed=true;timer=setTimeout(()=>fail(Error('Speech transcription did not finish in time.')),completionTimeoutMs);socket.send(JSON.stringify({type:'input_audio_buffer.commit'}))},cancel(){fail(Error('Speech session cancelled.'))}};
}
