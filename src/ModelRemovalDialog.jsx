import React, {useEffect, useState} from 'react';
import {LoaderCircle, Power, ShieldCheck, Trash2, X} from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import './model-removal-dialog.css';

const size=value=>value==null?'Not measured':value>=1024**3?`${(value/1024**3).toFixed(1)} GiB`:`${(value/1024**2).toFixed(1)} MiB`;
async function post(path,body={}){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'runtime'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||result.message||'Request failed.');return result}

export default function ModelRemovalDialog({model,id,storage,service,removal,inventoryState,onClose,onRefresh}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const inProgress=['prepared','deleting'].includes(removal?.state);
  const failed=removal?.state==='failed';
  const managed=!!storage;
  const stopped=service?.status==='unavailable'&&!service?.managed;
  const canRemove=managed&&storage.removable!==false&&!inProgress&&inventoryState!=='scanning'&&stopped&&(failed||storage.installed===true);
  const dialog=useDialogFocus({onClose:()=>{if(!busy)onClose()},initialFocus:'.settings-head button'});
  useEffect(()=>{if(!inProgress)return;const timer=setInterval(()=>onRefresh(),1200);return()=>clearInterval(timer)},[inProgress,onRefresh]);
  async function remove(){setBusy(true);setError('');try{await post(`/api/runtime/models/${id}/remove`,{confirmation:'permanently-delete-model',retry:failed});await onRefresh()}catch(reason){setError(reason.message)}finally{setBusy(false)}}
  async function stop(){setBusy(true);setError('');try{await post(`/api/runtime/models/${id}/offload`);await onRefresh()}catch(reason){setError(reason.message)}finally{setBusy(false)}}
  return <div className="modal-backdrop" onClick={()=>{if(!busy)onClose()}}><section ref={dialog} className="settings-modal model-remove-modal" role="dialog" aria-modal="true" aria-label={`Remove ${model.name}`} tabIndex={-1} onClick={event=>event.stopPropagation()}>
    <div className="settings-head"><div><span className="mini-label">MODEL STORAGE</span><h2>Remove model files</h2><p>Free storage used by this model.</p></div><button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}><X size={20}/></button></div>
    <div className="model-remove-summary"><div className={'tool-icon '+model.tone}><model.icon size={19}/></div><div><strong>{model.name}</strong><span>{model.category}</span></div></div>
    <dl className="model-remove-details"><div><dt>Location</dt><dd>{storage?.path||'Outside Forge-managed storage'}</dd></div><div><dt>Measured file size</dt><dd>{storage?.installed?size(storage.bytes):'Not available'}</dd></div></dl>
    <div className="model-preview-explanation"><ShieldCheck size={18}/><p>{!managed?'This model is stored in another application or has not been installed. Manage those files in their original location.':storage.removable===false?'Removal in Forge is not yet available for this preview model. Its supporting decoder and image encoder are stored separately.':inProgress?'Removing the staged model files. You can close this dialog while cleanup continues.':failed?'The previous removal did not finish. Retry cleanup after resolving the error.':storage.installed===false?'This model folder is not currently installed.':!stopped?'The model service must be stopped before its files can be removed.':'This permanently deletes the model files. It does not delete project assets. You will need to reinstall the model to use it again.'}</p></div>
    {(error||removal?.error)&&<p className="settings-error" role="alert">{error||removal.error}</p>}
    <div className="project-dialog-actions"><button className="ghost-button" disabled={busy} onClick={onClose}>Close</button>{managed&&!stopped&&!inProgress&&service?.canUnload&&<button className="icon-outline" disabled={busy} onClick={stop}><Power size={14}/> Stop service</button>}<button className="danger-solid" disabled={busy||!canRemove} onClick={remove}>{busy||inProgress?<LoaderCircle size={15} className="motion-spinner"/>:<Trash2 size={15}/>} {inProgress?'Removing…':failed?'Retry removal':'Permanently delete model'}</button></div>
  </section></div>;
}
