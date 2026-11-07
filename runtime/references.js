import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_REFERENCE_BYTES=10*1024*1024;
export const MAX_REFERENCES_BYTES=40*1024*1024;
const idPattern=/^[a-f0-9-]{36}\.(png|jpg|webp)$/i;

function imageType(bytes){
  if(bytes.length<12||bytes.length>MAX_REFERENCE_BYTES)throw Error('Each reference image must be between 12 bytes and 10 MiB.');
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return ['png','image/png'];
  if(bytes[0]===255&&bytes[1]===216)return ['jpg','image/jpeg'];
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return ['webp','image/webp'];
  throw Error('Reference images must be PNG, JPEG, or WebP.');
}
async function inputDirectory(projectFolder,create=false){
  const root=await fs.realpath(projectFolder),dir=path.join(root,'.forge-inputs');
  if(create)await fs.mkdir(dir,{recursive:true});
  const info=await fs.lstat(dir);
  if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(dir)!==dir)throw Error('Project reference folder is missing or is a link.');
  return dir;
}
// Snapshot reference bytes at queue time so later edits to a project asset do
// not silently change an already queued render or a retry of that render.
export async function stageReference(projectFolder,bytes){
  const [ext,mime]=imageType(bytes),dir=await inputDirectory(projectFolder,true),id=`${randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir,id),bytes,{flag:'wx'});
  return {id,mime,size:bytes.length};
}
export async function stageProjectAsset(projectFolder,relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw Error('Invalid project asset path.');
  const root=await fs.realpath(projectFolder),file=path.resolve(root,...relative.split('/'));
  const real=await fs.realpath(file),rel=path.relative(root,real);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Asset must be inside the project.');
  const info=await fs.stat(real);if(!info.isFile()||info.size>MAX_REFERENCE_BYTES)throw Error('Asset must be an image of at most 10 MiB.');
  return stageReference(root,await fs.readFile(real));
}
export async function readReferences(projectFolder,ids,{max=9}={}){
  if(!Array.isArray(ids)||ids.length<1||ids.length>max||ids.some(id=>typeof id!=='string'||!idPattern.test(id)))throw Error(`Provide 1 to ${max} staged reference image IDs.`);
  const dir=await inputDirectory(projectFolder),images=[];let total=0;
  for(const id of ids){
    // Recheck file type, size, and link status when the queued job actually runs.
    const file=path.join(dir,id),info=await fs.lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_REFERENCE_BYTES)throw Error('Reference image is missing, too large, or is a link.');
    const bytes=await fs.readFile(file),[,mime]=imageType(bytes);total+=bytes.length;
    if(total>MAX_REFERENCES_BYTES)throw Error('Reference images must total at most 40 MiB.');
    images.push(`data:${mime};base64,${bytes.toString('base64')}`);
  }
  return images;
}

function poseText(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_REFERENCE_BYTES)throw Error('The BVH must be between 1 byte and 10 MiB.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('The BVH must be UTF-8 text.')}
  if(!/^\s*HIERARCHY\b/i.test(text)||!/^\s*MOTION\s*$/im.test(text)||text.includes('\0'))throw Error('The file does not look like a BVH motion clip.');
  return text;
}
export async function stagePose(projectFolder,bytes){
  poseText(bytes);const dir=await inputDirectory(projectFolder,true),id=`${randomUUID()}.bvh`;
  await fs.writeFile(path.join(dir,id),bytes,{flag:'wx'});return {id,mime:'text/plain',size:bytes.length};
}
export async function stageProjectPose(projectFolder,relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||!relative.toLowerCase().endsWith('.bvh'))throw Error('Choose a project BVH asset.');
  const root=await fs.realpath(projectFolder),file=await fs.realpath(path.resolve(root,...relative.split('/'))),rel=path.relative(root,file);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Asset must be inside the project.');
  const info=await fs.stat(file);if(!info.isFile()||info.size>MAX_REFERENCE_BYTES)throw Error('Asset must be a BVH of at most 10 MiB.');
  return stagePose(root,await fs.readFile(file));
}
export async function readPose(projectFolder,id){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}\.bvh$/i.test(id))throw Error('Provide a staged BVH ID.');
  const dir=await inputDirectory(projectFolder),file=path.join(dir,id),info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_REFERENCE_BYTES)throw Error('Pose file is missing, too large, or is a link.');
  return poseText(await fs.readFile(file));
}
