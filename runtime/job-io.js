import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

export async function saveAsset(projectFolder,folder,jobId,extension,url){
  const realProject=await fs.realpath(projectFolder);
  const destination=path.join(realProject,folder);
  // Older projects may predate these folders; create only known folders on demand.
  if(['3d','masks','motion'].includes(folder))try{await fs.mkdir(destination)}catch(error){if(error.code!=='EEXIST')throw error}
  const info=await fs.lstat(destination);
  if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(destination)!==destination)throw Error('Project asset folder is missing or is a link.');
  const name=`forge-${jobId}.${extension}`,output=path.join(destination,name),temp=path.join(destination,`.${name}.${randomUUID()}.part`),conflict=path.join(destination,`.${name}.conflict`);
  // A recorded collision is not proof that the existing file belongs to this
  // job. Keep retries blocked until the user moves the conflicting file away.
  async function checkConflict(){
    let marker;try{marker=await fs.lstat(conflict)}catch(error){if(error.code==='ENOENT')return;throw error}
    if(!marker.isFile()||marker.isSymbolicLink())throw Error('The output conflict record is not a regular file. Review the project folder.');
    try{await fs.lstat(output)}catch(error){if(error.code!=='ENOENT')throw error;await fs.unlink(conflict).catch(reason=>{if(reason.code!=='ENOENT')throw reason});return}
    throw Error('A conflicting output file was preserved. Move or rename it before retrying.');
  }
  await checkConflict();
  let complete=false;try{const existing=await fs.lstat(output);if(existing.isSymbolicLink()||!existing.isFile())throw Error('The output path is not a regular file.');if(!existing.size)throw Error('An empty file already occupies the output path. Review it before retrying.');complete=true}catch(error){if(error.code!=='ENOENT')throw error}
  if(complete)await checkConflict();
  if(!complete){
    const response=await fetch(url,{signal:AbortSignal.timeout(120000),redirect:'error'});
    if(!response.ok||!response.body)throw Error(`Could not download the asset (HTTP ${response.status}).`);
    try{
      await pipeline(Readable.fromWeb(response.body),createWriteStream(temp,{flags:'wx'}));
      if(!(await fs.stat(temp)).size)throw Error('The engine returned an empty asset.');
      // A hard link commits the completed file atomically without replacing an
      // asset created after the initial check. Both names are on the same volume.
      try{await fs.link(temp,output)}catch(error){
        if(error.code==='EEXIST'){
          try{await fs.writeFile(conflict,'An output file appeared during download. Move or rename it before retrying.\n',{flag:'wx'})}catch(markerError){if(markerError.code!=='EEXIST')throw Error('The output path was occupied and preserved, but its conflict record could not be saved. Review the file before retrying.')}
          throw Error('The output path was occupied during download. The existing file was preserved; move or rename it before retrying.');
        }
        if(['EPERM','EOPNOTSUPP','ENOTSUP','EXDEV','ENOSYS'].includes(error.code))throw Error('The project filesystem cannot safely commit this asset without overwriting. Use a filesystem that supports hard links.');
        throw error;
      }
    }
    finally{await fs.rm(temp,{force:true}).catch(()=>{})}
  }
  return `${folder}/${name}`;
}
