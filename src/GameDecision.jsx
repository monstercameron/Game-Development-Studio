import {saveProjectText} from './save-project-text';
import React, {useEffect,useState} from 'react';
import {Copy, Gamepad2, Save} from 'lucide-react';
import {gameDecisionRequest,presentGameDecision} from './game-decision-input.js';
import MemoryDialog from './MemoryDialog.jsx';
import {formatDuration} from './queue-timing.js';
import './game-decision.css';

const historyKey='forge-decision-timing-v1';
function readTimings(){try{const value=JSON.parse(localStorage.getItem(historyKey)||'[]');return Array.isArray(value)?value.filter(item=>typeof item?.type==='string'&&Number.isFinite(item.seconds)&&item.seconds>=0).slice(-30):[]}catch{return []}}

export default function GameDecision({draft,project,onSaved}){
  const [result,setResult]=useState(null),[choiceLabel,setChoiceLabel]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
  const [timings,setTimings]=useState(readTimings);const [saving,setSaving]=useState(false),[savedPath,setSavedPath]=useState('');
  useEffect(()=>setSavedPath(''),[project?.id]);
  const [loading,setLoading]=useState(false),[notice,setNotice]=useState(''),[conflict,setConflict]=useState(null),[memoryError,setMemoryError]=useState('');
  async function load(){
    setLoading(true);setMemoryError('');setNotice('');setError('');
    try{const response=await fetch('/api/runtime/models/game/load',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'runtime'},body:'{}'});const data=await response.json();if(['insufficient_gpu_memory','insufficient_host_memory'].includes(data.code)){setConflict(data);return}if(!response.ok)throw Error(data.message||data.error||'Could not load Mammoth.');setConflict(null);setNotice(data.message)}catch(e){if(conflict)setMemoryError(e.message);else setError(e.message)}finally{setLoading(false)}
  }
  async function offload(id){
    setLoading(true);setMemoryError('');
    try{const response=await fetch(`/api/runtime/models/${id}/offload`,{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'runtime'},body:'{}'});const data=await response.json();if(!response.ok)throw Error(data.error||'Could not stop the model.');await load()}catch(e){setMemoryError(e.message)}finally{setLoading(false)}
  }
  async function stop(){
    setLoading(true);setError('');setNotice('');
    try{const response=await fetch('/api/runtime/models/game/offload',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'runtime'},body:'{}'});const data=await response.json();if(!response.ok)throw Error(data.error||'Could not stop Mammoth.');setNotice(data.message)}catch(e){setError(e.message)}finally{setLoading(false)}
  }
  async function run(){
    let request;try{request=gameDecisionRequest(draft)}catch(error){setError(error.message);return}
    setBusy(true);setError('');setResult(null);setChoiceLabel('');setCopied(false);setSavedPath('');
    try{const response=await fetch('/api/runtime/game/decide',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Request':'runtime'},body:JSON.stringify(request)});const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||data.error||data));const choice=data?.answers?.decision?.choice;setChoiceLabel(request.questions.decision.type==='choice'?(request.questions.decision.criteria[choice]||''):'');const elapsed=data?.metrics?.server_ms;if(typeof elapsed==='number'&&Number.isFinite(elapsed)&&elapsed>=0)setTimings(previous=>{const next=[...previous,{type:request.questions.decision.type,seconds:elapsed/1000}].slice(-30);try{localStorage.setItem(historyKey,JSON.stringify(next))}catch{}return next});setResult(data)}catch(e){setError(e.message)}finally{setBusy(false)}
  }
  const shown=presentGameDecision(result,draft.options?.[1]);
  const decisionType=draft.options?.[0]==='Yes / No'?'noul':draft.options?.[0]?.toLowerCase();
  const similar=timings.filter(item=>item.type===decisionType).map(item=>item.seconds).sort((a,b)=>a-b);
  const decisionEstimate=similar.length?similar[Math.floor((similar.length-1)/2)]:null;
  async function saveDecision(){setSaving(true);setError('');try{const output=await saveProjectText(project?.id,'decision',JSON.stringify(result,null,2));setSavedPath(output.path);onSaved?.()}catch(reason){setError(reason.message)}finally{setSaving(false)}}
  async function copy(){try{await navigator.clipboard.writeText(JSON.stringify(shown,null,2));setCopied(true)}catch{setError('Could not copy the result.')}}
  return <section className="panel runtime-queue game-decision-panel"><div className="panel-heading"><div><span className="mini-label">MAMMOTH · LIVE SERVICE</span><h2>Test a decision</h2></div><Gamepad2 size={18}/></div><p className="helper">{draft.options?.[0]==='Yes / No'?'Enter a question above. Mammoth returns a probability for yes.':'Enter a question, then at least two choices or score levels on separate lines.'} Start Mammoth and load its model before running a decision.</p><div className="queue-timing-summary"><strong>Estimated decision time: {decisionEstimate===null?'Not enough history':`~${formatDuration(decisionEstimate)}`}</strong><span>{decisionEstimate===null?'Run this question type to build an estimate.':`Based on ${similar.length} previous ${similar.length===1?'decision':'decisions'} of this type; model loading is extra.`}</span></div><div className="game-decision-actions"><button className="outline-button" onClick={load} disabled={loading}>{loading?'Working…':'Start / load Mammoth'}</button><button className="outline-button" onClick={stop} disabled={loading}>Stop managed Mammoth</button><button className="outline-button" onClick={run} disabled={busy}>{busy?'Waiting for Mammoth…':'Run decision'}</button></div>{notice&&<p className="helper" role="status">{notice}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}{result&&<>{choiceLabel&&<p className="helper" role="status">Selected: <strong>{choiceLabel}</strong></p>}<p className="helper">{draft.options?.[1]==='Compact'?'Showing answers only.':'Showing the complete response, including metrics.'} This changes the display, not the decision.</p><pre className="game-result">{JSON.stringify(shown,null,2)}</pre><div className="game-decision-actions"><button className="outline-button" onClick={copy}><Copy size={15}/>{copied?'Copied':'Copy displayed result'}</button><button className="outline-button" disabled={!project||saving} title={!project?'Choose a project first':'Save the complete response as JSON'} onClick={saveDecision}><Save size={15}/>{saving?'Saving…':'Save JSON to project'}</button></div>{savedPath&&<p className="helper" role="status">Saved to {savedPath}</p>}</>}{conflict&&<MemoryDialog target="Mammoth" conflict={conflict} onClose={()=>{setConflict(null);setMemoryError('')}} onRetry={load} onOffload={offload} working={loading} error={memoryError}/>}</section>
}
