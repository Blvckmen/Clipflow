import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateControl} from '../core.mjs';
import {downloadUpload} from '../uploaded-video.mjs';
const id='6f1c2d3e-1111-4222-8333-444455556666';
test('uploaded video jobs validate IDs without exposing source URLs',()=>{
 const base={control:'running',streamers:[],duration:30,captions:true,dailyLimit:5};
 assert.deepEqual(validateControl({...base}).uploads,[]);
 assert.deepEqual(validateControl({...base,uploads:[{id,streamerId:id}]}).uploads,[{id,streamerId:id}]);
 assert.throws(()=>validateControl({...base,uploads:[{id:'../../secret',streamerId:id}]}),/Invalid uploaded/);
});
test('uploaded downloads refuse invalid IDs and unavailable or oversized sources',async()=>{
 await assert.rejects(downloadUpload('../bad','unused',()=>{throw Error('must not fetch')}),/Invalid uploaded video id/);
 await assert.rejects(downloadUpload(id,'unused',async path=>{assert.equal(path,'/api/worker/recordings/'+id+'/source');return new Response(null,{status:404});}),/HTTP 404/);
 await assert.rejects(downloadUpload(id,'unused',async()=>new Response('x',{headers:{'content-length':String(3*1024**3)}})),/Invalid uploaded video size/);
});
