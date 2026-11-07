import React, {useEffect, useRef, useState} from 'react';
import {Pause, Play, RotateCcw, RotateCw, ZoomIn, ZoomOut} from 'lucide-react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {BVHLoader} from 'three/addons/loaders/BVHLoader.js';
import './model-preview.css';

const MAX_BYTES=10*1024*1024;

export default function MotionPreview({url,name,playing=true,onPlayingChange=()=>{},timeRef}){
  const host=useRef(null),controlsRef=useRef(null),cameraRef=useRef(null),drawRef=useRef(null),playingRef=useRef(playing);
  const [status,setStatus]=useState('loading');
  useEffect(()=>{
    if(!host.current)return;
    const element=host.current,controller=new AbortController();
    let active=true,visible=false,renderer,scene,controls,resizeObserver,intersectionObserver,mixer,body,frame=0,lastTime=0;
    setStatus('loading');playingRef.current=playing;
    function draw(){if(!active||frame)return;frame=requestAnimationFrame(render)}
    function render(now){
      frame=0;if(!active||!renderer||!scene)return;
      const animate=visible&&!document.hidden&&playingRef.current&&mixer;
      if(animate&&lastTime)mixer.update(Math.min((now-lastTime)/1000,.1));
      lastTime=animate?now:0;
      body?.update();
      renderer.render(scene,cameraRef.current);
      if(animate)draw();
    }
    function resize(){if(!renderer||!cameraRef.current)return;const width=element.clientWidth,height=element.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);cameraRef.current.aspect=width/height;cameraRef.current.updateProjectionMatrix();draw()}
    function visibility(){lastTime=0;draw()}
    async function setup(){
      try{
        renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
        renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));element.appendChild(renderer.domElement);
        scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(38,1,.01,10000);cameraRef.current=camera;
        controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.addEventListener('change',draw);controlsRef.current=controls;drawRef.current=draw;
        resizeObserver=new ResizeObserver(resize);resizeObserver.observe(element);resize();
        intersectionObserver=new IntersectionObserver(entries=>{visible=!!entries[0]?.isIntersecting;lastTime=0;if(visible)draw()});intersectionObserver.observe(element);document.addEventListener('visibilitychange',visibility);
        const response=await fetch(url,{signal:controller.signal,redirect:'error'});if(!response.ok)throw Error('Could not read this motion file.');
        const length=Number(response.headers.get('content-length'));if(length>MAX_BYTES)throw Error('This motion file is too large to preview.');
        const bytes=await response.arrayBuffer();if(bytes.byteLength>MAX_BYTES)throw Error('This motion file is too large to preview.');
        const motion=new BVHLoader().parse(new TextDecoder().decode(bytes));if(!active)return;
        const root=motion.skeleton.bones[0];if(!root||!motion.clip)throw Error('This motion file has no playable skeleton.');
        const group=new THREE.Group();group.add(root);scene.add(group);
        // BVH bind poses can be far from the first animated pose. Frame the
        // actual first frame so the moving skeleton stays in view.
        mixer=new THREE.AnimationMixer(root);mixer.clipAction(motion.clip).play();mixer.setTime(timeRef?.current||0);group.updateMatrixWorld(true);
        const bounds=new THREE.Box3();for(const bone of motion.skeleton.bones)bounds.expandByPoint(bone.getWorldPosition(new THREE.Vector3()));
        const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),largest=Math.max(size.x,size.y,size.z);
        if(!Number.isFinite(largest)||largest<=0)throw Error('This skeleton has invalid dimensions.');
        group.position.sub(center);group.updateMatrixWorld(true);
        // WebGL line widths are often fixed to one pixel. Use lightweight
        // instanced joints and bone segments so motion remains legible at any size.
        const bones=motion.skeleton.bones, members=new Set(bones),links=bones.filter(bone=>members.has(bone.parent));
        const jointGeometry=new THREE.SphereGeometry(1,10,8),boneGeometry=new THREE.CylinderGeometry(1,1,1,8);
        const jointMaterial=new THREE.MeshBasicMaterial({color:'#ffe0cc'}),boneMaterial=new THREE.MeshBasicMaterial({color:'#f2ad96'});
        const joints=new THREE.InstancedMesh(jointGeometry,jointMaterial,bones.length),segments=new THREE.InstancedMesh(boneGeometry,boneMaterial,links.length);
        joints.frustumCulled=false;segments.frustumCulled=false;scene.add(joints,segments);
        const matrix=new THREE.Matrix4(),position=new THREE.Vector3(),end=new THREE.Vector3(),axis=new THREE.Vector3(),midpoint=new THREE.Vector3(),scale=new THREE.Vector3(),orientation=new THREE.Quaternion(),identity=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0);
        body={update(){
          group.updateMatrixWorld(true);
          bones.forEach((bone,index)=>{bone.getWorldPosition(position);matrix.compose(position,identity,scale.setScalar(largest*.012));joints.setMatrixAt(index,matrix)});
          links.forEach((bone,index)=>{bone.parent.getWorldPosition(position);bone.getWorldPosition(end);axis.subVectors(end,position);const length=axis.length();midpoint.addVectors(position,end).multiplyScalar(.5);orientation.setFromUnitVectors(up,length>1e-8?axis.multiplyScalar(1/length):up);matrix.compose(midpoint,orientation,scale.set(largest*.005,length,largest*.005));segments.setMatrixAt(index,matrix)});
          joints.instanceMatrix.needsUpdate=true;segments.instanceMatrix.needsUpdate=true;
        },dispose(){scene.remove(joints,segments);jointGeometry.dispose();boneGeometry.dispose();jointMaterial.dispose();boneMaterial.dispose()}};
        const distance=largest/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.5;camera.position.set(distance*.45,distance*.2,distance);camera.near=Math.max(largest/1000,.001);camera.far=largest*100;camera.updateProjectionMatrix();
        controls.target.set(0,0,0);controls.minDistance=largest*.25;controls.maxDistance=largest*12;controls.update();controls.saveState();
        setStatus('ready');draw();
      }catch(error){if(active&&error.name!=='AbortError')setStatus(error.message||'Could not preview this motion.')}
    }
    setup();return()=>{active=false;controller.abort();cancelAnimationFrame(frame);resizeObserver?.disconnect();intersectionObserver?.disconnect();document.removeEventListener('visibilitychange',visibility);if(timeRef&&mixer)timeRef.current=mixer.time;mixer?.stopAllAction();controls?.dispose();body?.dispose();renderer?.dispose();renderer?.forceContextLoss();renderer?.domElement.remove();controlsRef.current=null;cameraRef.current=null;drawRef.current=null};
  },[url]);
  function toggle(){playingRef.current=!playingRef.current;onPlayingChange(playingRef.current);drawRef.current?.()}
  function rotate(direction){const camera=cameraRef.current,controls=controlsRef.current;if(!camera||!controls)return;const offset=camera.position.clone().sub(controls.target);offset.applyAxisAngle(new THREE.Vector3(0,1,0),direction*Math.PI/8);camera.position.copy(controls.target).add(offset);controls.update();drawRef.current?.()}
  function zoom(factor){const camera=cameraRef.current,controls=controlsRef.current;if(!camera||!controls)return;const offset=camera.position.clone().sub(controls.target);const distance=THREE.MathUtils.clamp(offset.length()*factor,controls.minDistance,controls.maxDistance);camera.position.copy(controls.target).add(offset.setLength(distance));controls.update();drawRef.current?.()}
  return <div className="model-preview motion-preview"><div ref={host} className="model-preview-canvas" role="img" aria-label={`Animated skeleton preview of ${name}. Drag to rotate, scroll to zoom.`}/>{status!=='ready'&&<div className="model-preview-overlay" role="status">{status==='loading'?'Loading motion preview…':status}</div>}{status==='ready'&&<><div className="model-preview-hint">Skeleton preview · drag to rotate</div><div className="model-preview-tools" aria-label="Motion preview controls"><button type="button" aria-label={playing?'Pause motion':'Play motion'} title={playing?'Pause motion':'Play motion'} onClick={toggle}>{playing?<Pause size={16}/>:<Play size={16}/>}</button><button type="button" aria-label="Rotate left" title="Rotate left" onClick={()=>rotate(1)}><RotateCcw size={16}/></button><button type="button" aria-label="Rotate right" title="Rotate right" onClick={()=>rotate(-1)}><RotateCw size={16}/></button><button type="button" aria-label="Zoom in" title="Zoom in" onClick={()=>zoom(.8)}><ZoomIn size={16}/></button><button type="button" aria-label="Zoom out" title="Zoom out" onClick={()=>zoom(1.25)}><ZoomOut size={16}/></button><button type="button" onClick={()=>controlsRef.current?.reset()}>Reset</button></div></>}</div>;
}
