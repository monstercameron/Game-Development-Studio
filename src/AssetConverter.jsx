import React, {useEffect, useState} from 'react';
import {ArrowDownToLine, FileOutput, X} from 'lucide-react';
import './asset-converter.css';

const imageFormats=[['png','PNG · lossless'],['webp','WebP · lossless'],['jpeg','JPEG · smaller file'],['bmp','BMP · uncompressed'],['tga','TGA · game texture']];
const audioFormats=[['wav','WAV · uncompressed'],['flac','FLAC · lossless'],['ogg','Ogg Vorbis · game audio'],['opus','Ogg Opus · efficient audio'],['mp3','MP3 · widely supported']];

export function canConvert(asset){return asset && ['Images','Masks','Audio'].includes(asset.category)}
export default function AssetConverter({asset,project,onSaved,onClose}){
 const audio=asset.category==='Audio';
 const [format,setFormat]=useState(audio?'ogg':'png'),[quality,setQuality]=useState(90),[background,setBackground]=useState('#ffffff'),[busy,setBusy]=useState(false),[result,setResult]=useState(null),[error,setError]=useState('');
 useEffect(()=>{setFormat(audio?'ogg':'png');setResult(null);setError('')},[asset.id,audio]);
 async function submit(event){event.preventDefault();setBusy(true);setError('');setResult(null);try{
  const response=await fetch(`/api/projects/${project.id}/assets/convert`,{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'project'},body:JSON.stringify({path:asset.id,format,quality,background})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Could not convert this asset.');setResult(data);await onSaved?.();
 }catch(e){setError(e.message)}finally{setBusy(false)}}
 return <form className="asset-converter" onSubmit={submit} aria-label="Convert asset">
  <div className="converter-heading"><div><FileOutput size={18}/><strong>Convert a copy</strong></div><button type="button" className="converter-close" onClick={onClose} aria-label="Close converter" disabled={busy}><X size={17}/></button></div>
  <p>Saved alongside the original in this project.</p>
  <label>Output format<select value={format} onChange={e=>{setFormat(e.target.value);setResult(null)}}>{(audio?audioFormats:imageFormats).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
  {format==='jpeg'&&<label>JPEG quality <span>{quality}%</span><input type="range" min="1" max="100" value={quality} onChange={e=>setQuality(Number(e.target.value))}/></label>}
  {!audio&&['jpeg','bmp'].includes(format)&&<label className="converter-background">Transparency background <input type="color" value={background} onChange={e=>setBackground(e.target.value)}/></label>}
  <p className="converter-note">{format==='jpeg'?'JPEG uses the NVIDIA GPU when available; otherwise it uses the CPU. Transparency is filled with the chosen color.':format==='bmp'?'Transparency is filled with the chosen color.':format==='tga'?'TGA is useful for game textures; Forge creates a preview thumbnail.':format==='opus'?'Opus is resampled to 48 kHz when needed.':'The original file is kept unchanged.'}</p>
  <button className="primary" disabled={busy}>{busy?'Converting…':'Convert & save copy'}</button>
  {error&&<p className="converter-error" role="alert">{error}</p>}
  {result&&<div className="converter-result" role="status"><span><strong>Saved {result.name}</strong><small>Encoded with {result.backend}</small></span><a href={result.url} download={result.name}><ArrowDownToLine size={16}/> Download</a></div>}
 </form>
}
