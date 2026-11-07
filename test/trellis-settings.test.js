import test from 'node:test';
import assert from 'node:assert/strict';
import {trellisRequest} from '../src/trellis-settings.js';
import {rerunRequest} from '../src/rerun-request.js';

test('TRELLIS.2 controls validate and preserve seed, steps and texture size',()=>{
  const reference='4d4ad065-ce7e-44e6-b4fc-c1c62d6d326e.png';
  const request=trellisRequest({seed:'23',trellisSteps:'3',trellisTexture:512},[reference]);
  assert.deepEqual(request,{model:'trellis',references:[reference],seed:23,steps:3,texture_size:512});
  for(const draft of [{seed:-1},{trellisSteps:0},{trellisSteps:51},{trellisSteps:''},{trellisTexture:1000}])assert.throws(()=>trellisRequest(draft));
  assert.throws(()=>trellisRequest({},['4d4ad065-ce7e-44e6-b4fc-c1c62d6d326e.jpg']),/transparent/i);
  assert.deepEqual(rerunRequest({type:'trellis',request},'',{seed:9}),{...request,seed:9});
});
