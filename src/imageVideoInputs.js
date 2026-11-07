// These are the controls accepted by the currently connected Qwen and H3 APIs.
const imageSizes={'Landscape · 16:9':[1024,576],'Square · 1:1':[1024,1024],'Portrait · 9:16':[576,1024]};
const imageQualities={'Balanced':30,'Draft':12,'High quality':40};
const videoAspects={'Landscape · 16:9':'landscape','Square · 1:1':'square','Portrait · 9:16':'portrait'};
const videoFrames={'About 2 seconds':56,'About 5 seconds':124,'About 7 seconds':175,'About 10 seconds':243};
const hasValue=value=>value!==undefined&&value!==null&&value!=='';

function integer(value,fallback,label,min,max,divisor=1){
  const n=hasValue(value)?Number(value):fallback;
  if(!Number.isSafeInteger(n)||n<min||n>max||n%divisor!==0)throw Error(`${label} must be ${min}–${max}${divisor>1?` and a multiple of ${divisor}`:''}.`);
  return n;
}

export function imageRequest(draft){
  const [defaultWidth,defaultHeight]=imageSizes[draft.options?.[0]]||[1024,576];
  const width=integer(draft.imageWidth,defaultWidth,'Width',32,2048,32);
  const height=integer(draft.imageHeight,defaultHeight,'Height',32,2048,32);
  const num_inference_steps=integer(draft.imageSteps,imageQualities[draft.options?.[1]]||30,'Image steps',1,100);
  const negative=(draft.imageNegativePrompt||'').trim();
  if(negative.length>4000)throw Error('The negative prompt must be at most 4,000 characters.');
  const guidance=hasValue(draft.imageGuidance)?Number(draft.imageGuidance):2;
  if(negative&&(!Number.isFinite(guidance)||guidance<=1||guidance>10))throw Error('Negative prompt guidance must be greater than 1 and no more than 10.');
  const seed=hasValue(draft.seed)?integer(draft.seed,0,'Seed',0,Number.MAX_SAFE_INTEGER):undefined;
  return {prompt:draft.prompt,width,height,num_inference_steps,references:draft.referenceIds||[],
    ...(seed===undefined?{}:{seed}),...(negative?{negative_prompt:negative,true_cfg_scale:guidance}:{})};
}

export function videoRequest(draft){
  const steps=integer(draft.videoSteps,12,'Video steps',8,30);
  if(![8,12,20,30].includes(steps))throw Error('Choose one of the supported video quality settings.');
  return {prompt:draft.prompt,references:draft.referenceIds||['00000000-0000-0000-0000-000000000000.png'],
    aspect:videoAspects[draft.options?.[0]]||'landscape',frames:videoFrames[draft.options?.[1]]||124,steps};
}
