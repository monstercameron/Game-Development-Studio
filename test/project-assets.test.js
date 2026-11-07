import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAssetMetadata, updateAsset, renameAsset, trashAsset, restoreAsset, listTrash, clearTrash } from '../project-assets.js';

test('asset metadata is durable and trash is reversible without overwriting',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-asset-test-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 await fs.mkdir(path.join(folder,'images'));await fs.writeFile(path.join(folder,'images','one.png'),'original');await fs.writeFile(path.join(folder,'images','two.png'),'second');
 const project={folder,assets:[{id:'images/one.png'},{id:'images/two.png'}]};
 await Promise.all([updateAsset(project,'images/one.png',{kept:true}),updateAsset(project,'images/one.png',{rating:5}),updateAsset(project,'images/two.png',{rating:2})]);
 assert.deepEqual(await readAssetMetadata(folder),{'images/one.png':{kept:true,rating:5},'images/two.png':{rating:2}});
 await assert.rejects(updateAsset(project,'../outside.png',{rating:3}));await assert.rejects(updateAsset(project,'images/one.png',{rating:6}));
 const {trashId}=await trashAsset(project,'images/one.png');await assert.rejects(fs.stat(path.join(folder,'images','one.png')),{code:'ENOENT'});
 await fs.writeFile(path.join(folder,'images','one.png'),'replacement');await assert.rejects(restoreAsset(project,trashId),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(folder,'images','one.png'),'utf8'),'replacement');
 await fs.unlink(path.join(folder,'images','one.png'));await restoreAsset(project,trashId);assert.equal(await fs.readFile(path.join(folder,'images','one.png'),'utf8'),'original');assert.equal((await readAssetMetadata(folder))['images/one.png'].rating,5);
});

test('asset rename preserves ratings, original render path and trash recovery without overwriting',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-rename-test-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 await fs.mkdir(path.join(folder,'images'));await fs.writeFile(path.join(folder,'images','original.png'),'original');await fs.writeFile(path.join(folder,'images','occupied.png'),'other');
 const project={folder,assets:[{id:'images/original.png'},{id:'images/occupied.png'}]};
 await updateAsset(project,'images/original.png',{kept:true,rating:5});
 for(const name of ['../escape.png','bad.txt','CON.png','occupied.png','ORIGINAL.png','bad?.png'])await assert.rejects(renameAsset(project,'images/original.png',name));
 assert.equal(await fs.readFile(path.join(folder,'images','occupied.png'),'utf8'),'other');
 const renamed=await renameAsset(project,'images/original.png','hero.png');assert.equal(renamed.path,'images/hero.png');
 await assert.rejects(fs.stat(path.join(folder,'images','original.png')),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(folder,'images','hero.png'),'utf8'),'original');
 assert.deepEqual((await readAssetMetadata(folder))['images/hero.png'],{kept:true,rating:5,sourceOutput:'images/original.png'});
 project.assets=[{id:'images/hero.png'},{id:'images/occupied.png'}];await renameAsset(project,'images/hero.png','hero-final.png');
 assert.equal((await readAssetMetadata(folder))['images/hero-final.png'].sourceOutput,'images/original.png');
 project.assets=[{id:'images/hero-final.png'}];const {trashId}=await trashAsset(project,'images/hero-final.png');await restoreAsset(project,trashId);
 assert.equal(await fs.readFile(path.join(folder,'images','hero-final.png'),'utf8'),'original');assert.equal((await readAssetMetadata(folder))['images/hero-final.png'].rating,5);
});

test('trash lists durable entries and only explicit clearing permanently deletes trashed assets',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-trash-test-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 await fs.mkdir(path.join(folder,'images'));for(const name of ['one','two','keep'])await fs.writeFile(path.join(folder,'images',`${name}.png`),name);
 const project={folder,assets:['one','two','keep'].map(name=>({id:`images/${name}.png`}))};
 const deleted=await Promise.all(['one','two'].map(name=>trashAsset(project,`images/${name}.png`)));
 assert.equal((await listTrash({folder})).items.length,2);
 await assert.rejects(clearTrash(project));assert.equal((await listTrash(project)).items.length,2);
 await restoreAsset(project,deleted[0].trashId);
 assert.deepEqual(await clearTrash(project,'permanently-delete-trash'),{deleted:1});
 assert.equal((await listTrash(project)).items.length,0);
 assert.equal(await fs.readFile(path.join(folder,'images','keep.png'),'utf8'),'keep');
 assert.equal(await fs.readFile(path.join(folder,'images','one.png'),'utf8'),'one');
 await assert.rejects(restoreAsset(project,deleted[1].trashId),{code:'ENOENT'});
 await fs.writeFile(path.join(folder,'.forge-trash','unrelated.txt'),'keep this');
 await clearTrash(project,'permanently-delete-trash');assert.equal(await fs.readFile(path.join(folder,'.forge-trash','unrelated.txt'),'utf8'),'keep this');
});

test('trash rejects symlinked directories and malformed original paths',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-trash-safety-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'forge-trash-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.writeFile(path.join(outside,'precious.txt'),'preserve');
 await fs.symlink(outside,path.join(folder,'.forge-trash'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(clearTrash({folder},'permanently-delete-trash'),/Invalid project trash/);
 assert.equal(await fs.readFile(path.join(outside,'precious.txt'),'utf8'),'preserve');
 await fs.unlink(path.join(folder,'.forge-trash'));await fs.mkdir(path.join(folder,'.forge-trash'));
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 await fs.writeFile(path.join(folder,'.forge-trash',`${id}.json`),JSON.stringify({path:'images/../../outside.txt'}));await fs.writeFile(path.join(folder,'.forge-trash',`${id}.asset`),'preserve');
 await assert.rejects(clearTrash({folder},'permanently-delete-trash'),/Invalid original/);await assert.rejects(restoreAsset({folder},id),/Invalid original/);
 assert.equal(await fs.readFile(path.join(folder,'.forge-trash',`${id}.asset`),'utf8'),'preserve');
});

test('incomplete trash records cannot hide recoverable assets and are preserved by clear',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-trash-orphan-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));await fs.mkdir(path.join(folder,'images'));await fs.writeFile(path.join(folder,'images','valid.png'),'recover me');
 const project={folder,assets:[{id:'images/valid.png'}]};const {trashId}=await trashAsset(project,'images/valid.png'),trash=path.join(folder,'.forge-trash');
 const orphan='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',unpaired='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';await fs.writeFile(path.join(trash,`${orphan}.json`),JSON.stringify({path:'images/interrupted.png'}));await fs.writeFile(path.join(trash,`${unpaired}.asset`),'orphan bytes');
 let listing=await listTrash(project);assert.equal(listing.items.length,1);assert.equal(listing.items[0].trashId,trashId);assert.equal(listing.warnings.length,2);
 await restoreAsset(project,trashId);assert.equal(await fs.readFile(path.join(folder,'images','valid.png'),'utf8'),'recover me');
 await trashAsset(project,'images/valid.png');assert.deepEqual(await clearTrash(project,'permanently-delete-trash'),{deleted:1});
 assert.equal((await listTrash(project)).items.length,0);assert.equal(await fs.readFile(path.join(trash,`${unpaired}.asset`),'utf8'),'orphan bytes');assert.ok(await fs.stat(path.join(trash,`${orphan}.json`)));
});
