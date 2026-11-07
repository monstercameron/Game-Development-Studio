import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {BVHLoader} from 'three/addons/loaders/BVHLoader.js';
import {TGALoader} from 'three/addons/loaders/TGALoader.js';
import {parsePlyPreview} from './ply-preview';

const side=320;
function canvas(){const c=document.createElement('canvas');c.width=side;c.height=side;return c}
function fit(c,source,width,height){if(!width||!height)throw Error('No visual frame.');const scale=Math.min(side/width,side/height),w=width*scale,h=height*scale;c.getContext('2d').drawImage(source,(side-w)/2,(side-h)/2,w,h)}
async function fetchBytes(url,max=64*1024*1024){const r=await fetch(url);if(!r.ok)throw Error('Cannot read asset.');if(Number(r.headers.get('content-length'))>max)throw Error('Asset is too large to preview.');const bytes=await r.arrayBuffer();if(bytes.byteLength>max)throw Error('Asset is too large to preview.');return bytes}
async function imageThumbnail(url,name){
 const c=canvas();
 if(/\.tga$/i.test(name)){
  const {data,width,height}=new TGALoader().parse(await fetchBytes(url));
  const raw=document.createElement('canvas');raw.width=width;raw.height=height;
  raw.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data),width,height),0,0);fit(c,raw,width,height);
 }else{
  const image=new Image();image.decoding='async';image.src=url;await image.decode();fit(c,image,image.naturalWidth,image.naturalHeight);
 }
 return c.toDataURL('image/png');
}
async function videoThumbnail(url){
 const video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video preview timed out.')),15000);video.onloadeddata=()=>{clearTimeout(timer);resolve()};video.onerror=()=>{clearTimeout(timer);reject(Error('Cannot decode video.'))};video.src=url;video.load()});
  const c=canvas();fit(c,video,video.videoWidth,video.videoHeight);return c.toDataURL('image/png');
 }finally{video.removeAttribute('src');video.load()}
}
function dispose(root){const geos=new Set(),mats=new Set(),textures=new Set();root?.traverse(o=>{if(o.geometry)geos.add(o.geometry);for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m){mats.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v)}});for(const t of textures)t.dispose();for(const m of mats)m.dispose();for(const g of geos)g.dispose()}
async function modelThumbnail(url,name){
 const bytes=await fetchBytes(url,/\.ply$/i.test(name)?256*1024*1024:64*1024*1024),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(38,1,.01,10000);let renderer,root,helper;
 try{
  const manager=new THREE.LoadingManager();manager.setURLModifier(value=>{if(value.startsWith('blob:')||value.startsWith('data:'))return value;throw Error('External model resources are not supported.')});
  let bounds=new THREE.Box3();
  if(/\.bvh$/i.test(name)){
   const motion=new BVHLoader().parse(new TextDecoder().decode(bytes));root=new THREE.Group();root.add(motion.skeleton.bones[0]);scene.add(root);
   const mixer=new THREE.AnimationMixer(motion.skeleton.bones[0]);mixer.clipAction(motion.clip).play();mixer.update(0);root.updateMatrixWorld(true);
   for(const bone of motion.skeleton.bones)bounds.expandByPoint(bone.getWorldPosition(new THREE.Vector3()));
   helper=new THREE.SkeletonHelper(motion.skeleton.bones[0]);helper.material.vertexColors=false;helper.material.color.set('#ffb99f');scene.add(helper);
  }else if(/\.ply$/i.test(name)){root=parsePlyPreview(bytes);scene.add(root);bounds.setFromObject(root)}
  else if(/\.fbx$/i.test(name)){root=new FBXLoader(manager).parse(bytes,'');scene.add(root);bounds.setFromObject(root)}
  else if(/\.glb$|\.gltf$/i.test(name)){root=(await new GLTFLoader(manager).parseAsync(bytes,'')).scene;scene.add(root);bounds.setFromObject(root)}
  else throw Error('This model format is not supported.');
  if(bounds.isEmpty())throw Error('No visible geometry.');
  const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),largest=Math.max(size.x,size.y,size.z);
  if(!Number.isFinite(largest)||largest<=0)throw Error('Invalid model dimensions.');
  root.position.sub(center);root.updateMatrixWorld(true);
  const distance=largest/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.65;
  camera.position.set(distance*.75,distance*.45,distance);camera.near=Math.max(largest/1000,.001);camera.far=largest*100;camera.lookAt(0,0,0);camera.updateProjectionMatrix();
  scene.add(new THREE.HemisphereLight(0xf2e9ff,0x4c3344,.85));const key=new THREE.DirectionalLight(0xffffff,1.3);key.position.set(4,6,5);scene.add(key);const fill=new THREE.DirectionalLight(0xffba9d,.55);fill.position.set(-4,2,-3);scene.add(fill);
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setSize(side,side,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.render(scene,camera);
  return renderer.domElement.toDataURL('image/png');
 }finally{dispose(root);helper?.geometry.dispose();helper?.material.dispose();renderer?.dispose();renderer?.forceContextLoss()}
}
export async function renderThumbnail(asset){const url=asset.url||asset.file,name=asset.name||asset.title||asset.id;if(['Images','Masks'].includes(asset.category))return imageThumbnail(url,name);if(asset.category==='Video')return videoThumbnail(url);if(asset.category==='3D')return modelThumbnail(url,name);throw Error('Not a visual asset.')}
