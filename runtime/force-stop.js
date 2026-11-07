import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('./force-stop-windows.ps1',import.meta.url));
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

export function forceStopWindows(identity){
 if(process.platform!=='win32')return Promise.reject(Error('Force stop is currently available on Windows only.'));
 if(!Number.isSafeInteger(identity?.pid)||identity.pid<=0||!/^[1-9][0-9]{14,20}$/.test(identity.creationTicks||'')||!path.win32.isAbsolute(identity.executable||''))return Promise.reject(Error('The engine process identity is unavailable.'));
 return new Promise((resolve,reject)=>{
  const child=spawn(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
  const timer=setTimeout(()=>{child.kill();finish(Error('Force-stop timed out. Check the engine and queue before continuing.'))},25000);
  child.on('error',()=>finish(Error('Could not start the Windows force-stop helper.')));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4096){child.kill();finish(Error('Invalid force-stop response.'))}});child.stderr.resume();
  child.on('close',code=>{if(code!==0)return finish(Error('The process tree could not be verified or stopped. Check Diagnostics before retrying.'));try{const result=JSON.parse(output);if(result.stopped!==true)throw Error();finish(null,result)}catch{finish(Error('The force-stop result could not be verified.'))}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(identity));
 });
}
