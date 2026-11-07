import fs from 'node:fs/promises';
import path from 'node:path';
import {findProject,projectsRoot} from './jobs.js';
import {readAssetMetadata} from '../project-assets.js';

function safeRelative(value){return typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes(':')&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))}
function inside(root,target){const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)}

// Resolve display locations without changing the queue's durable engine record.
// Project metadata retains the original output when an asset is renamed.
export async function resolveAssetOutputs(jobs,{root=projectsRoot}={}){
  const ids=[...new Set(jobs.filter(job=>job.status==='completed'&&job.output).map(job=>job.projectId))];
  const byProject=new Map();
  await Promise.all(ids.map(async id=>{
    try{
      const folder=await fs.realpath(findProject(id,root)),metadata=await readAssetMetadata(folder),needed=new Set(jobs.filter(job=>job.projectId===id&&job.output).map(job=>job.output)),aliases=new Map();
      for(const [relative,details] of Object.entries(metadata)){
        if(!safeRelative(relative)||!safeRelative(details?.sourceOutput)||!needed.has(details.sourceOutput))continue;
        const candidate=path.resolve(folder,...relative.split('/'));if(!inside(folder,candidate))continue;
        try{const info=await fs.lstat(candidate);if(!info.isFile()||info.isSymbolicLink()||!inside(folder,await fs.realpath(candidate)))continue}
        catch{continue}
        // Multiple existing aliases are ambiguous; retain the original path.
        if(aliases.has(details.sourceOutput))aliases.set(details.sourceOutput,null);else aliases.set(details.sourceOutput,relative);
      }
      byProject.set(id,aliases);
    }catch{}
  }));
  return jobs.map(job=>{const resolved=job.status==='completed'?byProject.get(job.projectId)?.get(job.output):null;return resolved&&resolved!==job.output?{...job,output:resolved,originalOutput:job.output}:job});
}
