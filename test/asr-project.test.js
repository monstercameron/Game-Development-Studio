import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {transcribeProjectAudio} from '../runtime/asr-project.js';

test('project transcription stays within the selected project and only reads WAV files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-asr-project-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'game');await fs.mkdir(path.join(folder,'voices'),{recursive:true});const id=randomUUID();await fs.writeFile(path.join(folder,'.forge-project.json'),JSON.stringify({id}));
  const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);await fs.writeFile(path.join(folder,'voices','line.wav'),wav);
  const options={projectsRoot:root,transcribe:async(bytes)=>({text:`${bytes.length} bytes`})};
  assert.equal((await transcribeProjectAudio({projectId:id,path:'voices/line.wav'},options)).text,'44 bytes');
  await assert.rejects(transcribeProjectAudio({projectId:id,path:'../private.wav'},options),/Choose a WAV/);
  await assert.rejects(transcribeProjectAudio({projectId:id,path:'voices/line.mp3'},options),/Choose a WAV/);
  await assert.rejects(transcribeProjectAudio({projectId:randomUUID(),path:'voices/line.wav'},options),/not found/);
});
