import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const helper=fileURLToPath(new URL('./credentials-windows.ps1',import.meta.url));
const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export const credentialProviders=['openai','huggingface'];
function validateProvider(provider){if(!credentialProviders.includes(provider))throw Error('Choose a supported provider.')}
function validateSecret(secret){if(typeof secret!=='string'||secret.length<1||secret.length>4096||!/^[\x21-\x7e]+$/.test(secret))throw Error('Enter a valid API key without spaces or line breaks.')}
function crypt(operation,value){
 if(process.platform!=='win32')return Promise.reject(Error('Windows account encryption is required to store API keys.'));
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  let output='',settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
  const timer=setTimeout(()=>{child.kill();finish(Error('Windows credential encryption timed out.'))},15000);
  child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>32768){child.kill();finish(Error('Windows credential encryption failed.'))}});
  child.on('error',()=>finish(Error('Windows credential encryption is unavailable.')));
  child.on('close',code=>code===0&&output?finish(null,output):finish(Error('Windows credential encryption failed.')));
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({operation,value}));
 });
}
export function createCredentialStore({directory=path.join(process.env.FORGE_RUNTIME_DIR||path.join(root,'.forge-runtime'),'credentials'),protect=value=>crypt('protect',value),unprotect=value=>crypt('unprotect',value)}={}){
 const file=path.join(directory,'keys.sqlite');
 function open(create){
  if(!create&&!fs.existsSync(file))return null;
  if(create)fs.mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(file,{timeout:5000});
  try{db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL)');return db}catch(error){db.close();throw error}
 }
 return {
  async set(provider,secret){validateProvider(provider);validateSecret(secret);const ciphertext=await protect(secret);if(typeof ciphertext!=='string'||!ciphertext||ciphertext===secret)throw Error('Credential encryption failed.');const db=open(true);try{db.prepare('INSERT INTO credentials(provider,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at').run(provider,ciphertext,new Date().toISOString())}finally{db.close()}},
  async get(provider){validateProvider(provider);const db=open(false);if(!db)return '';let row;try{row=db.prepare('SELECT ciphertext FROM credentials WHERE provider=?').get(provider)}finally{db.close()}if(!row)return '';const result=await unprotect(row.ciphertext);validateSecret(result);return result},
  status(){const db=open(false);if(!db)return credentialProviders.map(provider=>({provider,saved:false}));try{const rows=db.prepare('SELECT provider,updated_at FROM credentials').all();return credentialProviders.map(provider=>({provider,saved:rows.some(row=>row.provider===provider),updatedAt:rows.find(row=>row.provider===provider)?.updated_at||null}))}finally{db.close()}},
  remove(provider){validateProvider(provider);const db=open(false);if(!db)return;try{db.prepare('DELETE FROM credentials WHERE provider=?').run(provider)}finally{db.close()}},
 };
}
export const credentialStore=createCredentialStore();
