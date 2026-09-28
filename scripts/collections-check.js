'use strict';

// Check the public collection routes and view calls without a browser runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const calls = [], shown = [], hashes = [], cached = [];
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    hidden:false, disabled:false, textContent:'', innerHTML:'', isConnected:true,
    addEventListener(){}, insertAdjacentHTML(position,html){ this.innerHTML += html; }
  });
  return elements.get(selector);
}
const gallery = {id:1,title:'Photo story',description:'Some photos',views:2,count:1,
  images:[{id:11,src:'/api/galleries/1/images/11/file',views:3,alt:''}]};
const collection = {id:2,title:'Video story',description:'In order',count:1,views:4,
  videos:[{id:7,t:'Published clip',status:'live',seed:0,v:1,d:'0:10',age:'just now'}]};
const context = vm.createContext({
  $:element,
  api:async (url,options={}) => {
    calls.push([url,options.method || 'GET']);
    if (url === '/api/galleries?page=1') return {galleries:[{id:1,title:gallery.title,count:1,cover:gallery.images[0].src,views:2}],pagination:{hasMore:false}};
    if (url === '/api/galleries/1') return {gallery};
    if (url === '/api/galleries/1/view') return {views:3};
    if (url === '/api/galleries/1/images/11/view') return {views:4};
    if (url === '/api/video-collections?page=1') return {collections:[{id:2,title:collection.title,count:1,coverVideoId:7,views:4}],pagination:{hasMore:false}};
    if (url === '/api/video-collections/2') return {collection};
    if (url === '/api/video-collections/2/view') return {views:5};
    throw new Error(`Unexpected API call ${url}`);
  },
  show:name => shown.push(name), setActive:()=>{}, setHash:hash => hashes.push(hash),
  SITE_SETTINGS:{contactEmail:'contact@example.test'},
  esc:value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
  fmtViews:value => String(value), artStyle:()=>'',
  cardHTML:video => `<article class="card" data-id="${video.id}"></article>`,
  cacheVideos:videos => cached.push(...videos), hydrateThumbs:()=>{}, hydrateThumbImages:()=>{},
  modalScrim:{classList:{contains:()=>true}}, openModal:()=>{},
  document:{addEventListener:()=>{}}, toast:()=>{}
});

const start = source.indexOf('let photoRequestToken = 0');
const end = source.indexOf('function goLibrary(kind)');
assert.ok(start >= 0 && end > start);
vm.runInContext(source.slice(start,end), context);

async function main() {
  await context.goPhotos();
  assert.match(element('#photosGrid').innerHTML, /2 views/);
  assert.ok(!calls.some(([url]) => url.endsWith('/view')), 'Listing alone must not count a view');
  await context.goPhotos(1);
  await Promise.resolve();
  assert.ok(calls.some(([url,method]) => url === '/api/galleries/1/view' && method === 'POST'));
  assert.match(element('#photoCollectionViews').textContent, /3 collection views/);
  context.openPhoto(gallery,0);
  element('#photoLarge').onload();
  await Promise.resolve();
  assert.ok(calls.some(([url,method]) => url === '/api/galleries/1/images/11/view' && method === 'POST'));
  assert.match(element('#photoCount').textContent, /4 views/);
  await context.goCollections();
  assert.match(element('#collectionsGrid').innerHTML, /Video story/);
  assert.ok(!calls.some(([url]) => url === '/api/video-collections/2/view'));
  await context.goCollections(2);
  await Promise.resolve();
  assert.deepEqual(cached.map(item => item.id),[7]);
  assert.match(element('#collectionsGrid').innerHTML, /data-id="7"/);
  assert.match(element('#collectionsViews').textContent,/5 collection views/);
  assert.ok(hashes.includes('collection=2') && shown.includes('collections'));
  console.log('Collection UI checks passed: public lists, detail routes, photo-open counting, and independent collection view calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
