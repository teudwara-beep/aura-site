'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../css/styles.css'), 'utf8');
const start = source.indexOf('/* Touch previews play only after a deliberate tap');
const end = source.indexOf('/* Load a real, muted preview', start);
assert.ok(start >= 0 && end > start && source.includes('data-touch-preview aria-label='));
assert.match(css, /@media \(hover:none\), \(pointer:coarse\)\{[^}]*\.card-preview-btn\{display:inline-flex\}/);

class Element {
  constructor(id = '') {
    this.dataset = {id}; this.attributes = {}; this.children = []; this.paused = true;
    this.classList = {add:name => { this.ready = name; }};
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(name) { return name === '.thumb' ? this.thumb : null; }
  appendChild(child) { this.children.push(child); child.parent = this; }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  pause() { this.paused = true; }
  load() { this.loaded = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

let observer, messages = [];
class Observer {
  constructor(callback) { this.callback = callback; this.watched = new Set(); observer = this; }
  observe(card) { this.watched.add(card); }
  unobserve(card) { this.watched.delete(card); }
  change(card, ratio) { this.callback([{target:card,intersectionRatio:ratio}]); }
}
const handlers = {};
const document = {hidden:false,createElement:() => new Element(),addEventListener:(name, fn) => {handlers[`document:${name}`] = fn;}};
const window = {IntersectionObserver:Observer,addEventListener:(name, fn) => {handlers[`window:${name}`] = fn;}};
const context = vm.createContext({document,window,IntersectionObserver:Observer,toast:(...args) => messages.push(args),encodeURIComponent,getVideo:id => id===3 ? {bunnyPreview:'https://test.b-cdn.net/id/preview_hq.mp4'} : null});
vm.runInContext(source.slice(start,end), context);
const card = id => {const item = new Element(String(id)); item.thumb = new Element(); return item;};
const first = card(1), second = card(2), firstButton = new Element(), secondButton = new Element();

async function main() {
  context.toggleTouchPreview(first, firstButton);
  const firstVideo = first.thumb.children[0];
  assert.equal(firstVideo.src, '/api/videos/1/file?preview=1');
  assert.equal(firstVideo.muted, true);
  assert.equal(firstVideo.playsInline, true);
  assert.equal(firstButton.attributes['aria-pressed'], 'true');
  firstVideo.onplaying();
  assert.equal(firstVideo.ready, 'is-ready');
  const bunnyCard=card(3), bunnyButton=new Element();
  context.toggleTouchPreview(bunnyCard,bunnyButton);
  assert.equal(bunnyCard.thumb.children[0].src,'https://test.b-cdn.net/id/preview_hq.mp4');
  context.stopTouchPreview();
  context.toggleTouchPreview(first,firstButton);
  context.toggleTouchPreview(second, secondButton);
  assert.equal(first.thumb.children.length, 0, 'Starting another preview unloads the old source');
  assert.equal(firstButton.attributes['aria-pressed'], 'false');
  assert.equal(second.thumb.children.length, 1);
  observer.change(second, 0);
  assert.equal(second.thumb.children.length, 0, 'Scrolling the preview away unloads it');
  context.toggleTouchPreview(first, firstButton);
  document.hidden = true;
  handlers['document:visibilitychange']();
  assert.equal(first.thumb.children.length, 0, 'Backgrounding the page unloads the preview');
  document.hidden = false;
  context.toggleTouchPreview(first, firstButton);
  context.toggleTouchPreview(first, firstButton);
  assert.equal(first.thumb.children.length, 0, 'Tapping again stops the preview');
  context.toggleTouchPreview(first, firstButton);
  handlers['window:pagehide']();
  assert.equal(first.thumb.children.length, 0, 'Leaving the page unloads the preview');
  await Promise.resolve();
  assert.equal(messages.length, 0);
  console.log('Mobile preview checks passed: muted inline playback, single preview, toggle off, scroll, and page cleanup.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
