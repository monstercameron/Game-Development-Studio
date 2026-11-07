import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const locks=new Map();
const filename='.forge-assets.json';
function inside(root,target){const rel=path.relative(root,target);return rel!==''&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel)}
async function regular(file){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Asset is not a regular file.');return s}
export async function readAssetMetadata(folder){
 try{const file=path.join(folder,filename);await regular(file);const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.version!==1||!data.assets||typeof data.assets!=='object'||Array.isArray(data.assets))throw Error('Invalid asset metadata.');return data.assets}
 catch(error){if(error.code==='ENOENT')return {};throw error}
}
async function save(folder,assets){const temp=path.join(folder,`.forge-assets-${randomUUID()}.tmp`);await fs.writeFile(temp,JSON.stringify({version:1,assets},null,2),{flag:'wx'});try{await fs.rename(temp,path.join(folder,filename))}catch(error){await fs.unlink(temp).catch(()=>{});throw error}}
// Serialize mutations within this HTTP process so ratings, renames, and trash
// updates do not overwrite each other. This map is not a cross-process lock.
function locked(folder,work){const previous=locks.get(folder)||Promise.resolve();const next=previous.catch(()=>{}).then(work);locks.set(folder,next);next.finally(()=>{if(locks.get(folder)===next)locks.delete(folder)}).catch(()=>{});return next}
async function assetFile(project,rel){if(typeof rel!=='string'||!project.assets.some(asset=>asset.id===rel))throw Error('Asset not found.');const root=await fs.realpath(project.folder);const full=path.resolve(project.folder,...rel.split('/'));await regular(full);const real=await fs.realpath(full);if(!inside(root,real))throw Error('Asset is outside the project.');return full}
async function trashDirectory(project){const folder=path.join(project.folder,'.forge-trash');await fs.mkdir(folder,{recursive:true});const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(await fs.realpath(project.folder),await fs.realpath(folder)))throw Error('Invalid project trash folder.');return folder}
function originalPath(rel){if(typeof rel!=='string'||rel.includes('\\')||rel.includes(':')||rel.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw Error('Invalid original asset path.');return rel}
async function trashItems(project,strict=false){
 const folder=await trashDirectory(project),items=[],warnings=[],entries=await fs.readdir(folder,{withFileTypes:true}),names=new Set(entries.map(entry=>entry.name));
 for(const entry of entries){
  if(/^[a-f0-9-]{36}\.asset$/i.test(entry.name)&&!names.has(`${entry.name.slice(0,-6)}.json`))warnings.push(`Trash file ${entry.name} has no recovery record and has been preserved.`);
  if(!/^[a-f0-9-]{36}\.json$/i.test(entry.name))continue;
  const id=entry.name.slice(0,-5),manifest=path.join(folder,entry.name),source=path.join(folder,`${id}.asset`);
  try{await regular(manifest);const stat=await regular(source);const data=JSON.parse(await fs.readFile(manifest,'utf8'));originalPath(data.path);
  items.push({trashId:id,path:data.path,deletedAt:data.deletedAt,size:stat.size});}catch(error){if(strict&&error.code!=='ENOENT')throw error;warnings.push(`Trash item ${id} is incomplete or unreadable and has been preserved.`)}
 }
 return {items:items.sort((a,b)=>String(b.deletedAt||'').localeCompare(String(a.deletedAt||''))),warnings};
}
export function listTrash(project){return locked(project.folder,()=>trashItems(project))}
export function clearTrash(project,confirmation){return locked(project.folder,async()=>{
 if(confirmation!=='permanently-delete-trash')throw Error('Confirm permanent trash deletion.');
 const {items}=await trashItems(project,true),folder=await trashDirectory(project);let deleted=0;
 // Only validated Forge trash pairs are removed. Never recurse or follow links.
 for(const item of items){await regular(path.join(folder,`${item.trashId}.asset`));await regular(path.join(folder,`${item.trashId}.json`));await fs.unlink(path.join(folder,`${item.trashId}.asset`));await fs.unlink(path.join(folder,`${item.trashId}.json`));deleted++}
 return {deleted};
})}
// Save generated text under a fixed project subfolder; never accept a client path.
export async function saveGeneratedText(project,{kind,content}={}){
 const extensions={transcript:'txt',chat:'txt',decision:'json'};
 if(!Object.hasOwn(extensions,kind))throw Error('Unsupported text asset type.');
 if(typeof content!=='string'||!content.trim()||content.length>100000)throw Error('Text must contain between 1 and 100,000 characters.');
 if(kind==='decision'){try{JSON.parse(content)}catch{throw Error('Decision output must be valid JSON.')}}
 const root=await fs.realpath(project.folder),dir=path.join(root,'text');
 await fs.mkdir(dir,{recursive:true});const stat=await fs.lstat(dir),real=await fs.realpath(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(root,real)||(process.platform==='win32'?real.toLowerCase()!==dir.toLowerCase():real!==dir))throw Error('Invalid project text folder.');
 const name=`${kind}-${randomUUID()}.${extensions[kind]}`;
 await fs.writeFile(path.join(real,name),content,{encoding:'utf8',flag:'wx'});
 return {path:`text/${name}`};
}
export function updateAsset(project,rel,changes){return locked(project.folder,async()=>{await assetFile(project,rel);if(!changes||typeof changes!=='object'||(!Object.hasOwn(changes,'kept')&&!Object.hasOwn(changes,'rating')))throw Error('Choose a rating or kept status.');if(Object.hasOwn(changes,'kept')&&typeof changes.kept!=='boolean')throw Error('Invalid kept status.');if(Object.hasOwn(changes,'rating')&&changes.rating!==null&&(!Number.isInteger(changes.rating)||changes.rating<1||changes.rating>5))throw Error('Rating must be between 1 and 5.');const assets=await readAssetMetadata(project.folder);assets[rel]={...(assets[rel]||{}),...(Object.hasOwn(changes,'kept')?{kept:changes.kept}:{}),...(Object.hasOwn(changes,'rating')?{rating:changes.rating}:{})};await save(project.folder,assets);return assets[rel]})}
export function renameAsset(project,rel,name){return locked(project.folder,async()=>{
 const source=await assetFile(project,rel),oldName=path.basename(source);
 if(typeof name!=='string'||!name||name.length>180||name!==name.trim()||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||name.startsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw Error('Enter a valid file name without slashes or reserved characters.');
 if(path.extname(name).toLowerCase()!==path.extname(oldName).toLowerCase())throw Error('Keep the original file extension.');
 if(name===oldName)return {path:rel};
 if(name.toLowerCase()===oldName.toLowerCase())throw Error('Choose a name that differs by more than letter case.');
 const parts=rel.split('/');parts[parts.length-1]=name;const next=parts.join('/'),target=path.join(path.dirname(source),name),assets=await readAssetMetadata(project.folder);
 if(Object.keys(assets).some(key=>key.toLowerCase()===next.toLowerCase()))throw Error('That name is reserved by an existing asset or trash record.');
 // Hard links reserve the destination without overwriting and avoid copying
 // large videos. Filesystems without link support use an exclusive copy.
 try{await fs.link(source,target)}catch(error){
  if(error.code==='EEXIST')throw Error('A file with that name already exists.');
  if(!['EPERM','EOPNOTSUPP','ENOTSUP','EXDEV','ENOSYS'].includes(error.code))throw error;
  try{await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL)}catch(copyError){if(copyError.code==='EEXIST')throw Error('A file with that name already exists.');throw copyError}
 }
 const before={...assets};assets[next]={...(assets[rel]||{}),sourceOutput:assets[rel]?.sourceOutput||rel};delete assets[rel];
 try{await save(project.folder,assets)}catch(error){await fs.unlink(target).catch(()=>{});throw error}
 try{await fs.unlink(source)}catch(error){
  try{await save(project.folder,before);await fs.unlink(target)}catch{throw Error('Rename could not finish. The original and a copy may both remain; check the project folder.')}
  throw Error('Could not rename the asset; the original file was kept.');
 }
 return {path:next};
})}
export function trashAsset(project,rel){return locked(project.folder,async()=>{const source=await assetFile(project,rel);const folder=await trashDirectory(project);const id=randomUUID();const manifest=path.join(folder,`${id}.json`);await fs.writeFile(manifest,JSON.stringify({path:rel,deletedAt:new Date().toISOString()}),{flag:'wx'});try{await fs.rename(source,path.join(folder,`${id}.asset`))}catch(error){await fs.unlink(manifest).catch(()=>{});throw error}return {trashId:id}})}
export function restoreAsset(project,id){return locked(project.folder,async()=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid trash item.');const folder=await trashDirectory(project),manifest=path.join(folder,`${id}.json`),source=path.join(folder,`${id}.asset`);await regular(manifest);await regular(source);const data=JSON.parse(await fs.readFile(manifest,'utf8'));const rel=originalPath(data.path);const target=path.resolve(project.folder,...rel.split('/')),root=await fs.realpath(project.folder),parent=await fs.realpath(path.dirname(target));if(!inside(root,target)||!(parent===root||inside(root,parent)))throw Error('Original folder is outside the project.');await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);await fs.unlink(source);await fs.unlink(manifest);return {path:rel}})}
