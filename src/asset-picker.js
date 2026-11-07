export const IMAGE_EXTENSIONS=['png','jpg','jpeg','webp'];
export const TRELLIS_EXTENSIONS=['png','webp'];
export const AUDIO_EXTENSIONS=['wav','mp3','flac','ogg','opus'];
export const POSE_EXTENSIONS=['bvh'];

export function compatibleAssets(assets,extensions,query='') {
  const allowed=new Set(extensions.map(value=>value.toLowerCase().replace(/^\./,'')));
  const search=query.trim().toLowerCase();
  return (assets||[]).filter(asset=>allowed.has((asset.name||'').split('.').pop().toLowerCase()) && (!search||`${asset.name} ${asset.id}`.toLowerCase().includes(search)));
}

// Each selection is read through the existing local project asset endpoint.
// The caller passes the resulting File to the same validated queue/upload path
// as a file chosen from the OS, preserving the queue-time input snapshot.
export async function readLibraryFiles(project,assets,{maxBytes,totalBytes,signal,fetchImpl=fetch}={}) {
  let total=0;const files=[];
  for(const asset of assets){
    if(Number.isFinite(maxBytes)&&asset.size>maxBytes)throw Error(`${asset.name} is too large.`);
    const url=`/api/projects/${encodeURIComponent(project.id)}/asset?path=${encodeURIComponent(asset.id)}`;
    const response=await fetchImpl(url,{signal});
    if(!response.ok)throw Error(`Could not read ${asset.name}. Refresh the library and try again.`);
    const blob=await response.blob();
    if(Number.isFinite(maxBytes)&&blob.size>maxBytes)throw Error(`${asset.name} is too large.`);
    total+=blob.size;if(Number.isFinite(totalBytes)&&total>totalBytes)throw Error('The selected files exceed the combined size limit.');
    files.push(new File([blob],asset.name,{type:asset.type||blob.type||'application/octet-stream',lastModified:Date.parse(asset.modified)||Date.now()}));
  }
  return files;
}
