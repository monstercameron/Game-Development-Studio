// H3 supplies a rolling sd-cli log. Only display a recognized sampling line;
// loading bars and arbitrary worker log text are not reliable progress data.
export function videoProgress(details, steps){
  if(typeof details!=='string'||!Number.isInteger(steps)||steps<1)return null;
  const clean=details.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const pattern=/\b(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+\s*s\/it\s*-\s*ETA\s+((?:\d+:){1,2}\d{2})/gi;
  let match,last=null;
  while((match=pattern.exec(clean))){
    const current=Number(match[1]),total=Number(match[2]);
    if(total===steps&&current>=0&&current<=total)last={current,total,eta:match[3]};
  }
  return last?`Rendering video · step ${last.current}/${last.total} · ETA ${last.eta}`:null;
}
