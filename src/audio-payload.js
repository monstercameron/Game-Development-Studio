// Convert the creator's audio settings to the exact durable queue request.
// Optional custom values override presets only when the creator enters them.
const isBlank=value=>value===undefined||value===null||String(value).trim()==='';
function numberSetting(value,fallback,{name,min,max,integer=false}){
  if(isBlank(value))return fallback;
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n)))throw Error(`${name} must be ${integer?'a whole number':'a number'} from ${min} to ${max}.`);
  return n;
}
function randomSeed(){
  if(!globalThis.crypto?.getRandomValues)throw Error('Secure random seeds are unavailable in this browser.');
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]&0x7fffffff;
}
export function audioPayload(type,projectId,draft,{seedGenerator=randomSeed}={}){
  const options=draft.options||[];
  if(type==='music'){
    const presets={'Full arrangement':'full','Melody':'melody','Off':'off'};
    const guidance=numberSetting(draft.musicGuidance,null,{name:'Guidance',min:0,max:20});
    const seed=isBlank(draft.seed)?seedGenerator():numberSetting(draft.seed,0,{name:'Seed',min:0,max:Number.MAX_SAFE_INTEGER,integer:true});
    return {type,projectId,request:{style:draft.prompt,lyrics:draft.second,
      duration_seconds:numberSetting(draft.musicDuration,Number.parseFloat(options[0])||15,{name:'Music duration',min:1,max:600}),
      cot:presets[options[1]]||'full',seed,
      ode_steps:numberSetting(draft.musicSteps,32,{name:'Music steps',min:1,max:100,integer:true}),
      title:draft.musicTitle||'',negative:draft.musicNegative||'',cfg_scale:guidance}};
  }
  if(type==='sfx'){
    const quality={'Balanced · 8 steps':8,'Draft · 4 steps':4,'Detailed · 20 steps':20};
    return {type,projectId,request:{prompt:draft.prompt,
      duration:numberSetting(draft.soundDuration,Number.parseFloat(options[0])||5,{name:'Sound duration',min:1,max:380}),
      steps:numberSetting(draft.soundSteps,quality[options[1]]||8,{name:'Sound steps',min:1,max:50,integer:true}),
      seed:numberSetting(draft.seed,-1,{name:'Seed',min:0,max:2147483647,integer:true})}};
  }
  if(type==='voices'){
    const speakers=['Ryan','Aiden','Vivian','Serena','Uncle_Fu','Dylan','Eric','Ono_Anna','Sohee'];
    const languages=['Auto','English','Chinese','Japanese','Korean','German','French','Russian','Portuguese','Spanish','Italian'];
    return {type,projectId,request:{text:draft.prompt,speaker:speakers.includes(options[0])?options[0]:'Ryan',
      language:languages.includes(options[1])?options[1]:'English',instruct:draft.second||'',
      max_new_tokens:numberSetting(draft.voiceMaxTokens,1024,{name:'Voice token limit',min:64,max:2048,integer:true})}};
  }
  throw Error('Unsupported audio workflow.');
}
