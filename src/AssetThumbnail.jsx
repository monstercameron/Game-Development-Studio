import React, {useEffect, useRef, useState} from 'react';
import {Box, Clapperboard, Image as ImageIcon} from 'lucide-react';
import './asset-thumbnail.css';

const tasks=new Map();let tail=Promise.resolve();
const visual=asset=>['Images','Masks','Video','3D'].includes(asset.category);
function thumbnailUrl(project,asset){return `/api/projects/${project.id}/thumbnail?path=${encodeURIComponent(asset.id)}&v=${encodeURIComponent(`${asset.modified}:${asset.size}`)}`}
function loadThumbnail(project,asset){
 const key=project?thumbnailUrl(project,asset):(asset.url||asset.file);if(tasks.has(key))return tasks.get(key);
 const work=tail.catch(()=>{}).then(async()=>{
  if(project){const found=await fetch(key);if(found.ok)return key}
  const {renderThumbnail}=await import('./thumbnail-renderer');const image=await renderThumbnail(asset);
  if(project){const response=await fetch(key,{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'project'},body:JSON.stringify({image,modified:asset.modified,size:asset.size})});if(response.ok)return key}
  return image;
 });tail=work.catch(()=>{});tasks.set(key,work);work.catch(()=>tasks.delete(key));return work;
}
export default function AssetThumbnail({asset,project,className=''}){
 const node=useRef(null),[source,setSource]=useState(null),[failed,setFailed]=useState(false);const key=`${project?.id||'sample'}:${asset.id}:${asset.modified||''}:${asset.size||''}`;
 useEffect(()=>{let active=true;setSource(null);setFailed(false);if(!visual(asset))return;
  const start=()=>loadThumbnail(project,asset).then(result=>{if(active)setSource(result)},()=>{if(active)setFailed(true)});
  if(!node.current||!('IntersectionObserver'in window)){start();return()=>{active=false}}
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();start()}},{rootMargin:'300px'});observer.observe(node.current);return()=>{active=false;observer.disconnect()};
 },[key]);
 const Icon=asset.category==='3D'?Box:asset.category==='Video'?Clapperboard:ImageIcon;
 return <span ref={node} className={`asset-visual-thumbnail ${className}`} aria-hidden="true">{source?<img src={source} alt="" loading="lazy"/>:<span className="asset-thumbnail-placeholder"><Icon size={30}/><small>{failed?'Preview unavailable':'Preparing preview'}</small></span>}</span>;
}
export {visual as isVisualAsset};
