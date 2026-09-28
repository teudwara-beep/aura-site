'use strict';

// Focused event/state checks using Node DOM doubles; not a browser rendering test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getEventListeners, setMaxListeners } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
class Element extends EventTarget {
  constructor() {
    super(); this.style = {}; this.dataset = {}; this.attributes = {}; this.children = new Map();
    this.tagName = 'DIV'; this.currentTime = 0; this.duration = 100; this.volume = 1;
    this.paused = true; this.readyState = 0; this.buffered = { length:0 }; this.hidden = true;
    const names = new Set();
    this.classList = { add:name => names.add(name), remove:name => names.delete(name), contains:name => names.has(name), toggle:(name, on = !names.has(name)) => { on ? names.add(name) : names.delete(name); return on; } };
  }
  querySelector(key) { if (!this.children.has(key)) this.children.set(key, new Element()); return this.children.get(key); }
  querySelectorAll() { return []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  getBoundingClientRect() { return { left:0, width:100 }; }
  closest() { return null; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() { this.loaded = true; }
  click() { this.onclick?.(); }
}
function fire(target, type, properties={}) {
  const event = new Event(type, { cancelable:true });
  Object.assign(event, properties); target.dispatchEvent(event);
}
async function main() {
  let nodes = new Map(), timerId = 0;
  const timers = new Map(), history = [], navigations = [], notices = [], modals = [];
  const document = new Element(), window = new Element();
  const select = key => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  const context = vm.createContext({
    $, console, document, window, Event, AbortController:class extends AbortController {
      constructor() { super(); setMaxListeners(100, this.signal); }
    },
    $$:() => [], playerCleanup:null, miniVideoId:null, miniSavedSecond:-1,
    PREFS:{saveHistory:true, autoplay:true}, HISTORY:[], FAVORITES:[], WATCHLATER:[],
    views:{watch:{hidden:false}}, modalScrim:new Element(),
    setTimeout:callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout:id => timers.delete(id),
    durToSec:() => 100, fmtTime:String, addToHistory:(...args) => history.push(args),
    relatedFor:() => [{id:2, t:'Next'}], goWatch:id => { navigations.push(id); return Promise.resolve(); },
    api:() => Promise.resolve(), toast:(...args) => notices.push(args),
    goHome:() => {}, copyVideoLink:() => {},
    location:{href:'https://example.test/#home'}, navigator:{}, esc:String,
    openModal:options => modals.push(options)
  });
  function $(key) { return select(key); }
  const start = source.indexOf('function bindPlayer(v){');
  vm.runInContext(source.slice(start, source.indexOf('\n/* ===', start)), context);
  // Repeated route changes must leave no global handlers, timers or media handlers behind.
  for (let n=0; n<5; n++) {
    nodes = new Map();
    context.bindPlayer({id:1, d:'1:40', t:'Sample'});
    const video = select('#video');
    await video.play(); video.currentTime = 20; fire(video, 'timeupdate');
    select('#moreControlsBtn').click();
    assert.equal(select('#moreControlsBtn').attributes['aria-expanded'], 'true');
    assert.equal(select('#controls').classList.contains('expanded'), true);
    assert.equal(select('#player').classList.contains('idle'), false);
    select('#moreControlsBtn').click();
    assert.equal(select('#moreControlsBtn').attributes['aria-expanded'], 'false');
    fire(select('#timeline'), 'keydown', {key:'ArrowRight'});
    assert.equal(video.currentTime, 25);
    assert.equal(select('#timeline').attributes['aria-valuenow'], '25');
    fire(select('#timeline'), 'touchstart', { touches:[{clientX:50}] });
    assert.equal(video.currentTime, 50);
    fire(select('#timeline'), 'touchcancel');
    assert.equal(select('#timeline').classList.contains('dragging'), false);
    video.currentTime = 25;
    assert.equal(getEventListeners(document, 'keydown').length, 1);
    fire(video, 'error'); assert.equal(select('#playerError').hidden, false);
    select('#retryVideo').click(); assert.equal(select('#playerError').hidden, true);
    fire(video, 'ended');
    assert.ok(timers.size > 0);
    context.playerCleanup();
    assert.equal(timers.size, 0, 'Leaving watch cancels autoplay and control timers');
    for (const [target, types] of [[document,['keydown','click','fullscreenchange']], [window,['mousemove','mouseup']], [video,['pause','error','timeupdate','ended']]]) {
      for (const type of types) assert.equal(getEventListeners(target, type).length, 0, `${type} listener leaked`);
    }
  }
  assert.equal(navigations.length, 0);
  assert.ok(history.some(([id, position]) => id === 1 && position === 25));
  // Clipboard failures must present a selectable link, never a false success toast.
  const copyStart = source.indexOf('async function copyVideoLink(');
  vm.runInContext(source.slice(copyStart, source.indexOf('function closeModal()', copyStart)), context);
  context.navigator.clipboard = { writeText:async () => { throw new Error('Denied'); } };
  notices.length = 0;
  await context.copyVideoLink(7, 'Sample');
  assert.ok(modals.at(-1).body.includes('#watch=7'));
  assert.ok(!notices.some(([message]) => message === 'Link copied.'));
  context.navigator.clipboard.writeText = async () => {};
  await context.copyVideoLink(7, 'Sample');
  assert.equal(notices.at(-1)[0], 'Link copied.');
  // Mini playback updates the same history and marks a completed video at its duration.
  const miniStart = source.indexOf('/* Mini player */\nlet miniVideoId');
  vm.runInContext(source.slice(miniStart, source.indexOf('\n/* ===', miniStart)), context);
  vm.runInContext('miniVideoId = 7;', context);
  const mini = select('#miniVideo');
  mini.currentTime = 35; fire(mini, 'timeupdate');
  assert.deepEqual(history.at(-1), [7,35,100]);
  mini.currentTime = 100; fire(mini, 'ended');
  assert.deepEqual(history.at(-1), [7,100,100]);
  console.log('Player checks passed: route cleanup, autoplay cancellation, mobile controls/touch seeking, keyboard seeking, error retry, clipboard fallback, and mini-player history.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
