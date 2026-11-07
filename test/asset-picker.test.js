import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibleAssets,readLibraryFiles,IMAGE_EXTENSIONS,TRELLIS_EXTENSIONS,AUDIO_EXTENSIONS,POSE_EXTENSIONS} from '../src/asset-picker.js';

test('library picker filters by the actual supported file extensions',()=>{
 const items=[{name:'character.PNG',id:'images/character.PNG'},{name:'character.jpg',id:'images/character.jpg'},{name:'forest.mp3',id:'music/forest.mp3'},{name:'idle.bvh',id:'motion/idle.bvh'},{name:'scene.glb',id:'3d/scene.glb'}];
 assert.deepEqual(compatibleAssets(items,IMAGE_EXTENSIONS).map(a=>a.name),['character.PNG','character.jpg']);
 assert.deepEqual(compatibleAssets(items,TRELLIS_EXTENSIONS).map(a=>a.name),['character.PNG']);
 assert.deepEqual(compatibleAssets(items,AUDIO_EXTENSIONS).map(a=>a.name),['forest.mp3']);
 assert.deepEqual(compatibleAssets(items,POSE_EXTENSIONS,'motion').map(a=>a.name),['idle.bvh']);
});
test('library assets become files through their source project and enforce limits',async()=>{
 const project={id:'source-project'},asset={name:'look & feel.png',id:'images/look & feel.png',size:3,type:'image/png',modified:'2026-01-01T00:00:00Z'};let request;
 const fetchImpl=async url=>{request=url;return new Response(new Uint8Array([1,2,3]),{status:200,headers:{'Content-Type':'image/png'}})};
 const [file]=await readLibraryFiles(project,[asset],{maxBytes:3,totalBytes:3,fetchImpl});
 assert.equal(request,'/api/projects/source-project/asset?path=images%2Flook%20%26%20feel.png');assert.equal(file.name,asset.name);assert.equal(file.type,'image/png');assert.deepEqual([...new Uint8Array(await file.arrayBuffer())],[1,2,3]);
 await assert.rejects(readLibraryFiles(project,[asset],{maxBytes:2,fetchImpl}),/too large/i);
 await assert.rejects(readLibraryFiles(project,[asset,asset],{maxBytes:3,totalBytes:5,fetchImpl}),/combined size/i);
 await assert.rejects(readLibraryFiles(project,[asset],{fetchImpl:async()=>new Response('',{status:404})}),/could not read/i);
});
