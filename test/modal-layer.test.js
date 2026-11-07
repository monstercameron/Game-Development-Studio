import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTopModal} from '../src/modal-layer.js';
test('modal keyboard and help scope follows the visible stacking layer',()=>{
 const settings={name:'settings',z:3},memory={name:'memory',z:10},picker={name:'picker',z:60},hidden={name:'hidden',z:999,hidden:true};
 const options={visible:d=>!d.hidden,zIndex:d=>d.z};
 assert.equal(selectTopModal([memory,settings,hidden],options),memory);
 assert.equal(selectTopModal([memory,picker,settings],options),picker);
 assert.equal(selectTopModal([settings,{name:'newer',z:3}],options).name,'newer');
 assert.equal(selectTopModal([hidden],options),null);
});
