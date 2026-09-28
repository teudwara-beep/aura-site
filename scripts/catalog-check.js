'use strict';

// A cached video must be rechecked before playback or a saved-list visit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const shown = [], notices = [];
let pending = [];
const context = vm.createContext({
  DATA:{videos:[{id:7,t:'Old title',status:'live'}, {id:8,t:'Still here',status:'live'}]},
  api:url => new Promise(resolve => pending.push({url,resolve})),
  getVideo:id => context.DATA.videos.find(video => Number(video.id) === Number(id)),
  $:selector => selector === '#video' ? {pause(){}} : selector === '#miniVideo' ? {pause(){}} : {hidden:false},
  toast:(...args) => notices.push(args), renderWatch:id => shown.push(id),
  show:()=>{}, setHash:()=>{}, goHome:()=>shown.push('home')
});
vm.runInContext(source.slice(source.indexOf('function cacheVideos('), source.indexOf('function applySiteBrand()')), context);
vm.runInContext('let watchRequestToken = 0;', context);
vm.runInContext(source.slice(source.indexOf('async function goWatch('), source.indexOf('function goCats()')), context);

async function main(){
  const removed = context.goWatch(7);
  const deletedRequest = pending.shift();
  assert.equal(deletedRequest.url, '/api/catalog?ids=7');
  deletedRequest.resolve({videos:[]});
  await removed;
  assert.deepEqual(shown, ['home']);
  assert.ok(!context.DATA.videos.some(video => video.id === 7));
  assert.ok(notices.some(([message]) => message.includes('no longer available')));
  const slow = context.goWatch(8);
  const slowRequest = pending.shift();
  const fast = context.goWatch(9);
  const fastRequest = pending.shift();
  fastRequest.resolve({videos:[{id:9,t:'Newest',status:'live'}]});
  await fast;
  slowRequest.resolve({videos:[{id:8,t:'Still here',status:'live'}]});
  await slow;
  assert.deepEqual(shown, ['home',9]);
  assert.equal(context.DATA.videos.find(video => video.id === 9).t, 'Newest');
  console.log('Catalog checks passed: removed videos leave the cache and slower navigation cannot replace the current video.');
}
main().catch(error => {console.error(error);process.exitCode=1;});
