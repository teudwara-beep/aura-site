'use strict';
/* ============================================================
   SECTION 1 · UTILITIES
   ============================================================ */
const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const RUNTIME = window.AURA_RUNTIME || { separateAdmin:false, isAdminHost:false };
if (RUNTIME.separateAdmin && !RUNTIME.isAdminHost) document.body.classList.add('admin-separated');
if (RUNTIME.isAdminHost) document.body.classList.add('admin-host');
const HUES = [268,232,200,172,300,24];

const esc = str => { const d = document.createElement('div'); d.textContent = String(str ?? ''); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
const fmtViews = n => { n = Number(n)||0; if(n>=1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(n>=1e3) return Math.round(n/1e3)+'K'; return String(n); };
const fmtTime = s => { if(!isFinite(s)||s<0) s=0; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=Math.floor(s%60); return h>0?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`; };
const fmtBytes = b => { if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; if(b<1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; };
const durToSec = s => { const p=String(s||'0:00').split(':').map(Number); return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+(p[1]||0); };

function artStyle(seed){
  const h1 = HUES[seed % HUES.length], h2 = (h1+46)%360;
  const x = 22+(seed*13)%48, y = 16+(seed*19)%40;
  return `background:
    radial-gradient(92% 118% at ${x}% ${y}%, hsl(${h1} 24% 26%) 0%, transparent 58%),
    radial-gradient(84% 100% at ${100-x}% ${100-y}%, hsl(${h2} 20% 19%) 0%, transparent 62%),
    linear-gradient(180deg,#1A1A1E 0%,#121216 100%);`;
}
function avatarStyle(seed){
  const h = HUES[seed % HUES.length];
  return `background:linear-gradient(140deg, hsl(${h} 22% 24%), hsl(${(h+40)%360} 18% 15%));color:hsl(${h} 40% 78%)`;
}

/* ============================================================
   SECTION 2 · SERVER CATALOG + LOCAL VIEWER PREFERENCES
   ============================================================ */
const KEYS = {
  PREFS:'aura.prefs.v2', HIST:'aura.hist.v2',
  FAV:'aura.fav.v2', LATER:'aura.later.v2',
  AGE:'aura.age.v2'
};

const DEFAULT_DATA = {
  videos: [],
  categories: []
};

const DEFAULT_PREFS = {
  theme:'dark', density:'comfortable', fontScale:1,
  reducedMotion:false, highContrast:false,
  autoplay:true, saveHistory:true, showContinue:true
};

function readJSON(key, fallback){
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJSON(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){ console.warn('Storage full', e); try{ toast('Storage is full. Some changes may not be saved.', 'warn'); }catch{} }
}

let DATA = JSON.parse(JSON.stringify(DEFAULT_DATA));
let PREFS = Object.assign({}, DEFAULT_PREFS, readJSON(KEYS.PREFS, {}));
for (const [key, fallback] of Object.entries(DEFAULT_PREFS)) {
  if (typeof PREFS[key] !== typeof fallback) PREFS[key] = fallback;
}
if (!['dark','light'].includes(PREFS.theme)) PREFS.theme = 'dark';
if (!['comfortable','compact'].includes(PREFS.density)) PREFS.density = 'comfortable';
if (![0.9,1,1.15].includes(PREFS.fontScale)) PREFS.fontScale = 1;
let HISTORY = readJSON(KEYS.HIST, []);
let FAVORITES = readJSON(KEYS.FAV, []);
let WATCHLATER = readJSON(KEYS.LATER, []);
HISTORY = Array.isArray(HISTORY) ? HISTORY.filter(item => item && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0).slice(0,60) : [];
HISTORY = HISTORY.map(item => ({id:Number(item.id), pos:Math.max(0, Number(item.pos) || 0), total:Math.max(0, Number(item.total) || 0), at:Number(item.at) || 0}));
FAVORITES = Array.isArray(FAVORITES) ? FAVORITES.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [];
WATCHLATER = Array.isArray(WATCHLATER) ? WATCHLATER.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [];
let SITE_SETTINGS = {siteName:'AURA', tagline:'A curated video experience', announcement:'', featuredVideoId:'', contactEmail:'', adHomeEnabled:'0', adHomeDesktopZone:'', adHomeMobileZone:'', adWatchEnabled:'0', adWatchDesktopZone:'', adWatchMobileZone:''};
let FEATURED_VIDEO = null;
let totalCatalogVideos = 0;
let homePage = 1, homeHasMore = false, homeTotal = 0, homeRequestToken = 0;
let homeRequestState = {query:'', filter:'All'};

function cacheVideos(videos){
  const cached = new Map(DATA.videos.map(video => [Number(video.id), video]));
  for (const video of videos || []) cached.set(Number(video.id), video);
  DATA.videos = [...cached.values()];
}

async function ensureVideos(ids){
  const missing = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && !getVideo(id)))];
  for (let start = 0; start < missing.length; start += 100){
    const batch = missing.slice(start, start + 100);
    const data = await api(`/api/catalog?ids=${batch.join(',')}`);
    cacheVideos(data.videos || []);
  }
}
async function refreshPublicVideos(ids){
  const unique = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  for (let start = 0; start < unique.length; start += 100){
    const batch = unique.slice(start, start + 100);
    const data = await api(`/api/catalog?ids=${batch.join(',')}`);
    const visible = new Set((data.videos || []).map(video => Number(video.id)));
    const requested = new Set(batch);
    DATA.videos = DATA.videos.filter(video => !requested.has(Number(video.id)) || visible.has(Number(video.id)));
    cacheVideos(data.videos || []);
  }
}

function applySiteBrand(){
  const name = SITE_SETTINGS.siteName || 'AURA';
  document.querySelectorAll('.logo-name').forEach(label => { label.textContent = name; });
  const ageMark = $('.age-brand');
  if (ageMark) ageMark.textContent = name;
  const about = $('[data-modal="about"]');
  if (about) about.textContent = `About ${name}`;
  $$('.studio, .u-name').forEach(label => { label.textContent = name; });
  const currentTitle = !$('#view-watch').hidden ? getVideo(currentVideoId)?.t : null;
  if (currentTitle && $('.player-title')) $('.player-title').textContent = `${currentTitle} · ${name}`;
  const featuredName = $('#heroMeta span:first-child');
  if (featuredName) featuredName.textContent = name;
  const tagline = SITE_SETTINGS.tagline || '';
  const taglineText = $('#siteTaglineText');
  if (taglineText){ taglineText.textContent = tagline; taglineText.hidden = !tagline; }
  const notice = $('#siteAnnouncement');
  if (notice){ notice.textContent = SITE_SETTINGS.announcement || ''; notice.hidden = !SITE_SETTINGS.announcement; }
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = `${name} — ${tagline || 'Curated videos and photos'}`;
  document.title = currentTitle ? `${currentTitle} — ${name}` : `${name} — Curated`;
  const initials = name.trim().split(/\s+/).length > 1
    ? name.trim().split(/\s+/).slice(0,2).map(word => Array.from(word)[0]).join('')
    : Array.from(name.trim()).slice(0,2).join('');
  $('#profileBtn').textContent = initials.toUpperCase();
  const contact = $('#siteContactLink');
  contact.hidden = !SITE_SETTINGS.contactEmail;
  if (SITE_SETTINGS.contactEmail) contact.href = `mailto:${encodeURIComponent(SITE_SETTINGS.contactEmail)}`;
}
function brandFileName(){
  return (SITE_SETTINGS.siteName || 'site').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'site';
}

async function api(url, options={}){
  const response = await fetch(url, {credentials:'same-origin', headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
  const data = await response.json().catch(()=>({}));
  if(!response.ok){ const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
  return data;
}
async function loadCatalog(){
  const data = await api('/api/catalog?page=1&sort=trending');
  DATA.videos = data.videos || [];
  DATA.categories = data.categories || [];
  SITE_SETTINGS = data.settings || SITE_SETTINGS;
  FEATURED_VIDEO = data.featuredVideo || null;
  if (FEATURED_VIDEO) cacheVideos([FEATURED_VIDEO]);
  totalCatalogVideos = Number(data.pagination?.total) || 0;
  homePage = Number(data.pagination?.page) || 1;
  homeTotal = Number(data.pagination?.total) || 0;
  homeHasMore = Boolean(data.pagination?.hasMore);
}

/* Ads use ExoClick's published asynchronous banner/native tag. Only numeric zone
   IDs enter the DOM; arbitrary scripts or markup never come from admin settings. */
function adPlacementHTML(placement){
  if (RUNTIME.isAdminHost || SITE_SETTINGS[`ad${placement}Enabled`] !== '1') return '';
  if (!['Home', 'Watch'].includes(placement)) return '';
  const desktop = SITE_SETTINGS[`ad${placement}DesktopZone`];
  const mobile = SITE_SETTINGS[`ad${placement}MobileZone`];
  if (![desktop,mobile].some(zone => /^\d{1,15}$/.test(zone || ''))) return '';
  return `<aside class="ad-placement ad-${placement.toLowerCase()}" aria-label="Advertisement"><span class="ad-label">Advertisement</span><div class="ad-creative" data-ad-placement="${placement}"></div></aside>`;
}
function hydrateAds(root){
  if (RUNTIME.isAdminHost) return;
  const mobile = window.matchMedia('(max-width: 680px)').matches;
  for (const box of root.querySelectorAll('[data-ad-placement]')) {
    const placement = box.dataset.adPlacement;
    if (box.dataset.adDevice === (mobile ? 'mobile' : 'desktop')) continue;
    const zone = SITE_SETTINGS[`ad${placement}${mobile ? 'Mobile' : 'Desktop'}Zone`];
    box.replaceChildren();
    box.dataset.adDevice = mobile ? 'mobile' : 'desktop';
    if (!/^\d{1,15}$/.test(zone || '')) { box.closest('.ad-placement').hidden = true; continue; }
    if (document.querySelector('script[data-aura-ads-failed]')) { box.closest('.ad-placement').hidden = true; continue; }
    box.closest('.ad-placement').hidden = false;
    const ad = document.createElement('ins');
    ad.className = 'eas6a97888e';
    ad.dataset.zoneid = zone;
    box.append(ad);
    if (!document.querySelector('script[data-aura-ads]')) {
      const script = document.createElement('script');
      script.src = 'https://a.magsrv.com/ad-provider.js';
      script.async = true;
      script.dataset.auraAds = '1';
      script.onerror = () => { script.dataset.auraAdsFailed = '1'; $$('.ad-placement').forEach(slot => { slot.hidden = true; }); };
      document.head.append(script);
    }
    window.AdProvider = window.AdProvider || [];
    window.AdProvider.push({serve:{}});
  }
}
window.addEventListener('resize', () => {
  const view = $('#view-home').hidden ? $('#view-watch').hidden ? null : $('#watchMain') : $('#homeGrid');
  if (view) hydrateAds(view);
});

/* ============================================================
   SECTION 3 · ADMIN AUTH
   ============================================================ */
let adminAuthenticated = false;
function isAdmin(){ return adminAuthenticated; }
async function loginAdmin(user, pass){
  try {
    await api('/api/admin/login', {method:'POST', body:JSON.stringify({email:user, password:pass})});
    adminAuthenticated = true;
    document.body.classList.add('is-admin');
    $$('.admin-only').forEach(el => el.style.display = '');
    return true;
  } catch(error){ toast(error.message, 'error'); return false; }
}
async function logoutAdmin(){
  try { await api('/api/admin/logout', {method:'POST', body:'{}'}); }
  catch(error){ toast(error.message || 'Could not sign out. Please try again.', 'error'); return; }
  adminAuthenticated = false;
  document.body.classList.remove('is-admin');
  $$('.admin-only').forEach(el => el.style.display = 'none');
  if (RUNTIME.isAdminHost){
    $('#adminLayout').innerHTML = renderAdminLock();
    bindAdminLock();
    show('admin'); setHash('admin');
  } else if (!$('#view-admin').hidden) goHome();
}

/* ============================================================
   SECTION 4 · TOAST / MODAL
   ============================================================ */
function toast(msg, type = '', action = null){
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const ip = type==='error' ? '<path d="M6 6l12 12M18 6L6 18"/>'
    : type==='warn' ? '<path d="M12 8v5M12 16.5v.01"/>'
    : '<path d="M4 12l5 5L20 6"/>';
  el.innerHTML = `<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${ip}</svg></div><div>${esc(msg)}</div>`;
  if (action){
    const b = document.createElement('button');
    b.className = 'toast-action'; b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.appendChild(b);
  }
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
}

const modalScrim = $('#modalScrim');
const modalEl = $('#modal');
let _modalOpener = null;
function openModal({title, body, footer='', size=''}){
  if (modalScrim._trap) document.removeEventListener('keydown', modalScrim._trap);
  _modalOpener = document.activeElement;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = footer;
  modalEl.className = 'modal' + (size ? ' ' + size : '');
  modalScrim.classList.add('open');
  document.body.classList.add('no-scroll');
  setTimeout(() => {
    const f = modalEl.querySelector('input,select,textarea,button.mbtn.primary');
    if (f) f.focus();
  }, 80);
  // Focus trap
  modalScrim._trap = e => {
    if (e.key !== 'Tab') return;
    const f = [...modalEl.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    const first = f[0], last = f[f.length-1];
    if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', modalScrim._trap);
}
async function copyVideoLink(id, title, share = false){
  const url = location.href.split('#')[0] + '#watch=' + id;
  if (share && navigator.share){
    try { await navigator.share({title, url}); return; }
    catch(error){ if (error.name === 'AbortError') return; }
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url);
    toast('Link copied.', 'success');
  } catch {
    openModal({title:'Video link', body:`<div class="field"><label for="shareLink">Copy this link</label><input id="shareLink" readonly value="${esc(url)}"></div>`, footer:'<button class="mbtn" data-close-modal>Close</button>'});
    $('#shareLink').onfocus = event => event.target.select();
  }
}
function closeModal(){
  if (uploadBusy && $('#uploadPreview')) { toast('Wait for the current upload to finish.', 'warn'); return; }
  activePhotoImages = null;
  activePhotoGalleryId = null;
  $$('#modalBody video').forEach(video => { video.onerror = null; video.onloadedmetadata = null; video.onloadeddata = null; video.pause(); video.removeAttribute('src'); video.load(); });
  if (uploadPreviewURL){ URL.revokeObjectURL(uploadPreviewURL); uploadPreviewURL = null; }
  if (categoryPreviewURL){ URL.revokeObjectURL(categoryPreviewURL); categoryPreviewURL = null; }
  modalScrim.classList.remove('open');
  if ($('#ageGate').hidden) document.body.classList.remove('no-scroll');
  if (modalScrim._trap) document.removeEventListener('keydown', modalScrim._trap);
  if (_modalOpener && _modalOpener.focus && document.contains(_modalOpener)) _modalOpener.focus();
}
$('#modalClose').onclick = closeModal;
modalEl.addEventListener('click', e => { if (e.target.closest('[data-close-modal]')) closeModal(); });
modalScrim.addEventListener('click', e => { if (e.target === modalScrim) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalScrim.classList.contains('open')) closeModal(); });

function confirmAction(msg, onYes, label = 'Continue'){
  openModal({
    title: 'Are you sure?',
    body: `<p style="color:var(--text-2);font-size:13.5px;line-height:1.7">${esc(msg)}</p>`,
    footer: `<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn danger" id="cfYes">${esc(label)}</button>`
  });
  $('#cfYes').onclick = () => { onYes(); closeModal(); };
}

/* ============================================================
   SECTION 5 · LEGAL PAGES
   ============================================================ */
const LEGAL = {
  tos:{title:'Terms of Service',body:() => `<p>Use ${esc(SITE_SETTINGS.siteName || 'AURA')} only where you are legally allowed to view its content. Only the site administrator may upload videos and photos. The administrator is responsible for having the rights and permissions required to publish every item.</p>`},
  privacy:{title:'Privacy Policy',body:() => `<p>${esc(SITE_SETTINGS.siteName || 'AURA')} stores watch history, liked videos, and preferences in this browser. A host-only cookie helps avoid counting repeated video plays, collection opens and photo opens as separate views within 30 minutes. Admin credentials, catalog information, removal requests, uploaded videos and photos are processed by the server. Removal requests include your name, email, reason and description and are visible only to the administrator.</p>${['Home','Watch'].some(place => SITE_SETTINGS[`ad${place}Enabled`] === '1') ? '<p>When ads are enabled, ad content is delivered by ExoClick. Its advertising service may receive your IP address and use cookies or other identifiers. Review the advertising provider’s privacy information for details.</p>' : ''}`},
  dmca:{title:'Copyright / Takedown',body:'<p>Use Request video removal for concerns about a published video. For concerns about a photo collection, use the contact link on that collection or email the operator. Include the link and enough detail to review the issue. Requests do not automatically remove content.</p><p>For a formal copyright notice or a concern about content that has already disappeared from the site, contact the operator at the email below when it is available.</p>'},
  about:{title:() => `About ${SITE_SETTINGS.siteName || 'AURA'}`,body:() => `<p>${esc(SITE_SETTINGS.siteName || 'AURA')} is a curated video and photo site.${SITE_SETTINGS.tagline ? ` ${esc(SITE_SETTINGS.tagline)}` : ''}</p>`}
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-modal]');
  if (!t) return;
  e.preventDefault();
  const p = LEGAL[t.dataset.modal];
  if (!p) return;
  const contact = t.dataset.modal === 'dmca' && SITE_SETTINGS.contactEmail ? `<p>Email: <a href="mailto:${encodeURIComponent(SITE_SETTINGS.contactEmail)}">${esc(SITE_SETTINGS.contactEmail)}</a></p>` : '';
  openModal({title:typeof p.title === 'function' ? p.title() : p.title, body:`<div style="color:var(--text-2);font-size:13.5px;line-height:1.75">${typeof p.body === 'function' ? p.body() : p.body}${contact}</div>`, footer:`<button class="mbtn primary" data-close-modal>Got it</button>`});
});

function videoIdFromReportInput(value){
  const raw = String(value || '').trim();
  if (/^\d{1,12}$/.test(raw)) return Number(raw);
  try {
    const url = new URL(raw);
    if (url.origin !== location.origin || !/^#watch=\d{1,12}$/.test(url.hash)) return null;
    return Number(url.hash.slice(7));
  } catch { return null; }
}
function openRemovalRequest(video = null){
  const current = video || (location.hash.startsWith('#watch=') && !views.watch.hidden ? getVideo(Number(location.hash.slice(7))) : null);
  openModal({title:'Request video removal',body:`
    <p class="request-hint">Tell the administrator which video needs review and why. Your request is private; submitting it does not remove the video automatically.</p>
    <div class="field"><label for="reportVideo">Video link or ID</label><input id="reportVideo" value="${current ? esc(location.origin + '/#watch=' + current.id) : ''}" placeholder="Paste a video link or ID" maxlength="500"></div>
    <div class="field"><label for="reportReason">Reason</label><select id="reportReason"><option value="copyright">Copyright / ownership</option><option value="privacy">Privacy / consent</option><option value="safety">Safety concern</option><option value="other">Other concern</option></select></div>
    <div class="field"><label for="reportName">Your name</label><input id="reportName" maxlength="120" autocomplete="name"></div>
    <div class="field"><label for="reportEmail">Reply email</label><input id="reportEmail" type="email" maxlength="254" autocomplete="email"></div>
    <div class="field"><label for="reportDetails">What should we review?</label><textarea id="reportDetails" minlength="20" maxlength="4000" rows="4" placeholder="Describe the issue and your connection to the video. Do not include unnecessary sensitive details."></textarea></div>
    <p class="request-hint">Your name, email and description go to the private admin inbox so the operator can review and contact you.</p>`,
    footer:'<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn primary" id="reportSubmit">Send request</button>'});
  $('#reportSubmit').onclick = async () => {
    const id = videoIdFromReportInput($('#reportVideo').value);
    if (!id) return toast('Enter a valid video link from this site or a video ID.', 'warn');
    const body = {videoId:id,reason:$('#reportReason').value,name:$('#reportName').value.trim(),email:$('#reportEmail').value.trim(),details:$('#reportDetails').value.trim()};
    if (body.name.length < 2 || !$('#reportEmail').checkValidity() || !body.email || body.details.length < 20) return toast('Add your name, a valid email and at least 20 characters describing the issue.', 'warn');
    const button = $('#reportSubmit'); button.disabled = true;
    try {
      const result = await api('/api/reports', {method:'POST',body:JSON.stringify(body)});
      if (!button.isConnected) return;
      $('#modalBody').innerHTML = `<div class="request-confirmation" role="status"><h3>Request received</h3><p>Reference: <strong>${esc(result.reference)}</strong></p><p>The administrator can review it in the private panel. If needed, they can reply to the email you provided.</p></div>`;
      $('#modalFoot').innerHTML = '<button class="mbtn primary" data-close-modal>Done</button>';
    } catch(error) { toast(error.message || 'Request could not be sent.', 'error'); button.disabled = false; }
  };
}
document.addEventListener('click', event => {
  const link = event.target.closest('[data-report]');
  if (!link) return;
  event.preventDefault();
  openRemovalRequest();
});

/* ============================================================
   SECTION 6 · PREFERENCES
   ============================================================ */
function applyPrefs(){
  const h = document.documentElement;
  h.setAttribute('data-theme', PREFS.theme);
  h.setAttribute('data-density', PREFS.density);
  h.setAttribute('data-contrast', PREFS.highContrast ? 'high' : 'normal');
  h.setAttribute('data-reduced-motion', PREFS.reducedMotion ? 'true' : 'false');
  h.style.setProperty('--font-scale', PREFS.fontScale);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = PREFS.theme === 'light' ? '#F7F7F9' : '#0B0B0D';
  // Theme icons
  const sun = $('.sun'), moon = $('.moon');
  if (sun && moon){
    sun.style.display = PREFS.theme === 'dark' ? 'block' : 'none';
    moon.style.display = PREFS.theme === 'light' ? 'block' : 'none';
  }
  syncSettingsUI();
}
function savePrefs(){ writeJSON(KEYS.PREFS, PREFS); applyPrefs(); }

function syncSettingsUI(){
  $$('.segmented').forEach(seg => {
    $$('button', seg).forEach(b => b.classList.toggle('active', String(PREFS[seg.dataset.pref]) === b.dataset.val));
  });
  $$('.toggle[data-toggle]').forEach(t => { t.classList.toggle('on', !!PREFS[t.dataset.toggle]); t.setAttribute('aria-checked', String(!!PREFS[t.dataset.toggle])); });
  $('#autoToggle').classList.toggle('on', !!PREFS.autoplay);
  $('#autoToggle').setAttribute('aria-pressed', String(!!PREFS.autoplay));
  const st = $('#adminStatusText');
  if (st) st.textContent = isAdmin() ? 'Signed in as administrator' : 'Not signed in';
  const ab = $('#adminLoginToggle');
  if (ab) ab.textContent = isAdmin() ? 'Sign out' : 'Sign in';
}

document.addEventListener('click', e => {
  const seg = e.target.closest('.segmented button');
  if (seg){
    const key = seg.closest('.segmented').dataset.pref;
    let val = seg.dataset.val;
    if (key === 'fontScale') val = parseFloat(val);
    PREFS[key] = val;
    savePrefs();
    return;
  }
  const tg = e.target.closest('.toggle[data-toggle]');
  if (tg){
    const k = tg.dataset.toggle;
    PREFS[k] = !PREFS[k];
    if (k === 'reducedMotion') {
      heroPreviewId = '';
      if (!RUNTIME.isAdminHost) setHeroPreview(getVideo(SITE_SETTINGS.featuredVideoId) || FEATURED_VIDEO);
    }
    savePrefs();
    if (k === 'showContinue') renderContinueRow().catch(error => console.warn(error));
    if (k === 'saveHistory' && !PREFS.saveHistory){
      HISTORY = []; writeJSON(KEYS.HIST, HISTORY); renderContinueRow().catch(error => console.warn(error));
    }
  }
});

$('#themeBtn').onclick = () => {
  PREFS.theme = PREFS.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
};

/* ============================================================
   SECTION 7 · HISTORY / FAVORITES / LIBRARY
   ============================================================ */
function resumablePosition(entry, duration){
  const pos = Number(entry?.pos), total = Number(duration);
  if (!Number.isFinite(pos) || !Number.isFinite(total) || total <= 0) return null;
  const minimumWatched = Math.max(3, Math.min(30, total * .02));
  const minimumRemaining = Math.max(3, Math.min(20, total * .05));
  return pos >= minimumWatched && pos < total - minimumRemaining ? pos : null;
}
function addToHistory(id, pos = 0, total = null){
  if (!PREFS.saveHistory) return;
  const v = getVideo(id);
  if (!v) return;
  const entry = {id, pos, total: total || durToSec(v.d), at: Date.now()};
  HISTORY = HISTORY.filter(h => h.id !== id);
  HISTORY.unshift(entry);
  HISTORY = HISTORY.slice(0, 60);
  writeJSON(KEYS.HIST, HISTORY);
  renderContinueRow().catch(error => console.warn('Could not refresh continue-watching videos:', error.message));
}
function toggleFavorite(id){
  const on = !FAVORITES.includes(id);
  if (on) FAVORITES.push(id);
  else FAVORITES = FAVORITES.filter(x => x !== id);
  writeJSON(KEYS.FAV, FAVORITES);
  return on;
}
function toggleWatchLater(id){
  const on = !WATCHLATER.includes(id);
  if (on) WATCHLATER.push(id);
  else WATCHLATER = WATCHLATER.filter(x => x !== id);
  writeJSON(KEYS.LATER, WATCHLATER);
  return on;
}
/* ============================================================
   SECTION 8 · VIDEO ACCESS
   ============================================================ */
function getVideo(id){ return DATA.videos.find(v => Number(v.id) === Number(id)); }
let relatedVideoId = null, relatedVideos = null;
function relatedFor(v){
  if (relatedVideoId === v.id && relatedVideos) return relatedVideos;
  return DATA.videos
    .filter(x => x.id !== v.id && (x.status === 'live' || isAdmin()))
    .sort((a,b) => (b.c === v.c) - (a.c === v.c))
    .slice(0, 8);
}
async function loadRelatedVideos(video, token){
  if (video.status !== 'live') return;
  try {
    const result = await api(`/api/videos/${encodeURIComponent(video.id)}/related`);
    if (token !== watchRequestToken || currentVideoId !== video.id) return;
    relatedVideoId = video.id;
    relatedVideos = result.videos || [];
    cacheVideos(relatedVideos);
    $('#relatedList').innerHTML = relatedVideos.map(sideCardHTML).join('') || '<p class="related-empty">No more videos yet.</p>';
    hydrateThumbs($('#relatedList'));
  } catch(error) { console.warn('Related videos could not load:', error.message); }
}

/* ============================================================
   SECTION 9 · CARD BUILDERS
   ============================================================ */
function cardHTML(v, i = 0, opts = {}){
  const progress = opts.progress;
  const resumeAt = opts.resumeAt;
  return `
  <article class="card" data-id="${v.id}" style="animation-delay:${Math.min(i * 25, 300)}ms" role="button" tabindex="0"${resumeAt != null ? ` aria-label="Continue ${esc(v.t)} at ${fmtTime(resumeAt)}"` : ''}>
    <div class="thumb">
      <div class="thumb-art" data-thumb-id="${v.id}" style="${artStyle(v.seed)}"></div>
      <button class="card-preview-btn" type="button" data-touch-preview aria-label="Preview ${esc(v.t)}" aria-pressed="false">▶ Preview</button>
      <div class="dur mono">${v.d}</div>
      ${resumeAt != null ? `<span class="resume-label">Resume at ${fmtTime(resumeAt)}</span>` : ''}
      ${progress != null ? `<div class="prog-static"><i style="width:${progress}%"></i></div>` : ''}
    </div>
    <div class="card-body">
      <h3 class="card-title">${esc(v.t)}</h3>
      <div class="card-meta">
        <span class="studio">${esc(SITE_SETTINGS.siteName || 'AURA')}</span>
        <span class="dot"></span>
        <span>${fmtViews(v.v)} views</span>
        <span class="dot"></span>
        <span>${esc(v.age)}</span>
      </div>
      <button class="card-menu" data-card-menu="${v.id}" aria-label="More options">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="6" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18" r="1.4"/></svg>
      </button>
    </div>
  </article>`;
}

function sideCardHTML(v){
  return `
  <div class="side-item" data-id="${v.id}" role="button" tabindex="0">
    <div class="thumb">
      <div class="thumb-art" data-thumb-id="${v.id}" style="${artStyle(v.seed)}"></div>
      <div class="side-dur">${v.d}</div>
    </div>
    <div class="side-info">
      <h4 class="s-title">${esc(v.t)}</h4>
      <div class="s-meta">
        <span class="studio">${esc(SITE_SETTINGS.siteName || 'AURA')}</span><br>
        ${fmtViews(v.v)} views<span class="sep">·</span>${esc(v.age)}
      </div>
    </div>
  </div>`;
}

/* Capture a single frame for visible cards. Keep a color fallback if decoding fails. */
const thumbFrames = new Map();
const thumbPending = new Map();
const thumbEpochs = new Map();
function invalidateThumb(id){
  for (const scope of ['admin','public']){
    const key = `${scope}:${id}`;
    thumbEpochs.set(key, (thumbEpochs.get(key) || 0) + 1);
    thumbFrames.delete(key); thumbPending.delete(key);
  }
}
const thumbQueue = [];
let thumbActive = 0;

function captureVideoFrame(id, admin = false){
  const entry = getVideo(id);
  if (entry?.bunny) return Promise.resolve(entry.bunnyThumbnail || null);
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    let finished = false;
    const finish = frame => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      resolve(frame);
    };
    const timer = setTimeout(() => finish(null), 12000);
    const capture = () => {
      if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 384; canvas.height = 216;
        const context = canvas.getContext('2d');
        if (!context) return finish(null);
        const width = video.videoWidth, height = video.videoHeight, aspect = 16 / 9;
        const cropWidth = Math.min(width, height * aspect), cropHeight = Math.min(height, width / aspect);
        context.drawImage(video, (width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', .8));
      } catch { finish(null); }
    };
    video.onloadedmetadata = () => {
      const position = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(3, video.duration * .2) : 0;
      if (position > 0) video.currentTime = position;
      else capture();
    };
    video.onloadeddata = capture;
    video.onseeked = capture;
    video.onerror = () => finish(null);
    video.src = admin ? `/api/admin/videos/${encodeURIComponent(id)}/file` : `/api/videos/${encodeURIComponent(id)}/file?preview=1`;
  });
}

function pumpThumbQueue(){
  while (thumbActive < 2 && thumbQueue.length){
    const {id, admin, key, epoch, resolve} = thumbQueue.shift();
    thumbActive++;
    captureVideoFrame(id, admin).then(frame => {
      if ((thumbEpochs.get(key) || 0) !== epoch) { resolve(null); return; }
      if (frame) thumbFrames.set(key, frame);
      if (thumbFrames.size > 120) thumbFrames.delete(thumbFrames.keys().next().value);
      thumbPending.delete(key);
      resolve(frame);
    }).catch(() => { if ((thumbEpochs.get(key) || 0) === epoch) thumbPending.delete(key); resolve(null); }).finally(() => { thumbActive--; pumpThumbQueue(); });
  }
}

function requestThumbFrame(id, admin = false){
  const key = `${admin ? 'admin' : 'public'}:${id}`;
  if (thumbFrames.has(key)) return Promise.resolve(thumbFrames.get(key));
  if (thumbPending.has(key)) return thumbPending.get(key);
  const pending = new Promise(resolve => { thumbQueue.push({id, admin, key, epoch:thumbEpochs.get(key) || 0, resolve}); });
  thumbPending.set(key, pending);
  pumpThumbQueue();
  return pending;
}

function showThumbFrame(art, frame){
  if (!frame) return;
  art.style.backgroundImage = `url("${frame}")`;
  art.style.backgroundSize = 'cover';
  art.style.backgroundPosition = 'center';
}

const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const entry of entries){
    if (!entry.isIntersecting) continue;
    const art = entry.target, id = Number(art.dataset.thumbId), admin = art.dataset.thumbAdmin === 'true';
    thumbObserver.unobserve(art);
    requestThumbFrame(id, admin).then(frame => {
      if (art.isConnected && Number(art.dataset.thumbId) === id) showThumbFrame(art, frame);
    });
  }
}, {rootMargin:window.matchMedia('(max-width: 680px)').matches ? '80px' : '240px'}) : null;

function hydrateThumbImages(root){
  $$('[data-thumb-id]', root).forEach(art => {
    const id = Number(art.dataset.thumbId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const admin = art.dataset.thumbAdmin === 'true', key = `${admin ? 'admin' : 'public'}:${id}`;
    if (art.dataset.thumbObserved === key){
      if (thumbFrames.has(key)) showThumbFrame(art, thumbFrames.get(key));
      else if (thumbObserver) thumbObserver.observe(art);
      return;
    }
    thumbObserver?.unobserve(art);
    art.dataset.thumbObserved = key;
    if (thumbFrames.has(key)) showThumbFrame(art, thumbFrames.get(key));
    else if (thumbObserver) thumbObserver.observe(art);
    else requestThumbFrame(id, admin).then(frame => { if (art.isConnected && Number(art.dataset.thumbId) === id) showThumbFrame(art, frame); });
  });
}

/* Touch previews play only after a deliberate tap and never continue offscreen. */
let activeTouchPreview = null;
const touchPreviewObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  if (entries.some(entry => activeTouchPreview?.card === entry.target && entry.intersectionRatio < .15)) stopTouchPreview();
}, {threshold:[0,.15]}) : null;
function stopTouchPreview(){
  if (!activeTouchPreview) return;
  const {card, button, video} = activeTouchPreview;
  activeTouchPreview = null;
  touchPreviewObserver?.unobserve(card);
  video.onplaying = video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
  button.textContent = '▶ Preview';
  button.setAttribute('aria-pressed', 'false');
}
function toggleTouchPreview(card, button){
  if (activeTouchPreview?.card === card) return stopTouchPreview();
  stopTouchPreview();
  const video = document.createElement('video');
  video.className = 'card-hover-video';
  video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'none';
  video.setAttribute('playsinline', '');
  video.onplaying = () => video.classList.add('is-ready');
  video.onerror = () => { stopTouchPreview(); toast('Preview unavailable for this video.', 'warn'); };
  video.src = getVideo(Number(card.dataset.id))?.bunnyPreview || `/api/videos/${encodeURIComponent(card.dataset.id)}/file?preview=1`;
  card.querySelector('.thumb').appendChild(video);
  activeTouchPreview = {card, button, video};
  button.textContent = '■ Stop';
  button.setAttribute('aria-pressed', 'true');
  touchPreviewObserver?.observe(card);
  video.play().catch(() => { if (activeTouchPreview?.video === video) { stopTouchPreview(); toast('Preview unavailable for this video.', 'warn'); } });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTouchPreview(); });
window.addEventListener('pagehide', stopTouchPreview);

/* Load a real, muted preview only while a pointer is over a card. */
function hydrateThumbs(root = document){
  hydrateThumbImages(root);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || navigator.connection?.saveData || window.matchMedia('(hover: none)').matches) return root;
  $$('.card', root).forEach(card => {
    if (card.dataset.previewBound) return;
    card.dataset.previewBound = 'true';
    let timer;
    card.addEventListener('mouseenter', () => {
      timer = setTimeout(() => {
        if (!card.isConnected || card.querySelector('.card-hover-video')) return;
        const preview = document.createElement('video');
        preview.className = 'card-hover-video';
        preview.muted = true; preview.loop = true; preview.playsInline = true; preview.preload = 'none';
        preview.src = getVideo(Number(card.dataset.id))?.bunnyPreview || `/api/videos/${encodeURIComponent(card.dataset.id)}/file?preview=1`;
        preview.onplaying = () => preview.classList.add('is-ready');
        card.querySelector('.thumb').appendChild(preview);
        preview.play().catch(() => { preview.remove(); });
      }, 400);
    });
    card.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      const preview = card.querySelector('.card-hover-video');
      if (preview){ preview.pause(); preview.removeAttribute('src'); preview.load(); preview.remove(); }
    });
  });
  return root;
}

/* ============================================================
   SECTION 10 · ROUTER
   ============================================================ */
const views = {
  home: $('#view-home'), watch: $('#view-watch'),
  cats: $('#view-cats'), photos: $('#view-photos'), library: $('#view-library'),
  settings: $('#view-settings'), admin: $('#view-admin')
};
let watchRequestToken = 0;
function show(name){
  stopTouchPreview();
  if (name !== 'photos') ++photoRequestToken;
  if (name !== 'collections') ++videoCollectionRequestToken;
  if (name !== 'watch') ++watchRequestToken;
  if (name !== 'watch') disposePlayer();
  if (name !== 'home') $('#heroVideo')?.pause();
  Object.entries(views).forEach(([k, el]) => {
    el.hidden = k !== name;
    if (k === name){ el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  });
  window.scrollTo({top:0, behavior:'auto'});
  $$('.d-link').forEach(l => l.classList.remove('active'));
  closeDrawer();
  if (name === 'home' && !PREFS.reducedMotion && !heroMotionPausedByUser && !document.hidden && $('#heroVideo').currentSrc) $('#heroVideo').play().catch(() => {});
}
function setActive(key){
  $$('.d-link').forEach(l => { if (l.dataset.nav === key) l.classList.add('active'); });
}
let _hashSet = null;
function setHash(h, title){
  document.title = title ? title + ` — ${SITE_SETTINGS.siteName || 'AURA'}` : `${SITE_SETTINGS.siteName || 'AURA'} — Curated`;
  if (location.hash.slice(1) === h) return;
  if (!location.hash){ history.replaceState(null, '', '#' + h); return; }   // first load: no extra history entry
  _hashSet = h; location.hash = h;                                          // later: Back button works
}
function goHome(q='', f=null){ q=String(q||'').trim().slice(0,100); renderHome(q, f); show('home'); setActive(f==='Trending'?'trending':'home'); setHash(q ? 'search=' + encodeURIComponent(q) : ['Trending','New'].includes(f) ? 'sort=' + f.toLowerCase() : f ? 'cat=' + encodeURIComponent(f) : 'home'); }
async function goWatch(id){
  const numericId = Number(id), requestToken = ++watchRequestToken;
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return toast('Invalid video link.', 'warn');
  try { await refreshPublicVideos([numericId]); }
  catch(error){ if (requestToken === watchRequestToken) toast(error.message || 'Could not open this video.', 'error'); return; }
  if (requestToken !== watchRequestToken) return;
  const video = getVideo(numericId);
  if (!video){ toast('This video is no longer available.', 'warn'); return goHome(); }
  $('#video')?.pause();
  $('#miniVideo').pause(); $('#miniPlayer').hidden = true;
  renderWatch(numericId); show('watch'); setHash('watch=' + numericId, video.t);
}
function goCats(){ renderCategories(); show('cats'); setActive('cats'); setHash('categories'); }
let photoRequestToken = 0, activePhotoImages = null, activePhotoIndex = 0;
function photoCollectionCards(galleries){
  return galleries.map(item => `<a href="#photos=${item.id}" class="photo-collection" data-gallery="${item.id}"><img src="${esc(item.cover)}" alt="" loading="lazy"><span class="photo-collection-label"><strong>${esc(item.title)}</strong><small>${item.count} ${item.count===1?'photo':'photos'} · ${fmtViews(item.views)} views</small></span></a>`).join('');
}
async function goPhotos(id=null){
  const token = ++photoRequestToken;
  show('photos'); setActive('photos');
  setHash(id ? `photos=${id}` : 'photos', id ? 'Photos' : 'Photo collections');
  $('#photosGrid').innerHTML = '<p class="photo-empty">Loading photos…</p>';
  $('#photosBack').hidden = !id;
  $('#photosDescription').hidden = true;
  $('#photosContact').hidden = true;
  $('#photosTitle').innerHTML = 'Photos<span class="sub">Collections</span>';
  try {
    if (id) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('Invalid collection link.');
      const {gallery} = await api(`/api/galleries/${Number(id)}`);
      if (token !== photoRequestToken) return;
      $('#photosTitle').textContent = gallery.title;
      $('#photosDescription').textContent = gallery.description || '';
      $('#photosDescription').hidden = !gallery.description;
      if (SITE_SETTINGS.contactEmail) {
        $('#photosContact').href = `mailto:${encodeURIComponent(SITE_SETTINGS.contactEmail)}?subject=${encodeURIComponent(`Photo collection concern: ${gallery.title} (#${gallery.id})`)}`;
        $('#photosContact').hidden = false;
      }
      $('#photosGrid').innerHTML = `<p class="collection-views" id="photoCollectionViews">${fmtViews(gallery.views)} collection views</p><div class="photo-items">${gallery.images.map((item,i) => `<button class="photo-item" data-photo-index="${i}" type="button" aria-label="Open image ${i+1} of ${gallery.images.length}"><img src="${esc(item.src)}" alt="${esc(item.alt || `${gallery.title} photo ${i+1}`)}" loading="lazy"><small class="photo-item-views" data-photo-views="${item.id}">${fmtViews(item.views)} views</small></button>`).join('')}</div>`;
      $('#photosGrid').onclick = event => {
        const button = event.target.closest('[data-photo-index]');
        if (button) openPhoto(gallery, Number(button.dataset.photoIndex));
      };
      api(`/api/galleries/${gallery.id}/view`,{method:'POST',body:'{}'}).then(result => {
        if (token === photoRequestToken) $('#photoCollectionViews').textContent = `${fmtViews(result.views)} collection views`;
      }).catch(() => {});
    } else {
      const {galleries,pagination} = await api('/api/galleries?page=1');
      if (token !== photoRequestToken) return;
      $('#photosGrid').innerHTML = galleries.length ? `<div class="photo-collections" id="photoCollectionCards">${photoCollectionCards(galleries)}</div>${pagination.hasMore ? '<div class="load-more-wrap"><button id="photosLoadMore" class="btn soft sm" type="button">Load more</button></div>' : ''}` : '<p class="photo-empty">No photo collections published yet.</p>';
      let nextPage = 2;
      $('#photosGrid').onclick = async event => {
        const card = event.target.closest('[data-gallery]');
        if (card) { event.preventDefault(); goPhotos(Number(card.dataset.gallery)); }
        const button = event.target.closest('#photosLoadMore');
        if (button && !button.disabled) {
          button.disabled = true; button.textContent = 'Loading…';
          try {
            const result = await api(`/api/galleries?page=${nextPage}`);
            if (token !== photoRequestToken) return;
            $('#photoCollectionCards').insertAdjacentHTML('beforeend',photoCollectionCards(result.galleries));
            nextPage++;
            if (result.pagination.hasMore) { button.disabled = false; button.textContent = 'Load more'; }
            else button.remove();
          } catch(error){ if (token === photoRequestToken) { button.disabled = false; button.textContent = 'Try again'; toast(error.message,'error'); } }
        }
      };
    }
  } catch(error) {
    if (token === photoRequestToken) $('#photosGrid').innerHTML = `<p class="photo-empty">${esc(error.message || 'Could not load photos.')} <button type="button" class="btn soft sm" id="photosRetry">Try again</button></p>`;
    $('#photosRetry')?.addEventListener('click', () => goPhotos(id));
  }
}
let videoCollectionRequestToken = 0;
function videoCollectionCards(collections){
  return collections.map(item => `<a href="#collection=${item.id}" class="video-collection-card" data-collection="${item.id}"><span class="video-collection-art" data-thumb-id="${item.coverVideoId}" style="${artStyle(item.coverVideoId || 0)}"></span><span class="photo-collection-label"><strong>${esc(item.title)}</strong><small>${item.count} ${item.count===1?'video':'videos'} · ${fmtViews(item.views)} views</small></span></a>`).join('');
}
async function goCollections(id=null){
  const token = ++videoCollectionRequestToken;
  show('collections'); setActive('collections'); setHash(id ? `collection=${id}` : 'collections',id ? 'Video collection' : 'Video collections');
  $('#collectionsGrid').innerHTML = '<p class="photo-empty">Loading collections…</p>';
  $('#collectionsTitle').innerHTML = 'Video collections<span class="sub">Curated by the admin</span>';
  $('#collectionsBack').hidden = !id;
  $('#collectionsDescription').hidden = $('#collectionsViews').hidden = true;
  try {
    if (id) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('Invalid collection link.');
      const {collection} = await api(`/api/video-collections/${Number(id)}`);
      if (token !== videoCollectionRequestToken) return;
      cacheVideos(collection.videos);
      $('#collectionsTitle').textContent = collection.title;
      $('#collectionsDescription').textContent = collection.description || '';
      $('#collectionsDescription').hidden = !collection.description;
      $('#collectionsViews').hidden = false;
      $('#collectionsViews').textContent = `${fmtViews(collection.views)} collection views · ${collection.count} videos`;
      $('#collectionsGrid').innerHTML = `<div class="grid">${collection.videos.map((video,index) => cardHTML(video,index)).join('')}</div>`;
      hydrateThumbs($('#collectionsGrid'));
      api(`/api/video-collections/${collection.id}/view`,{method:'POST',body:'{}'}).then(result => {
        if (token === videoCollectionRequestToken) $('#collectionsViews').textContent = `${fmtViews(result.views)} collection views · ${collection.count} videos`;
      }).catch(() => {});
    } else {
      const {collections,pagination} = await api('/api/video-collections?page=1');
      if (token !== videoCollectionRequestToken) return;
      $('#collectionsGrid').innerHTML = collections.length ? `<div class="photo-collections" id="videoCollectionCards">${videoCollectionCards(collections)}</div>${pagination.hasMore ? '<div class="load-more-wrap"><button class="btn soft sm" id="collectionsLoadMore" type="button">Load more</button></div>' : ''}` : '<p class="photo-empty">No video collections published yet.</p>';
      hydrateThumbImages($('#collectionsGrid'));
      let nextPage = 2;
      $('#collectionsGrid').onclick = async event => {
        const card = event.target.closest('[data-collection]');
        if (card) { event.preventDefault(); goCollections(Number(card.dataset.collection)); return; }
        const button = event.target.closest('#collectionsLoadMore');
        if (!button || button.disabled) return;
        button.disabled = true; button.textContent = 'Loading…';
        try {
          const result = await api(`/api/video-collections?page=${nextPage}`);
          if (token !== videoCollectionRequestToken) return;
          $('#videoCollectionCards').insertAdjacentHTML('beforeend',videoCollectionCards(result.collections));
          hydrateThumbImages($('#videoCollectionCards'));
          nextPage++;
          if (result.pagination.hasMore) { button.disabled = false; button.textContent = 'Load more'; }
          else button.remove();
        } catch(error){ if (token === videoCollectionRequestToken) { button.disabled = false; button.textContent = 'Try again'; toast(error.message,'error'); } }
      };
    }
  } catch(error){
    if (token === videoCollectionRequestToken) $('#collectionsGrid').innerHTML = `<p class="photo-empty">${esc(error.message || 'Could not load collections.')} <button class="btn soft sm" id="collectionsRetry" type="button">Try again</button></p>`;
    $('#collectionsRetry')?.addEventListener('click',() => goCollections(id));
  }
}
$('#collectionsBack').onclick = () => goCollections();
let activePhotoGalleryId = null;
function openPhoto(gallery,index){
  activePhotoImages = gallery.images;
  activePhotoIndex = index;
  activePhotoGalleryId = gallery.status ? null : gallery.id;
  openModal({title:gallery.title, size:'photo-modal',body:'<div class="photo-lightbox"><button id="photoPrevious" class="photo-arrow" type="button" aria-label="Previous photo">‹</button><img id="photoLarge" alt=""><button id="photoNext" class="photo-arrow" type="button" aria-label="Next photo">›</button></div><p id="photoCount" class="photo-count" role="status"></p>',footer:'<button class="mbtn" data-close-modal>Close</button>'});
  const change = step => { activePhotoIndex = (activePhotoIndex + step + activePhotoImages.length) % activePhotoImages.length; updatePhoto(); };
  $('#photoPrevious').onclick = () => change(-1);
  $('#photoNext').onclick = () => change(1);
  let startX = null;
  $('#photoLarge').addEventListener('touchstart',event => { startX = event.touches[0]?.clientX ?? null; }, {passive:true});
  $('#photoLarge').addEventListener('touchend',event => {
    const end = event.changedTouches[0]?.clientX;
    if (startX !== null && end !== undefined && Math.abs(end - startX) > 55) change(end < startX ? 1 : -1);
    startX = null;
  }, {passive:true});
  updatePhoto();
}
function updatePhoto(){
  if (!activePhotoImages?.length) return;
  const item = activePhotoImages[activePhotoIndex], photo = $('#photoLarge');
  photo.alt = item.alt || `Photo ${activePhotoIndex+1}`;
  photo.onload = () => {
    if (!activePhotoGalleryId || activePhotoImages?.[activePhotoIndex]?.id !== item.id || !modalScrim.classList.contains('open')) return;
    api(`/api/galleries/${activePhotoGalleryId}/images/${item.id}/view`,{method:'POST',body:'{}'}).then(result => {
      if (!activePhotoImages?.some(image => image.id === item.id)) return;
      item.views = result.views;
      const tile = $(`[data-photo-views="${item.id}"]`);
      if (tile) tile.textContent = `${fmtViews(result.views)} views`;
      if (activePhotoImages[activePhotoIndex]?.id === item.id) $('#photoCount').textContent = `${activePhotoIndex+1} / ${activePhotoImages.length} · ${fmtViews(result.views)} views`;
    }).catch(() => {});
  };
  photo.src = item.src;
  $('#photoCount').textContent = `${activePhotoIndex+1} / ${activePhotoImages.length}${activePhotoGalleryId ? ` · ${fmtViews(item.views)} views` : ''}`;
  $('#photoPrevious').disabled = $('#photoNext').disabled = activePhotoImages.length < 2;
}
document.addEventListener('keydown',event => {
  if (!activePhotoImages || !modalScrim.classList.contains('open')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); activePhotoIndex = (activePhotoIndex + (event.key === 'ArrowRight' ? 1 : -1) + activePhotoImages.length) % activePhotoImages.length; updatePhoto();
  }
});
$('#photosBack').onclick = () => goPhotos();
function goLibrary(kind){ renderLibrary(kind); show('library'); setActive(kind); setHash(kind); }
function goSettings(){ syncSettingsUI(); show('settings'); setActive('settings'); setHash('settings'); }
function goAdmin(){
  if (RUNTIME.separateAdmin && !RUNTIME.isAdminHost) return goHome();
  renderAdminView(); show('admin'); setActive('admin'); setHash('admin');
}

function openDrawer(){ $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); document.body.classList.add('no-scroll'); }
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); document.body.classList.remove('no-scroll'); }

/* ============================================================
   SECTION 11 · HOME
   ============================================================ */
let activeFilter = 'All';
let heroPreviewId = '';
let heroMotionPausedByUser = false;

function updateHeroMotionControl(paused){
  const control = $('#heroMotionToggle');
  control.classList.toggle('is-paused', paused);
  control.setAttribute('aria-label', paused ? 'Play featured video background' : 'Pause featured video background');
  control.title = paused ? 'Play background video' : 'Pause background video';
}

function setHeroPreview(video){
  const player = $('#heroVideo');
  const control = $('#heroMotionToggle');
  const previewId = video?.hasFile ? String(video.id) : '';
  if (previewId === heroPreviewId) return;
  heroPreviewId = previewId;
  heroMotionPausedByUser = false;
  control.hidden = true;
  updateHeroMotionControl(false);
  player.onplaying = null;
  player.onpause = null;
  player.onerror = null;
  player.pause();
  player.classList.remove('is-ready');
  player.removeAttribute('src');
  player.load();
  const connection = navigator.connection;
  if (!previewId || PREFS.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches || connection?.saveData || ['slow-2g','2g'].includes(connection?.effectiveType)) return;

  player.src = video.bunnyPreview || `/api/videos/${encodeURIComponent(previewId)}/file?preview=1`;
  player.onplaying = () => { player.classList.add('is-ready'); control.hidden = false; updateHeroMotionControl(false); };
  player.onpause = () => updateHeroMotionControl(true);
  player.onerror = () => { player.classList.remove('is-ready'); control.hidden = true; };
  player.load();
  player.play().catch(() => {});
}

const heroPreviewObserver = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => {
  const player = $('#heroVideo');
  if (!entry.isIntersecting || document.hidden || PREFS.reducedMotion || !player.currentSrc || heroMotionPausedByUser) { player.pause(); return; }
  player.play().catch(() => {});
}, {threshold:.2}) : null;
if (heroPreviewObserver) heroPreviewObserver.observe($('.hero'));
document.addEventListener('visibilitychange', () => {
  const player = $('#heroVideo');
  if (document.hidden) player.pause();
  else if (!$('#view-home').hidden && !PREFS.reducedMotion && player.currentSrc && !heroMotionPausedByUser) player.play().catch(() => {});
});

function renderHome(query = '', filter = null){
  stopTouchPreview();
  query = String(query || '').trim().slice(0, 100);
  activeFilter = filter || 'All';
  homeRequestState = {query, filter:activeFilter};
  const requestToken = ++homeRequestToken;
  const search = $('#searchInput');
  if (search) search.value = query;
  const configuredFeatured = DATA.videos.find(v => v.status === 'live' && Number(v.id) === Number(SITE_SETTINGS.featuredVideoId)) || (Number(FEATURED_VIDEO?.id) === Number(SITE_SETTINGS.featuredVideoId) ? FEATURED_VIDEO : null);
  const featured = configuredFeatured || (String(FEATURED_VIDEO?.id) === String(SITE_SETTINGS.featuredVideoId) && FEATURED_VIDEO?.status === 'live' ? FEATURED_VIDEO : null);
  const hero = $('.hero');
  hero.hidden = !featured;
  setHeroPreview(featured);
  if (featured){
    $('#heroArt').style.cssText = artStyle(featured.seed);
    $('#heroArt').dataset.thumbId = featured.id;
    hydrateThumbImages(hero);
    $('#heroTitle').textContent = featured.t;
    $('#heroMeta').innerHTML = `<span>${esc(featured.s)}</span><span class="dot"></span><span class="mono">${featured.d}</span><span class="dot"></span><span>${fmtViews(featured.v)} views</span><span class="dot"></span><span>${esc(featured.age)}</span>`;
    $('#heroPlay').dataset.id = featured.id;
    $('#heroPlay').hidden = false;
  }

  applySiteBrand();
  const notice = $('#siteAnnouncement');
  notice.textContent = SITE_SETTINGS.announcement || '';
  notice.hidden = !SITE_SETTINGS.announcement;

  renderContinueRow().catch(error => console.warn('Could not load continue-watching videos:', error.message));

  const filters = ['All','Trending','New',...DATA.categories.map(c => c.n)];
  $('#filters').innerHTML = filters.map(f => `<button class="chip ${f===activeFilter?'active':''}" data-f="${esc(f)}">${esc(f)}</button>`).join('');

  const title = query ? `Results for “${query}”` : activeFilter === 'New' ? 'New releases' : activeFilter !== 'All' && activeFilter !== 'Trending' ? activeFilter : 'Trending now';
  $('#gridTitle').innerHTML = `${esc(title)}<span class="sub" id="gridSub"></span>`;
  const grid = $('#homeGrid');
  grid.innerHTML = '<div class="catalog-loading grid-empty">Loading videos…</div>';
  $('#loadMoreWrap').hidden = true;
  $('#loadMoreBtn').disabled = false;
  loadHomePage(1, false, requestToken);
}

async function loadHomePage(page, append, requestToken){
  if (requestToken !== homeRequestToken) return;
  const button = $('#loadMoreBtn');
  const buttonLabel = button.querySelector('span');
  if (append){ button.disabled = true; buttonLabel.textContent = 'Loading…'; }
  const {query, filter} = homeRequestState;
  const params = new URLSearchParams({page:String(page), sort:filter === 'New' ? 'new' : 'trending'});
  if (query) params.set('q', query);
  if (filter !== 'All' && filter !== 'Trending' && filter !== 'New') params.set('category', filter);
  try {
    const data = await api(`/api/catalog?${params.toString()}`);
    if (requestToken !== homeRequestToken) return;
    const videos = data.videos || [];
    const grid = $('#homeGrid');
    const existingIds = new Set(append ? [...grid.querySelectorAll('.card')].map(card => Number(card.dataset.id)) : []);
    const additions = videos.filter(video => !existingIds.has(Number(video.id)));
    cacheVideos(videos);
    const meta = data.pagination || {};
    homePage = Number(meta.page) || page;
    homeTotal = Number(meta.total) || 0;
    homeHasMore = Boolean(meta.hasMore);
    const sub = $('#gridSub');
    if (sub) sub.textContent = `${homeTotal.toLocaleString()} video${homeTotal === 1 ? '' : 's'}`;

    if (!homeTotal && !append){
      const isFiltered = Boolean(query) || (filter !== 'All' && filter !== 'Trending');
      grid.innerHTML = `<div class="empty grid-empty">
        <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg></div>
        <h3>${isFiltered ? 'No videos found' : 'New videos are on the way'}</h3>
        <p>${isFiltered ? 'Try another search or choose a different category.' : `${esc(SITE_SETTINGS.siteName || 'AURA')} videos will appear here after the administrator publishes them.`}</p>
        ${isFiltered ? '<button class="btn soft sm" id="resetCatalogFilters">Show all videos</button>' : ''}
      </div>`;
      $('#resetCatalogFilters')?.addEventListener('click', () => goHome());
    } else if (additions.length){
      const offset = append ? grid.querySelectorAll('.card').length : 0;
      const html = additions.map((video,index) => cardHTML(video, offset + index) + (!append && index === 5 ? adPlacementHTML('Home') : '')).join('');
      if (append) grid.insertAdjacentHTML('beforeend', html);
      else grid.innerHTML = html;
      hydrateThumbs(grid);
      hydrateAds(grid);
    } else if (!append){
      grid.innerHTML = '<div class="empty grid-empty"><h3>No videos found</h3><p>Try another search or choose a different category.</p></div>';
    }

    const shown = grid.querySelectorAll('.card').length;
    $('#loadMoreCount').textContent = `Showing ${shown.toLocaleString()} of ${homeTotal.toLocaleString()} videos`;
    $('#loadMoreWrap').hidden = !homeHasMore;
    button.disabled = false;
    buttonLabel.textContent = 'Load more';
  } catch(error){
    if (requestToken !== homeRequestToken) return;
    button.disabled = false;
    buttonLabel.textContent = 'Load more';
    if (append){ toast(error.message || 'Could not load more videos.', 'error'); return; }
    $('#homeGrid').innerHTML = `<div class="empty grid-empty"><h3>Videos could not load</h3><p>Please check your connection and try again.</p><button class="btn soft sm" id="retryCatalog">Try again</button></div>`;
    $('#retryCatalog').onclick = () => loadHomePage(1, false, requestToken);
  }
}

$('#loadMoreBtn').addEventListener('click', () => {
  if (homeHasMore && !$('#loadMoreBtn').disabled) loadHomePage(homePage + 1, true, homeRequestToken);
});

let continueRenderToken = 0;
async function renderContinueRow(){
  const requestToken = ++continueRenderToken;
  const row = $('#continueRow');
  if (!HISTORY.length || !PREFS.saveHistory || !PREFS.showContinue || totalCatalogVideos <= 1){ row.hidden = true; return; }
  const candidates = HISTORY.filter(h => Number(h.pos) > 0).slice(0,24);
  await ensureVideos(candidates.map(item => item.id));
  if (requestToken !== continueRenderToken || !PREFS.saveHistory || !PREFS.showContinue) return;
  const items = candidates.map(h => {
    const v = getVideo(h.id);
    if (!v) return null;
    const total = durToSec(v.d) || Number(h.total);
    const pos = resumablePosition(h, total);
    if (pos === null) return null;
    return cardHTML(v, 0, {progress: Math.min(100, Math.round((pos / total) * 100)), resumeAt: pos});
  }).filter(Boolean).slice(0,6);
  if (!items.length){ row.hidden = true; return; }
  $('#continueGrid').innerHTML = items.join('');
  hydrateThumbs($('#continueGrid'));
  row.hidden = false;
}
$('#continueHide').onclick = () => {
  PREFS.showContinue = false;
  savePrefs();
  $('#continueRow').hidden = true;
  ++continueRenderToken;
};

/* Chip clicks */
document.addEventListener('click', e => {
  const chip = e.target.closest('.chip[data-f]');
  if (chip){ goHome('', chip.dataset.f); }
});

/* ============================================================
   SECTION 12 · WATCH
   ============================================================ */
let currentVideoId = null;
let playerCleanup = null;
function disposePlayer(){
  if (playerCleanup) { const cleanup = playerCleanup; playerCleanup = null; cleanup(); }
}

async function renderWatch(id){
  const v = getVideo(id);
  if (!v) return;
  disposePlayer();
  currentVideoId = id;
  relatedVideoId = null;
  relatedVideos = null;
  const related = relatedFor(v);
  const hue = HUES[v.seed % HUES.length];

  const source = `/api/videos/${encodeURIComponent(v.id)}/file`;

  $('#watchMain').innerHTML = `
    <div class="player-shell" style="--glow:radial-gradient(60% 40% at 50% 50%, hsla(${hue},60%,60%,.16) 0%, transparent 70%)">
      <div class="player paused" id="player">
        <div class="player-top">
          <span class="player-badge"><i></i>Now playing</span>
          <span class="player-title">${esc(v.t)} · ${esc(SITE_SETTINGS.siteName || 'AURA')}</span>
        </div>
        <video id="video" src="${source}" preload="metadata" playsinline></video>
        <div class="seek-feedback" id="seekFeedback" role="status" aria-live="polite" aria-atomic="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7"/><path d="M4 4v4.7h4.7"/><path d="M12 8v4l2.8 1.7"/></svg><span id="seekFeedbackText">10 seconds</span></div>
        <div class="spinner"></div>
        <div class="player-error" id="playerError" role="alert" hidden><p>Video unavailable. Check your connection or try another browser.</p><button class="mbtn" id="retryVideo">Try again</button></div>
        <div class="center-play"><button id="centerPlay" aria-label="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div>
        <div class="kbd-hint" id="kbdHint"><kbd>Space</kbd> play / pause</div>
        <div class="controls" id="controls">
          <div class="timeline" id="timeline" role="slider" tabindex="0" aria-label="Video position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="tl-preview" id="tlPreview">0:00</div>
            <div class="tl-track"><div class="tl-buffer" id="tlBuffer"></div><div class="tl-fill" id="tlFill"></div></div>
            <div class="tl-knob" id="tlKnob"></div>
          </div>
          <div class="ctrl-row">
            <button class="ctl play-ctl" id="playBtn" aria-label="Play"><svg id="playIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
            <div class="volume-wrap">
              <button class="ctl" id="muteBtn" aria-label="Mute or unmute"><svg id="volIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15.5 9.5a3.5 3.5 0 010 5"/><path d="M18 7a7 7 0 010 10"/></svg></button>
              <div class="volume-slider"><input type="range" id="volumeRange" min="0" max="1" step="0.01" value="1" aria-label="Volume"></div>
            </div>
            <span class="time mono"><span id="curTime">0:00</span><span class="sep">/</span><span id="durTime">0:00</span></span>
            <div class="spacer"></div>
            <div class="menu-wrap" id="speedWrap">
              <button class="ctl text" id="speedBtn" aria-label="Playback speed">1x</button>
              <div class="menu" id="speedMenu">
                <div class="menu-title">Speed</div>
                ${[['0.5','0.5x'],['0.75','0.75x'],['1','Normal'],['1.25','1.25x'],['1.5','1.5x'],['2','2x']].map(([v,l]) => `<button data-speed="${v}" class="${v==='1'?'active':''}">${l} <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12l6 6L20 6"/></svg></button>`).join('')}
              </div>
            </div>
            <div class="mobile-extra" id="mobileExtra">
            <button class="ctl" id="skipBack" aria-label="Back 10s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 8L6 12l5 4V8zM18 8l-5 4 5 4V8z" fill="currentColor" stroke="none" opacity=".85"/><path d="M4 12a8 8 0 108-8" stroke-width="1.6"/><path d="M4 8v4h4" stroke-width="1.6"/></svg></button>
            <button class="ctl" id="skipFwd" aria-label="Forward 10s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8l5 4-5 4V8zM6 8l5 4 5 4V8z" fill="currentColor" stroke="none" opacity=".85"/><path d="M20 12a8 8 0 10-8-8" stroke-width="1.6"/><path d="M20 8v4h-4" stroke-width="1.6"/></svg></button>
            <button class="ctl" id="pipBtn" aria-label="Picture in picture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" opacity=".85"/></svg></button>
            <button class="ctl" id="miniBtn" aria-label="Mini player"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 12l3 3-3 3"/></svg></button>
            <button class="ctl" id="theaterBtn" aria-label="Theater"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="1.5"/><rect x="7" y="9" width="10" height="6" rx="1" fill="currentColor" stroke="none" opacity=".85"/></svg></button>
            </div>
            <button class="ctl mobile-more" id="moreControlsBtn" type="button" aria-label="More player controls" aria-controls="mobileExtra" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
            <button class="ctl" id="fsBtn" aria-label="Fullscreen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
          </div>
        </div>
      </div>
    </div>

    <section class="details">
      <h1 class="details-title">${esc(v.t)}</h1>
      <div class="details-meta">
        <span class="mono">${fmtViews(v.v)} views</span><span class="dot"></span>
        <span>${esc(v.age)}</span><span class="dot"></span>
        <span>${esc(v.c)}</span><span class="dot"></span>
        <span class="mono">${v.d}</span>
      </div>

      <div class="details-bar">
        <div class="uploader">
          <div class="avatar" style="${avatarStyle(v.seed)}">${esc(Array.from(SITE_SETTINGS.siteName || 'AURA')[0])}</div>
          <div class="u-info">
            <div class="u-name">${esc(SITE_SETTINGS.siteName || 'AURA')}</div>
          </div>
        </div>

        <div class="actions">
          <div class="action-group">
            <button class="action-btn ${FAVORITES.includes(v.id)?'on':''}" id="likeBtn">
              <svg viewBox="0 0 24 24" fill="${FAVORITES.includes(v.id)?'currentColor':'none'}" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-9.4A4.1 4.1 0 0112 8a4.1 4.1 0 017 2.6c0 5-7 9.4-7 9.4z"/></svg>
              <span>${FAVORITES.includes(v.id)?'Liked':'Like'}</span>
            </button>
          </div>
          <button class="icon-action ${WATCHLATER.includes(v.id)?'on':''}" id="laterBtn" aria-label="Watch later"><svg viewBox="0 0 24 24" fill="${WATCHLATER.includes(v.id)?'currentColor':'none'}" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v16l-6-4-6 4z"/></svg></button>
          <button class="icon-action" id="shareBtn" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v6a2 2 0 002 2h12a2 2 0 002-2v-6M12 15V4M8 8l4-4 4 4"/></svg></button>
          <button class="action-btn report-action" id="reportBtn" aria-label="Request video removal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4m0 1h13l-3 5 3 5H5"/></svg><span>Report</span></button>
        </div>
      </div>

      <div class="desc" id="desc">
        <div class="desc-body">
          <p>${esc(v.description || 'No description has been added for this video.')}</p>
          <div class="desc-tags"><span>${esc(v.c)}</span>${(v.tags || []).map(tag => `<button type="button" data-video-tag="${esc(tag)}" aria-label="Search videos tagged ${esc(tag)}">${esc(tag)}</button>`).join('')}</div>
        </div>
        <button class="desc-toggle" id="descToggle"><span id="descLabel">Show description</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      ${adPlacementHTML('Watch')}
    </section>

  `;

  if (v.bunny) {
    // Bunny's responsive player provides quality selection and native mobile controls.
    $('#player').innerHTML = '<iframe id="bunnyPlayer" title="Video player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><div class="bunny-gesture-zone back" id="bunnyTouchBack" aria-hidden="true"></div><div class="bunny-gesture-zone forward" id="bunnyTouchForward" aria-hidden="true"></div><div class="seek-feedback" id="seekFeedback" role="status" aria-live="polite" aria-atomic="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7"/><path d="M4 4v4.7h4.7"/><path d="M12 8v4l2.8 1.7"/></svg><span id="seekFeedbackText">10 seconds</span></div>';
    $('#player').classList.add('bunny-player');
  }

  $('#relatedList').innerHTML = related.map(sideCardHTML).join('');
  hydrateThumbs($('#relatedList'));
  hydrateAds($('#watchMain'));

  if (v.bunny) {
    try { await bindBunnyPlayer(v); }
    catch(error){
      if (currentVideoId===v.id && !views.watch.hidden) {
        $('#player').innerHTML = `<div class="bunny-player-error" role="alert">${esc(error.message||'Could not load video.')} <button class="mbtn" id="retryBunny">Try again</button></div>`;
        $('#retryBunny').onclick=()=>goWatch(v.id);
      }
    }
  } else bindPlayer(v);
  loadRelatedVideos(v, watchRequestToken);
}

function bindMobileDoubleTap(target, {getSide, onSingleTap, onDoubleTap}){
  let touchStart = null, pendingTap = null, suppressClickUntil = 0;
  const finishPending = run => {
    if (!pendingTap) return;
    clearTimeout(pendingTap.timer);
    const tap = pendingTap;
    pendingTap = null;
    if (run) onSingleTap(tap.side);
  };
  const onPointerDown = event => {
    if (event.pointerType !== 'touch' || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    if (event.target?.closest?.('button,input,select,textarea,a,.controls,.player-top,.player-error')) return;
    touchStart = {x:event.clientX, y:event.clientY, at:Date.now(), side:getSide(event)};
  };
  const onPointerMove = event => {
    if (!touchStart || event.pointerType !== 'touch') return;
    if (Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 22) touchStart = null;
  };
  const onPointerUp = event => {
    if (!touchStart || event.pointerType !== 'touch') return;
    const start = touchStart;
    touchStart = null;
    const elapsed = Date.now() - start.at;
    if (elapsed > 500 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 22) return;
    const side = start.side;
    const now = Date.now();
    suppressClickUntil = now + 800;
    if (pendingTap && pendingTap.side === side && now - pendingTap.at <= 300) {
      finishPending(false);
      onDoubleTap(side);
      return;
    }
    if (pendingTap) finishPending(true);
    const tap = {side, at:now, timer:null};
    tap.timer = setTimeout(() => {
      if (pendingTap !== tap) return;
      pendingTap = null;
      onSingleTap(side);
    }, 300);
    pendingTap = tap;
  };
  const onPointerCancel = () => { touchStart = null; };
  const onClickCapture = event => {
    if (Date.now() > suppressClickUntil || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  target.addEventListener('pointerdown', onPointerDown, {passive:true});
  target.addEventListener('pointermove', onPointerMove, {passive:true});
  target.addEventListener('pointerup', onPointerUp, {passive:true});
  target.addEventListener('pointercancel', onPointerCancel, {passive:true});
  target.addEventListener('click', onClickCapture, {capture:true});
  return () => {
    touchStart = null;
    finishPending(false);
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onPointerCancel);
    target.removeEventListener('click', onClickCapture, {capture:true});
  };
}

const playerFeedbackTimers = new WeakMap();
function clearPlayerSeekFeedback(player){
  if (playerFeedbackTimers.has(player)) clearTimeout(playerFeedbackTimers.get(player));
  playerFeedbackTimers.delete(player);
  player.querySelector('#seekFeedback')?.classList.remove('show','back','forward');
}
function showPlayerSeekFeedback(player, direction){
  const feedback = player.querySelector('#seekFeedback');
  if (!feedback) return;
  if (playerFeedbackTimers.has(player)) clearTimeout(playerFeedbackTimers.get(player));
  feedback.classList.remove('show','back','forward');
  void feedback.offsetWidth;
  feedback.classList.add(direction,'show');
  feedback.setAttribute('aria-label', direction === 'back' ? '10 seconds back' : '10 seconds forward');
  const text = feedback.querySelector('#seekFeedbackText');
  if (text) text.textContent = direction === 'back' ? '−10s' : '+10s';
  playerFeedbackTimers.set(player, setTimeout(() => {
    feedback.classList.remove('show');
    playerFeedbackTimers.delete(player);
  }, 750));
}

let bunnyPlayerScript = null;
function loadBunnyPlayerJS(){
  if (window.playerjs?.Player) return Promise.resolve();
  if (!bunnyPlayerScript) bunnyPlayerScript = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let timeout = null, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        bunnyPlayerScript = null;
        reject(error);
      } else resolve();
    };
    script.src = 'https://assets.mediadelivery.net/playerjs/playerjs-latest.min.js';
    script.onload = () => finish(window.playerjs?.Player ? null : new Error('Bunny player controls did not initialize.'));
    script.onerror = () => finish(new Error('Bunny player controls could not load.'));
    timeout = setTimeout(() => finish(new Error('Bunny player controls timed out. Check your connection and retry.')), 15000);
    document.head.appendChild(script);
  });
  return bunnyPlayerScript;
}
async function bindBunnyPlayer(v){
  const frame = $('#bunnyPlayer');
  const {url} = await api(`/api/videos/${v.id}/embed`);
  if (!frame?.isConnected || currentVideoId !== v.id || views.watch.hidden) return;
  frame.src = url;
  let instance, lastTime = 0, duration = v.duration || durToSec(v.d), recorded = false;
  let readyTimer = null, ready = false, isPlaying = false;
  const touchCleanups = [];
  const save = () => { if (PREFS.saveHistory && lastTime >= 3) addToHistory(v.id, lastTime, duration); };
  const showError = message => {
    if (!frame.isConnected || currentVideoId !== v.id || views.watch.hidden) return;
    const existing = $('#bunnyPlaybackError');
    if (existing) existing.remove();
    const error = document.createElement('div');
    error.className = 'player-error';
    error.id = 'bunnyPlaybackError';
    error.setAttribute('role','alert');
    error.innerHTML = `<p>${esc(message || 'Video could not be played. Check your connection and try again.')}</p><button class="mbtn" id="retryBunny">Try again</button>`;
    $('#player').append(error);
    $('#retryBunny').onclick = () => goWatch(v.id);
  };
  const toggleBunnyPlayback = () => {
    if (!ready || !instance) return;
    if (isPlaying) instance.pause();
    else instance.play();
  };
  const seekBunny = direction => {
    if (!ready || !instance || typeof instance.getCurrentTime !== 'function') return;
    instance.getCurrentTime(value => {
      const current = Number(value);
      if (!Number.isFinite(current)) return;
      const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
      const next = Math.max(0, Math.min(max, current + direction * 10));
      try {
        instance.setCurrentTime(next);
        lastTime = next;
        showPlayerSeekFeedback($('#player'), direction < 0 ? 'back' : 'forward');
        save();
      } catch (error) { console.warn('Could not seek Bunny video:', error); }
    });
  };
  const leftZone = $('#bunnyTouchBack'), rightZone = $('#bunnyTouchForward');
  if (leftZone) touchCleanups.push(bindMobileDoubleTap(leftZone, {getSide:()=>'back', onSingleTap:toggleBunnyPlayback, onDoubleTap:()=>seekBunny(-1)}));
  if (rightZone) touchCleanups.push(bindMobileDoubleTap(rightZone, {getSide:()=>'forward', onSingleTap:toggleBunnyPlayback, onDoubleTap:()=>seekBunny(1)}));
  playerCleanup = () => {
    clearTimeout(readyTimer);
    touchCleanups.forEach(cleanup => cleanup());
    clearPlayerSeekFeedback($('#player'));
    save();
    instance?.off();
    frame.removeAttribute('src');
  };
  $('#likeBtn').onclick = function(){
    const on = toggleFavorite(v.id); this.classList.toggle('on',on);
    this.querySelector('svg').setAttribute('fill',on?'currentColor':'none');
    this.querySelector('span').textContent=on?'Liked':'Like';
  };
  $('#laterBtn').onclick = function(){ const on=toggleWatchLater(v.id); this.classList.toggle('on',on); };
  $('#shareBtn').onclick = () => copyVideoLink(v.id,v.t,true);
  $('#reportBtn').onclick = () => openRemovalRequest(v);
  $('#descToggle').onclick = () => {const d=$('#desc');d.classList.toggle('open');$('#descLabel').textContent=d.classList.contains('open')?'Hide description':'Show description';};
  await loadBunnyPlayerJS();
  if (!frame.isConnected || currentVideoId !== v.id || views.watch.hidden) return;
  instance = new window.playerjs.Player(frame);
  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = error => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      readyTimer = null;
      error ? reject(error) : resolve();
    };
    readyTimer = setTimeout(() => settle(new Error('Bunny player did not become ready. Check the embed domain and network, then retry.')), 25000);
    instance.on('ready', () => {
      ready = true;
      instance.getDuration(value => { const total=Number(value); if (Number.isFinite(total) && total > 0) duration=total; });
      const previous = HISTORY.find(item => item.id === v.id);
      const position = previous && PREFS.saveHistory ? resumablePosition(previous,duration) : null;
      if (position !== null) instance.setCurrentTime(position);
      settle();
    });
    instance.on('play', () => {
      isPlaying = true;
      if (!recorded) { recorded=true; api(`/api/videos/${v.id}/view`,{method:'POST',body:'{}'}).catch(()=>{}); }
    });
    instance.on('pause', () => { isPlaying = false; save(); });
    instance.on('timeupdate', data => {
      const seconds = Number(data?.seconds), total = Number(data?.duration);
      if (!Number.isFinite(seconds)) return;
      const previousSecond=Math.floor(lastTime);
      lastTime=seconds; duration=Number.isFinite(total) && total > 0 ? total : duration;
      if (Math.floor(lastTime)>=5 && Math.floor(lastTime/10)!==Math.floor(previousSecond/10)) save();
    });
    const onPlaybackError = data => {
      const message = typeof data === 'string' ? data : data?.message;
      if (!ready) settle(new Error(message || 'Bunny could not load this video.'));
      else showError(message);
    };
    instance.on('error', onPlaybackError);
    instance.on('loaderror', onPlaybackError);
    instance.on('ended', () => {
      isPlaying = false;
      lastTime=duration; save();
      if(PREFS.autoplay){const next=relatedFor(v)[0]; if(next) setTimeout(()=>{if(currentVideoId===v.id&&!views.watch.hidden)goWatch(next.id);},800);}
    });
  });
}

/* ============================================================
   SECTION 13 · PLAYER BINDINGS
   ============================================================ */
function bindPlayer(v){
  const video = $('#video'), player = $('#player'), layout = $('#watchLayout');
  if (!video || !player) return;
  const controller = new AbortController();
  const listen = (target, type, callback, options={}) => target.addEventListener(type, callback, {...options, signal:controller.signal});
  let nextTimer = null, gestureCleanup = null;
  playerCleanup = () => {
    if (video.currentTime > 3) addToHistory(v.id, video.currentTime, video.duration || durToSec(v.d));
    gestureCleanup?.();
    clearPlayerSeekFeedback(player);
    controller.abort();
    clearTimeout(nextTimer); clearTimeout(idleTimer); clearTimeout(hintTimer);
    video.pause(); video.removeAttribute('src'); video.load();
  };

  const PLAY = `<path d="M8 5v14l11-7z"/>`, PAUSE = `<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>`;
  const VOL = {
    hi:`<path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15.5 9.5a3.5 3.5 0 010 5"/><path d="M18 7a7 7 0 010 10"/>`,
    lo:`<path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15.5 9.5a3.5 3.5 0 010 5"/>`,
    mu:`<path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>`
  };

  let idleTimer = null;
  const controls = $('#controls');
  const showControls = () => { player.classList.remove('idle'); clearTimeout(idleTimer); if (!video.paused && !controls.classList.contains('expanded')) idleTimer = setTimeout(() => player.classList.add('idle'), 2600); };
  $('#moreControlsBtn').onclick = () => {
    const expanded = controls.classList.toggle('expanded');
    $('#moreControlsBtn').setAttribute('aria-expanded', String(expanded));
    showControls();
  };

  // Resume from history
  const h = HISTORY.find(x => x.id === v.id);
  if (h && PREFS.saveHistory){
    const resume = () => { const pos = resumablePosition(h, video.duration); if (pos !== null) video.currentTime = pos; };
    if (video.readyState >= 1) resume();
    else listen(video, 'loadedmetadata', resume, {once:true});
  }

  const setPlayButtonState = playing => {
    $('#playBtn')?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#centerPlay')?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  const togglePlay = () => { if (video.paused || video.ended) video.play().catch(()=>{}); else video.pause(); };
  $('#playBtn').onclick = togglePlay;
  $('#centerPlay').onclick = togglePlay;
  listen(video, 'click', togglePlay);

  listen(video, 'play', () => { player.classList.remove('paused'); $('#playIcon').innerHTML = PAUSE; setPlayButtonState(true); showControls(); });
  let viewRecorded = false;
  listen(video, 'playing', () => {
    if (!viewRecorded){
      viewRecorded = true;
      api(`/api/videos/${v.id}/view`, {method:'POST', body:'{}'}).catch(error => console.warn('Could not record play:', error));
    }
  });
  listen(video, 'error', () => { player.classList.remove('buffering'); $('#playerError').hidden = false; });
  $('#retryVideo').onclick = () => { $('#playerError').hidden = true; video.load(); video.play().catch(()=>{}); };
  listen(video, 'pause', () => {
    player.classList.add('paused'); player.classList.remove('idle'); clearTimeout(idleTimer);
    $('#playIcon').innerHTML = PLAY;
    setPlayButtonState(false);
    if (PREFS.saveHistory && video.currentTime > 3) addToHistory(v.id, video.currentTime, video.duration || durToSec(v.d));
  });
  listen(video, 'waiting', () => player.classList.add('buffering'));
  listen(video, 'playing', () => player.classList.remove('buffering'));
  listen(video, 'canplay', () => player.classList.remove('buffering'));
  let savedSecond = -1;
  listen(video, 'timeupdate', () => {
    const second = Math.floor(video.currentTime);
    if (second >= 5 && (savedSecond < 0 || Math.abs(second - savedSecond) >= 10)){
      savedSecond = second;
      addToHistory(v.id, video.currentTime, video.duration || durToSec(v.d));
    }
  });
  listen(video, 'ended', () => {
    addToHistory(v.id, video.duration, video.duration || durToSec(v.d));
    if (PREFS.autoplay){
      const nx = relatedFor(v)[0];
      if (nx){ toast(`Playing next: ${nx.t}`, 'success'); nextTimer = setTimeout(() => {
        if (!controller.signal.aborted && !views.watch.hidden && PREFS.autoplay) goWatch(nx.id);
      }, 800); }
    }
  });

  listen(player, 'mousemove', showControls);
  listen(player, 'mouseleave', () => { if (!video.paused) player.classList.add('idle'); });
  listen(player, 'touchstart', showControls, {passive:true});

  const seekBy = seconds => {
    const current = Number(video.currentTime), end = Number(video.duration);
    if (video.readyState < 1 || !Number.isFinite(current)) return;
    try {
      video.currentTime = Math.max(0, Math.min(Number.isFinite(end) && end >= 0 ? end : Infinity, current + seconds));
      showPlayerSeekFeedback(player, seconds < 0 ? 'back' : 'forward');
      showControls();
    } catch (error) { console.warn('Could not seek video:', error); }
  };
  $('#skipBack').onclick = () => seekBy(-10);
  $('#skipFwd').onclick = () => seekBy(10);
  gestureCleanup = bindMobileDoubleTap(player, {
    getSide:event => event.clientX < player.getBoundingClientRect().left + player.getBoundingClientRect().width / 2 ? 'back' : 'forward',
    onSingleTap:togglePlay,
    onDoubleTap:side => seekBy(side === 'back' ? -10 : 10)
  });

  /* Timeline */
  const timeline = $('#timeline'), tlFill = $('#tlFill'), tlBuffer = $('#tlBuffer'), tlKnob = $('#tlKnob'), tlPreview = $('#tlPreview');
  let dragging = false;
  function paint(){
    const d = video.duration || 0, p = d ? (video.currentTime / d) * 100 : 0;
    tlFill.style.width = p + '%';
    tlKnob.style.left = p + '%';
    $('#curTime').textContent = fmtTime(video.currentTime);
    timeline.setAttribute('aria-valuenow', String(Math.round(p)));
    timeline.setAttribute('aria-valuetext', `${fmtTime(video.currentTime)} of ${fmtTime(d)}`);
  }
  listen(video, 'timeupdate', paint);
  listen(video, 'loadedmetadata', () => { $('#durTime').textContent = fmtTime(video.duration); paint(); });
  listen(video, 'progress', () => { if (video.buffered.length && video.duration){ tlBuffer.style.width = (video.buffered.end(video.buffered.length-1) / video.duration) * 100 + '%'; } });
  const seekFromEvent = e => { const r = timeline.getBoundingClientRect(); const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - r.left; const ratio = Math.max(0, Math.min(1, x / r.width)); if (video.duration) video.currentTime = ratio * video.duration; paint(); };
  listen(timeline, 'mousemove', e => { const r = timeline.getBoundingClientRect(); const x = e.clientX - r.left; const ratio = Math.max(0, Math.min(1, x / r.width)); tlPreview.textContent = fmtTime(ratio * (video.duration || 0)); tlPreview.style.left = (ratio * 100) + '%'; });
  listen(timeline, 'mousedown', e => { dragging = true; timeline.classList.add('dragging'); seekFromEvent(e); });
  listen(window, 'mousemove', e => { if (dragging) seekFromEvent(e); });
  listen(window, 'mouseup', () => { dragging = false; timeline.classList.remove('dragging'); });
  listen(timeline, 'keydown', e => {
    if (!Number.isFinite(video.duration)) return;
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    video.currentTime = e.key === 'Home' ? 0 : e.key === 'End' ? video.duration : Math.max(0, Math.min(video.duration, video.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
    paint(); showControls();
  });
  listen(timeline, 'touchstart', e => { dragging = true; timeline.classList.add('dragging'); seekFromEvent(e); }, {passive:true});
  listen(timeline, 'touchmove', e => { if (dragging) seekFromEvent(e); }, {passive:true});
  listen(timeline, 'touchend', () => { dragging = false; timeline.classList.remove('dragging'); });
  listen(timeline, 'touchcancel', () => { dragging = false; timeline.classList.remove('dragging'); });

  /* Volume */
  const vr = $('#volumeRange'), vi = $('#volIcon');
  let lastVol = 1;
  function updVI(){ const vol = video.muted ? 0 : video.volume; vi.innerHTML = vol === 0 ? VOL.mu : vol < 0.5 ? VOL.lo : VOL.hi; }
  listen(vr, 'input', () => { video.volume = parseFloat(vr.value); video.muted = video.volume === 0; updVI(); });
  $('#muteBtn').onclick = () => { if (video.muted || video.volume === 0){ video.muted = false; video.volume = lastVol || 1; vr.value = video.volume; } else { lastVol = video.volume; video.muted = true; } updVI(); };
  listen(video, 'volumechange', () => { vr.value = video.muted ? 0 : video.volume; updVI(); });
  updVI();

  /* Menus */
  function setupMenu(wId, mId, cb){
    const w = $(wId), m = $(mId);
    listen(w.querySelector('button'), 'click', e => { e.stopPropagation(); $$('.menu-wrap').forEach(x => { if (x !== w) x.classList.remove('open'); }); w.classList.toggle('open'); });
    listen(m, 'click', e => { const it = e.target.closest('button'); if (!it) return; m.querySelectorAll('button').forEach(b => b.classList.remove('active')); it.classList.add('active'); cb(it); w.classList.remove('open'); });
  }
  setupMenu('#speedWrap', '#speedMenu', it => { video.playbackRate = parseFloat(it.dataset.speed); $('#speedBtn').textContent = (it.dataset.speed === '1' ? '1' : it.dataset.speed) + 'x'; });
  listen(document, 'click', e => { if (!e.target.closest('.menu-wrap')) $$('.menu-wrap').forEach(w => w.classList.remove('open')); });

  /* Theater */
  $('#theaterBtn').onclick = () => { const on = layout.classList.toggle('theater'); $('#theaterBtn').classList.toggle('active', on); setTimeout(() => window.dispatchEvent(new Event('resize')), 520); };

  /* PiP */
  $('#pipBtn').onclick = async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch(e){ toast('PiP not supported.', 'warn'); } };

  /* Mini player */
  $('#miniBtn').onclick = () => {
    const mini = $('#miniPlayer'), mv = $('#miniVideo');
    const playing = !video.paused, position = video.currentTime;
    mv.pause(); miniVideoId = v.id; miniSavedSecond = -1; mv.src = `${video.currentSrc || video.src}${(video.currentSrc || video.src).includes('?') ? '&' : '?'}preview=1`;
    mv.muted = video.muted; mv.volume = video.volume; mv.playbackRate = video.playbackRate;
    mv.onloadedmetadata = () => { mv.currentTime = Math.min(position, mv.duration || position); if (playing) mv.play().catch(()=>{}); };
    mini.hidden = false;
    video.pause();
    goHome();
  };

  /* Fullscreen */
  $('#fsBtn').onclick = async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else document.webkitExitFullscreen?.();
      } else if (player.requestFullscreen) await player.requestFullscreen();
      else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else toast('Fullscreen is unavailable in this browser.', 'warn');
    } catch { toast('Fullscreen could not be opened.', 'warn'); }
  };
  const syncFullscreenState = () => {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen || video.webkitDisplayingFullscreen);
    $('#fsBtn')?.classList.toggle('active', active);
    $('#fsBtn')?.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
  };
  listen(document, 'fullscreenchange', syncFullscreenState);
  listen(document, 'webkitfullscreenchange', syncFullscreenState);
  listen(video, 'webkitbeginfullscreen', syncFullscreenState);
  listen(video, 'webkitendfullscreen', syncFullscreenState);

  /* Keyboard */
  const kbdHint = $('#kbdHint');
  let hintTimer = null;
  function flash(t){ kbdHint.innerHTML = t; kbdHint.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(() => kbdHint.classList.remove('show'), 1400); }
  if (window._keyHandler) document.removeEventListener('keydown', window._keyHandler);
  window._keyHandler = e => {
    if (['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(e.target.tagName) || e.target.isContentEditable || modalScrim.classList.contains('open')) return;
    if (views.watch.hidden) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k'){ e.preventDefault(); togglePlay(); flash('<kbd>Space</kbd> play / pause'); }
    else if (k === 'arrowright'){ e.preventDefault(); video.currentTime = Math.min(video.duration||0, video.currentTime+5); flash('<kbd>→</kbd> +5s'); }
    else if (k === 'arrowleft'){ e.preventDefault(); video.currentTime = Math.max(0, video.currentTime-5); flash('<kbd>←</kbd> −5s'); }
    else if (k === 'arrowup'){ e.preventDefault(); video.volume = Math.min(1, video.volume+0.05); video.muted = false; flash(`<kbd>↑</kbd> ${Math.round(video.volume*100)}%`); }
    else if (k === 'arrowdown'){ e.preventDefault(); video.volume = Math.max(0, video.volume-0.05); flash(`<kbd>↓</kbd> ${Math.round(video.volume*100)}%`); }
    else if (k === 'm'){ $('#muteBtn').click(); flash('<kbd>M</kbd> mute'); }
    else if (k === 'f'){ $('#fsBtn').click(); flash('<kbd>F</kbd> fullscreen'); }
    else if (k === 't'){ $('#theaterBtn').click(); flash('<kbd>T</kbd> theater'); }
  };
  listen(document, 'keydown', window._keyHandler);

  /* Details */
  $('#likeBtn').onclick = function(){
    const on = toggleFavorite(v.id);
    this.classList.toggle('on', on);
    this.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
    this.querySelector('span').textContent = on ? 'Liked' : 'Like';
    toast(on ? 'Added to Liked' : 'Removed', 'success');
  };
  $('#laterBtn').onclick = function(){
    const on = toggleWatchLater(v.id);
    this.classList.toggle('on', on);
    this.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
    toast(on ? 'Saved to Watch later' : 'Removed', 'success');
  };
  $('#shareBtn').onclick = () => copyVideoLink(v.id, v.t, true);
  $('#reportBtn').onclick = () => openRemovalRequest(v);
  $('#descToggle').onclick = () => { const d = $('#desc'); d.classList.toggle('open'); $('#descLabel').textContent = d.classList.contains('open') ? 'Hide description' : 'Show description'; };

}

/* ============================================================
   SECTION 14 · CATEGORIES / LIBRARY
   ============================================================ */
function renderCategories(){
  const grid = $('#catGrid');
  if (!DATA.categories.length){ grid.innerHTML = `<div class="empty grid-empty"><h3>No categories</h3></div>`; return; }
  grid.innerHTML = DATA.categories.map(c => `
    <a class="cat-card" data-cat="${esc(c.n)}" href="#">
      <div class="cat-art" style="${artStyle(c.seed)}">${c.image ? `<img class="cat-image" src="${esc(c.image)}" alt="" loading="lazy">` : ''}</div>
      <div class="cat-scrim"></div>
      <div class="cat-info"><h3>${esc(c.n)}</h3><span>${c.c.toLocaleString()} videos</span></div>
    </a>`).join('');
  $$('.cat-image', grid).forEach(img => img.addEventListener('error', () => img.remove(), {once:true}));
}

const LIB_META = {
  history:{title:'Watch history',sub:'Recently watched'},
  favorites:{title:'Liked videos',sub:'Videos you liked'},
  watchlater:{title:'Watch later',sub:'Saved for later'}
};
let libraryRenderToken = 0;

async function renderLibrary(kind){
  stopTouchPreview();
  const requestToken = ++libraryRenderToken;
  const m = LIB_META[kind] || {title:'Library', sub:''};
  $('#libTitle').innerHTML = `${m.title}<span class="sub">${m.sub}</span>`;
  const clearBtn = $('#libClearBtn');
  clearBtn.hidden = !['history','favorites','watchlater'].includes(kind);

  let ids = [];
  if (kind === 'history') ids = HISTORY.map(h => h.id);
  else if (kind === 'favorites') ids = FAVORITES.slice();
  else if (kind === 'watchlater') ids = WATCHLATER.slice();

  if (['history','favorites','watchlater'].includes(kind)) {
    $('#libGrid').innerHTML = '<div class="catalog-loading grid-empty">Loading your library…</div>';
    try { await refreshPublicVideos(ids); }
    catch(error){ toast(error.message || 'Could not load your library.', 'error'); }
  }
  if (requestToken !== libraryRenderToken) return;

  const list = ids.map(getVideo).filter(Boolean);
  const grid = $('#libGrid');
  if (!list.length){
    const msg = {history:'Videos you watch will appear here.',favorites:'Videos you like will appear here.',watchlater:'Videos you save will appear here.'}[kind] || '';
    grid.innerHTML = `<div class="empty grid-empty">
      <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/></svg></div>
      <h3>Nothing here yet</h3><p>${msg}</p>
      <button class="btn accent" id="browseLibraryVideos">Browse videos</button>
    </div>`;
  } else {
    grid.innerHTML = list.map((v,i) => cardHTML(v, i)).join('');
    hydrateThumbs(grid);
  }
  $('#browseLibraryVideos')?.addEventListener('click', () => goHome());
}

$('#libClearBtn').onclick = () => {
  const nav = $$('.d-link.active')[0]?.dataset.nav;
  if (!nav) return;
  confirmAction('Clear all items from this list?', () => {
    if (nav === 'history'){ HISTORY = []; writeJSON(KEYS.HIST, []); renderContinueRow().catch(error => console.warn(error)); }
    if (nav === 'favorites'){ FAVORITES = []; writeJSON(KEYS.FAV, []); }
    if (nav === 'watchlater'){ WATCHLATER = []; writeJSON(KEYS.LATER, []); }
    goLibrary(nav);
    toast('Cleared.', 'success');
  }, 'Clear');
};

/* ============================================================
   SECTION 15 · ADMIN VIEW
   ============================================================ */
let adminTab = 'videos';
let adminQuery = '', adminStatus = 'all', adminPage = 1;
let adminStats = {videos:0,published:0,drafts:0,views:0,galleryViews:0,photoViews:0,videoCollectionViews:0,storageBytes:0,openReports:0};
let reportsStatus = 'all', reportsPage = 1;

async function refreshAdminData(){
  const data = await api('/api/admin/overview');
  DATA.videos = data.videos || [];
  DATA.categories = data.categories || [];
  SITE_SETTINGS = data.settings || SITE_SETTINGS;
  FEATURED_VIDEO = DATA.videos.find(video => video.status === 'live' && String(video.id) === String(SITE_SETTINGS.featuredVideoId)) || null;
  adminStats = data.stats || adminStats;
  return data;
}

async function renderAdminView(){
  const wrap = $('#adminLayout');
  if (!isAdmin()){
    wrap.innerHTML = renderAdminLock();
    bindAdminLock();
    return;
  }
  try { await refreshAdminData(); }
  catch(error){
    if (error.status === 401){
      adminAuthenticated = false; document.body.classList.remove('is-admin');
      $$('.admin-only').forEach(el => el.style.display = 'none');
      wrap.innerHTML = renderAdminLock(); bindAdminLock(); return;
    }
    wrap.innerHTML = '<div class="admin-lock"><h2>Admin panel could not load</h2><p>Check the connection and try again.</p><button class="btn accent" id="adminRetry">Try again</button></div>';
    $('#adminRetry').onclick = renderAdminView;
    return;
  }
  wrap.innerHTML = `
    <div class="sec-head" style="margin-top:14px">
      <h2>Admin panel<span class="sub">Manage ${esc(SITE_SETTINGS.siteName || 'AURA')} content</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn accent sm" id="adminUploadBtn">＋ Upload video</button>
        <button class="btn soft sm" id="adminExport">Export catalog</button>
        <button class="btn soft sm" id="adminLogout">Sign out</button>
      </div>
    </div>
    <div class="admin-kpis">
      <div class="admin-kpi"><div class="value">${adminStats.videos}</div><div class="label">All videos</div></div>
      <div class="admin-kpi"><div class="value">${adminStats.published}</div><div class="label">Published</div></div>
      <div class="admin-kpi"><div class="value">${fmtViews(adminStats.views)}</div><div class="label">Video views</div></div>
      <div class="admin-kpi"><div class="value">${fmtViews(adminStats.videoCollectionViews || 0)}</div><div class="label">Video collection views</div></div>
      <div class="admin-kpi"><div class="value">${fmtViews(adminStats.galleryViews || 0)}</div><div class="label">Photo collection views</div></div>
      <div class="admin-kpi"><div class="value">${fmtViews(adminStats.photoViews || 0)}</div><div class="label">Individual photo views</div></div>
      <div class="admin-kpi"><div class="value">${fmtBytes(adminStats.storageBytes || 0)}</div><div class="label">Video storage</div></div>
      <div class="admin-kpi"><div class="value">${adminStats.openReports || 0}</div><div class="label">Open removal requests</div></div>
    </div>
    <div class="admin-tabs" id="adminTabs">
      <button class="${adminTab==='videos'?'active':''}" data-tab="videos">Videos</button>
      <button class="${adminTab==='categories'?'active':''}" data-tab="categories">Categories</button>
      <button class="${adminTab==='galleries'?'active':''}" data-tab="galleries">Photo collections</button>
      <button class="${adminTab==='videoCollections'?'active':''}" data-tab="videoCollections">Video collections</button>
      <button class="${adminTab==='settings'?'active':''}" data-tab="settings">Site settings</button>
      <button class="${adminTab==='ads'?'active':''}" data-tab="ads">Ads</button>
      <button class="${adminTab==='storage'?'active':''}" data-tab="storage">Storage</button>
      <button class="${adminTab==='reports'?'active':''}" data-tab="reports">Removal requests${adminStats.openReports ? ` · ${adminStats.openReports}` : ''}</button>
    </div>
    <div class="admin-panel" id="adminPanel"></div>`;
  $('#adminUploadBtn').onclick = () => openUploadModal();
  $('#adminExport').onclick = exportAdminData;
  $('#adminLogout').onclick = () => confirmAction('Sign out of admin?', logoutAdmin, 'Sign out');
  $('#adminTabs').addEventListener('click', e => {
    const button = e.target.closest('button[data-tab]');
    if (!button) return;
    adminTab = button.dataset.tab;
    renderAdminView();
  });
  renderAdminPanel();
}

function renderAdminLock(){
  return `<div class="admin-lock">
    <div class="icon">🔒</div><h2>Admin access</h2>
    <p>Sign in to upload videos and manage the site.</p>
    <div class="field"><label>Admin email</label><input id="admUser" type="email" autocomplete="username" required></div>
    <div class="field"><label>Password</label><input id="admPass" type="password" autocomplete="current-password" required></div>
    <button class="btn accent" id="admSignIn" style="width:100%;height:42px;justify-content:center">Sign in</button>
    <p class="lock-error" id="lockError">Check your email and password.</p>
    <p class="lock-hint">Admin credentials are set in the server environment.</p>
  </div>`;
}

function bindAdminLock(){
  const submit = async () => {
    const button = $('#admSignIn');
    button.disabled = true;
    if (await loginAdmin($('#admUser').value.trim(), $('#admPass').value)){
      toast('Welcome back.', 'success');
      renderAdminView();
    } else {
      const error = $('#lockError');
      error.classList.add('show');
      setTimeout(() => error.classList.remove('show'), 2600);
      button.disabled = false;
    }
  };
  $('#admSignIn').onclick = submit;
  $('#admPass').addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
}

function renderAdminPanel(){
  const panel = $('#adminPanel');
  if (!panel) return;
  if (adminTab === 'videos') renderAdminVideos(panel);
  else if (adminTab === 'categories') renderAdminCats(panel);
  else if (adminTab === 'galleries') renderAdminGalleries(panel);
  else if (adminTab === 'videoCollections') renderAdminVideoCollections(panel);
  else if (adminTab === 'storage') renderAdminStorage(panel);
  else if (adminTab === 'reports') renderAdminReports(panel);
  else if (adminTab === 'ads') renderAdminAds(panel);
  else renderAdminSettings(panel);
}

async function renderAdminReports(panel){
  panel.innerHTML = `<div class="admin-panel-head"><h3>Removal requests</h3><div class="admin-filters">
    <select id="reportStatusFilter" aria-label="Request status">${[['all','All requests'],['new','New'],['reviewing','Reviewing'],['resolved','Resolved'],['declined','Declined']].map(([value,label]) => `<option value="${value}" ${reportsStatus===value?'selected':''}>${label}</option>`).join('')}</select>
    <button class="btn soft sm" id="reportsRefresh">Refresh</button></div></div>
    <div id="reportsList" role="status" class="storage-result">Loading requests…</div>
    <div class="admin-page-nav" id="reportsNavigation"></div>`;
  $('#reportStatusFilter').onchange = event => { reportsStatus = event.target.value; reportsPage = 1; renderAdminReports(panel); };
  $('#reportsRefresh').onclick = () => renderAdminReports(panel);
  const list = $('#reportsList'), navigation = $('#reportsNavigation');
  try {
    const data = await api(`/api/admin/reports?status=${encodeURIComponent(reportsStatus)}&page=${reportsPage}`);
    if (!list.isConnected || $('#adminPanel') !== panel || adminTab !== 'reports') return;
    list.innerHTML = data.reports.length ? data.reports.map(report => {
      const video = DATA.videos.find(item => item.id === report.video_id);
      const label = {copyright:'Copyright / ownership',privacy:'Privacy / consent',safety:'Safety concern',other:'Other concern'}[report.reason] || 'Concern';
      return `<article class="request-card" data-report-id="${report.id}">
        <div class="request-card-head"><strong>${esc(report.video_title)}</strong><span class="chip-status ${esc(report.status)}">${esc(report.status)}</span></div>
        <p class="request-meta">AUR-${report.id} · Video #${report.original_video_id} · ${esc(label)} · ${esc(new Date(report.created_at).toLocaleString())}</p>
        <p class="request-copy">${esc(report.details)}</p>
        <p class="request-meta">From ${esc(report.reporter_name)} · <a href="mailto:${encodeURIComponent(report.reporter_email)}">${esc(report.reporter_email)}</a>${report.video_status ? ` · Video: ${esc(report.video_status)}` : ' · Video deleted'}</p>
        ${report.admin_note ? `<p class="request-note">Private note: ${esc(report.admin_note)}</p>` : ''}
        <div class="request-actions">
          ${video?.hasFile ? '<button class="mbtn" data-request-action="preview">Preview</button>' : ''}
          ${report.status !== 'reviewing' ? '<button class="mbtn" data-request-action="reviewing">Reviewing</button>' : ''}
          ${report.video_status === 'live' ? '<button class="mbtn danger" data-request-action="unpublish">Unpublish video</button>' : ''}
          <button class="mbtn" data-request-action="resolved">Resolve</button>
          <button class="mbtn" data-request-action="declined">Decline</button>
        </div>
      </article>`;
    }).join('') : '<p class="request-empty">No removal requests in this view.</p>';
    navigation.innerHTML = `<button class="btn soft sm" id="reportsPrev" ${reportsPage===1?'disabled':''}>Previous</button><span>${data.pagination.total} requests · Page ${reportsPage}</span><button class="btn soft sm" id="reportsNext" ${data.pagination.hasMore?'':'disabled'}>Next</button>`;
    $('#reportsPrev').onclick = () => { reportsPage--; renderAdminReports(panel); };
    $('#reportsNext').onclick = () => { reportsPage++; renderAdminReports(panel); };
    list.onclick = event => {
      const button = event.target.closest('[data-request-action]'), card = event.target.closest('[data-report-id]');
      if (!button || !card) return;
      const report = data.reports.find(item => item.id === Number(card.dataset.reportId));
      if (!report) return;
      const action = button.dataset.requestAction;
      if (action === 'preview') {
        const video = DATA.videos.find(item => item.id === report.video_id);
        if (video) openAdminPreview(video);
        return;
      }
      openReportReview(report, action);
    };
  } catch(error) { if (list.isConnected) list.textContent = error.message || 'Could not load requests.'; }
}

function openReportReview(report, action){
  const unpublish = action === 'unpublish';
  const title = unpublish ? 'Unpublish video and resolve request' : `Mark request ${action}`;
  openModal({title,body:`<p class="request-hint">AUR-${report.id} · ${esc(report.video_title)}. ${unpublish ? 'Public access to this video will stop immediately; the file remains available for private admin review.' : 'Add a private note about your decision.'}</p>
    <div class="field"><label for="reportAdminNote">Private review note${action==='reviewing'?' (optional)':''}</label><textarea id="reportAdminNote" maxlength="2000" rows="4">${esc(report.admin_note)}</textarea></div>
    <p class="request-hint">This note stays in the admin panel. To reply to the requester, use their contact email in the request.</p>`,
    footer:`<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn ${unpublish?'danger':'primary'}" id="reportReviewSave">${unpublish?'Unpublish and resolve':'Save decision'}</button>`});
  $('#reportReviewSave').onclick = async () => {
    const button = $('#reportReviewSave'), note = $('#reportAdminNote').value.trim();
    if (action !== 'reviewing' && note.length < 5) return toast('Add a short private review note first.', 'warn');
    button.disabled = true;
    try {
      const endpoint = `/api/admin/reports/${report.id}${unpublish?'/unpublish':''}`;
      await api(endpoint,{method:unpublish?'POST':'PATCH',body:JSON.stringify(unpublish?{note}:{status:action,note})});
      closeModal();
      await renderAdminView();
      toast(unpublish ? 'Video unpublished; request resolved.' : 'Request updated.','success');
    } catch(error) { button.disabled = false; toast(error.message || 'Could not update request.','error'); }
  };
}

async function renderAdminStorage(panel){
  panel.innerHTML = '<div class="admin-panel-head"><h3>Storage health</h3><button class="btn soft sm" id="checkStorage">Check again</button></div><div class="storage-result" id="storageResult" role="status">Checking uploaded files…</div>';
  $('#checkStorage').onclick = () => renderAdminStorage(panel);
  const result = $('#storageResult');
  try {
    const data = await api('/api/admin/storage-check');
    if (!result.isConnected) return;
    result.innerHTML = `<p>${data.missing.length ? `${data.missing.length} local video file(s) are missing. Replace these files in Videos:` : 'All referenced local video files are present.'}</p>
      <p>${data.bunnyVideos || 0} video(s) on Bunny Stream · ${data.pendingBunnyUploads || 0} upload(s) to resume. Remote files are checked when you publish; this disk check does not inspect Bunny storage.</p>
      ${data.missing.length ? `<ul>${data.missing.map(item => `<li>#${item.id} · ${esc(item.title)}</li>`).join('')}</ul>` : ''}
      <p>${data.missingCategoryImages.length ? `${data.missingCategoryImages.length} category image(s) are missing. Replace these images in Categories:` : 'All referenced category images are present.'}</p>
      ${data.missingCategoryImages.length ? `<ul>${data.missingCategoryImages.map(item => `<li>#${item.id} · ${esc(item.name)}</li>`).join('')}</ul>` : ''}
      <p>${data.missingGalleryImages?.length ? `${data.missingGalleryImages.length} collection photo(s) are missing. Review these collections:` : 'All referenced collection photos are present.'}</p>
      ${data.missingGalleryImages?.length ? `<ul>${data.missingGalleryImages.map(item => `<li>Photo #${item.id} · ${esc(item.title)}</li>`).join('')}</ul>` : ''}
      <p>${data.availableBytes === null ? 'Free disk space unavailable.' : `${fmtBytes(data.availableBytes)} available on the video disk.`}</p>
      <p>${data.unreferencedFiles} unreferenced video file(s) · ${data.unreferencedCategoryImages} unreferenced category image(s) · ${data.unreferencedGalleryImages || 0} unreferenced collection photo(s) · ${data.activeUploads + data.activeCategoryOperations + (data.activeGalleryOperations || 0)} active operation(s). Check again after uploads finish before reviewing unreferenced files.</p>
      <h4>Backup &amp; recovery</h4><p>Catalog export contains metadata only. Run <code>npm run backup</code> to save the database, site images and local videos. Bunny video bytes stay with Bunny and need their own recovery plan. Keep a copy of the backup on a separate disk.</p>`;
  } catch(error){ if (result.isConnected) result.textContent = error.message || 'Storage check failed. Try again.'; }
}

function renderAdminVideos(panel){
  panel.innerHTML = `<div class="admin-panel-head"><h3>Videos <span class="count">${DATA.videos.length}</span></h3>
    <div class="admin-filters"><div class="admin-search"><input id="adminVideoSearch" value="${esc(adminQuery)}" placeholder="Title or category…" aria-label="Search videos"></div>
    <select id="adminStatusFilter" aria-label="Video status">${[['all','All statuses'],['live','Published'],['draft','Drafts'],['private','Private'],['missing','No uploaded file']].map(([value,label]) => `<option value="${value}" ${adminStatus===value?'selected':''}>${label}</option>`).join('')}</select></div></div>
    <table class="admin-video-table"><thead><tr><th>Video</th><th class="hide-sm">Category</th><th class="hide-sm">Views</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody id="adminVideoTable"></tbody></table><div class="admin-page-nav" id="adminPageNav"></div>`;
  const paint = () => {
    const query = adminQuery.toLowerCase();
    const filtered = DATA.videos.filter(video => (!query || `${video.t} ${video.c} ${(video.tags || []).join(' ')}`.toLowerCase().includes(query)) && (adminStatus === 'all' || (adminStatus === 'missing' ? !video.hasFile : video.status === adminStatus)));
    const pages = Math.max(1, Math.ceil(filtered.length / 24));
    adminPage = Math.max(1, Math.min(adminPage, pages));
    const list = filtered.slice((adminPage-1)*24, adminPage*24);
    $('#adminVideoTable').innerHTML = list.length ? list.map(video => `<tr data-id="${video.id}">
      <td><div class="row-thumb"><div class="t" ${video.hasFile ? `data-thumb-id="${video.id}" data-thumb-admin="true"` : ''} style="${artStyle(video.seed)}"></div><div class="info"><div class="title">${esc(video.t)}</div><div class="sub">${esc(SITE_SETTINGS.siteName || 'AURA')} · ${esc(video.d)}${video.hasFile?'':' · no file uploaded'}</div></div></div></td>
      <td class="hide-sm">${esc(video.c)}</td><td class="hide-sm mono">${fmtViews(video.v)}</td>
      <td><span class="chip-status ${video.status}"><i></i>${video.status}</span></td>
      <td><div class="row-actions"><button class="row-act" data-act="preview" title="Preview video" aria-label="Preview video" ${video.hasFile?'':'disabled'}>▶</button>
      <button class="row-act" data-act="replace" title="${video.hasFile?'Replace file':'Add file'}" aria-label="${video.hasFile?'Replace file':'Add file'}">↥</button>
      <button class="row-act" data-act="edit" title="Edit details" aria-label="Edit details">✎</button>
      ${video.bunny && video.status!=='live' ? '<button class="row-act" data-act="encoding" title="Check Bunny encoding" aria-label="Check Bunny encoding">◷</button>' : ''}
      <button class="row-act" data-act="publish" title="${video.status==='live'?'Unpublish':'Publish'}">${video.status==='live'?'↓':'↑'}</button>
      <button class="row-act danger" data-act="delete" title="Delete">×</button></div></td>
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;padding:44px 16px;color:var(--faint)">${DATA.videos.length ? 'No videos match these filters.' : 'No videos yet. Upload a video to get started.'}</td></tr>`;
    $('#adminPageNav').innerHTML = `<button class="btn soft sm" id="adminPrevious" ${adminPage===1?'disabled':''}>Previous</button><span>${filtered.length} videos · ${adminPage} / ${pages}</span><button class="btn soft sm" id="adminNext" ${adminPage===pages?'disabled':''}>Next</button>`;
    $('#adminPrevious').onclick = () => { adminPage--; paint(); };
    $('#adminNext').onclick = () => { adminPage++; paint(); };
    hydrateThumbImages(panel);
  };
  paint();
  $('#adminVideoSearch').addEventListener('input', event => { adminQuery = event.target.value; adminPage = 1; paint(); });
  $('#adminStatusFilter').addEventListener('change', event => { adminStatus = event.target.value; adminPage = 1; paint(); });
  $('#adminVideoTable').addEventListener('click', async event => {
    const row = event.target.closest('tr[data-id]'), action = event.target.closest('[data-act]')?.dataset.act;
    if (!row || !action) return;
    const id = Number(row.dataset.id), video = DATA.videos.find(item => Number(item.id) === id);
    if (!video) return;
    if (action === 'preview') return openAdminPreview(video);
    if (action === 'replace') return openUploadModal(video);
    if (action === 'edit') return openVideoEditModal(id);
    if (action === 'encoding'){
      try{const state=await api(`/api/admin/videos/${id}/bunny-upload/status`);toast(state.ready?'Bunny encoding is complete. You can publish this video.':state.status===5?'Bunny encoding failed. Replace the file or review it in Bunny.':'Bunny is still encoding this video.',state.ready?'success':'warn');}
      catch(error){toast(error.message,'error');}
      return;
    }
    if (action === 'publish'){
      try { await api(`/api/admin/videos/${id}/publish`, {method:'PATCH',body:JSON.stringify({published:video.status!=='live'})}); await renderAdminView(); toast(video.status==='live'?'Video unpublished.':'Video published.','success'); }
      catch(error){ toast(error.message,'error'); }
    }
    if (action === 'delete') confirmAction(`Delete “${video.t}” and its uploaded file?`, async () => {
      try { await api(`/api/admin/videos/${id}`, {method:'DELETE'}); await renderAdminView(); toast('Video deleted.','success'); }
      catch(error){ toast(error.message,'error'); }
    }, 'Delete');
  });
}

function openAdminPreview(video){
  if (!video.hasFile) return toast('Upload a video file first.', 'warn');
  openModal({title:`Preview · ${video.t}`, size:'wide', body:`
    ${video.bunny ? '<iframe id="adminBunnyPreview" class="admin-preview-video" title="Private video preview" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>' : `<video id="adminPreview" class="admin-preview-video" controls playsinline preload="metadata" src="/api/admin/videos/${video.id}/file"></video>`}
    <p class="admin-preview-note">Only you can see this preview until the video is published.</p>`,
    footer:'<button class="mbtn primary" data-close-modal>Close preview</button>'});
  if (video.bunny) api(`/api/admin/videos/${video.id}/embed`).then(({url}) => {const frame=$('#adminBunnyPreview');if(frame)frame.src=url;}).catch(error=>toast(error.message,'error'));
  else $('#adminPreview').onerror = () => toast('Could not play this file. Check its codec and upload a browser-compatible MP4 or WebM.', 'error');
}

function openVideoEditModal(id){
  const video = DATA.videos.find(item => Number(item.id) === Number(id));
  if (!video) return;
  const categories = DATA.categories.map(category => `<option value="${esc(category.n)}" ${category.n===video.c?'selected':''}>${esc(category.n)}</option>`).join('');
  openModal({title:'Edit video', body:`
    <div class="field"><label>Title</label><input id="evT" maxlength="160" value="${esc(video.t)}"></div>
    <div class="field"><label>Description</label><textarea id="evDesc" maxlength="5000">${esc(video.description||'')}</textarea></div>
    <div class="field"><label>Category</label><select id="evC">${categories}</select></div>
    <div class="field"><label for="evTags">Tags</label><input id="evTags" maxlength="300" value="${esc((video.tags || []).join(', '))}" placeholder="e.g. cinematic, outdoor"><p class="hint">Up to 8 tags, separated by commas. Related videos and search use these tags.</p></div>`,
    footer:'<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn primary" id="evSave">Save</button>'});
  $('#evSave').onclick = async () => {
    try {
      await api(`/api/admin/videos/${id}`, {method:'PATCH',body:JSON.stringify({title:$('#evT').value,description:$('#evDesc').value,category:$('#evC').value,quality:video.quality,duration:video.duration,tags:parseTagInput($('#evTags').value)})});
      closeModal(); await renderAdminView(); toast('Video details saved.','success');
    } catch(error){ toast(error.message,'error'); }
  };
}

let categoryPreviewURL = null;
const MAX_CATEGORY_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_CATEGORY_SOURCE_BYTES = 20 * 1024 * 1024;
function categoryImageMime(file){
  const type = file.type.toLowerCase();
  if (['image/jpeg','image/png','image/webp'].includes(type)) return type;
  if (type === 'image/jpg') return 'image/jpeg';
  if (type) return '';
  const extension = file.name.toLowerCase().split('.').pop();
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'})[extension] || '';
}
async function optimizeCategoryImage(image){
  const canvas = document.createElement('canvas');
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!maxSide || image.naturalWidth * image.naturalHeight > 50_000_000) throw new Error('Choose an image smaller than 50 megapixels.');
  for (const side of [1600,1200,900,640]) {
    const scale = Math.min(1, side / maxSide);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot resize the image.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
    if (blob?.type === 'image/webp' && blob.size && blob.size <= MAX_CATEGORY_IMAGE_BYTES) return blob;
    if (blob?.type !== 'image/webp') {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
      if (jpeg?.type === 'image/jpeg' && jpeg.size && jpeg.size <= MAX_CATEGORY_IMAGE_BYTES) return jpeg;
    }
  }
  throw new Error('Could not reduce this image below 3 MB. Choose a smaller image.');
}
let selectedVideoCollectionId = null;
async function renderAdminVideoCollections(panel){
  panel.innerHTML = '<div class="admin-panel-head"><h3>Video collections</h3><button class="btn accent sm" id="videoCollectionCreate" type="button">＋ New collection</button></div><div class="storage-result" id="videoCollectionAdminBody" role="status">Loading collections…</div>';
  $('#videoCollectionCreate').onclick = () => editVideoCollectionModal();
  try {
    const {collections} = await api('/api/admin/video-collections');
    if (!panel.isConnected || adminTab !== 'videoCollections') return;
    const selected = collections.find(item => item.id === selectedVideoCollectionId);
    const unused = DATA.videos.filter(video => video.hasFile && !selected?.videos.some(item => item.id === video.id));
    const list = collections.length ? collections.map(item => `<button class="gallery-admin-pick ${selected?.id===item.id?'active':''}" data-video-collection-pick="${item.id}" type="button"><span class="gallery-admin-placeholder video-collection-mini" ${item.coverVideoId ? `data-thumb-id="${item.coverVideoId}" data-thumb-admin="true"` : ''} style="${artStyle(item.coverVideoId || 0)}">${item.coverVideoId?'':'▶'}</span><span><strong>${esc(item.title)}</strong><small>${item.count} videos · ${fmtViews(item.views)} views · ${item.status==='live'?'Published':'Draft'}</small></span></button>`).join('') : '<p>No collections yet. Create one to organize your uploaded videos.</p>';
    $('#videoCollectionAdminBody').innerHTML = `<div class="gallery-admin-list">${list}</div>${selected ? `<div class="gallery-admin-detail"><div class="admin-panel-head"><div><h3>${esc(selected.title)}</h3><p class="photo-description">${esc(selected.description || 'No description')} · ${fmtViews(selected.views)} collection views</p>${selected.status==='live' && !selected.availableCount ? '<p class="collection-warning">This collection is hidden until it contains a published video.</p>' : ''}</div><div class="gallery-admin-actions"><button class="btn soft sm" id="videoCollectionEdit" type="button">Edit</button><button class="btn ${selected.status==='live'?'soft':'accent'} sm" id="videoCollectionPublish" type="button">${selected.status==='live'?'Unpublish':'Publish'}</button><button class="btn soft sm" id="videoCollectionDelete" type="button">Delete</button></div></div>
      <div class="collection-admin-add"><label for="videoCollectionPicker">Add an uploaded video</label><select id="videoCollectionPicker" ${unused.length && selected.count<100?'':'disabled'}>${unused.length ? unused.map(video => `<option value="${video.id}">${esc(video.t)} · ${video.status}</option>`).join('') : '<option>No more uploaded videos available</option>'}</select><button class="btn accent sm" id="videoCollectionAdd" type="button" ${unused.length && selected.count<100?'':'disabled'}>Add video</button></div><p class="photo-description">Arrange the videos with the arrow buttons. Draft or private videos are visible only to you; publishing needs at least one published video. Maximum 100 videos.</p>
      <div class="collection-admin-items">${selected.videos.length ? selected.videos.map((video,index) => `<div class="collection-admin-item" data-video-id="${video.id}"><span class="collection-admin-thumb" data-thumb-id="${video.id}" data-thumb-admin="true" style="${artStyle(video.seed)}"></span><span class="collection-admin-copy"><strong>${esc(video.t)}</strong><small>${video.status==='live'?'Published':'Unavailable to visitors'} · ${fmtViews(video.v)} video views</small></span><div class="gallery-admin-actions"><button class="btn soft sm" data-collection-preview="${video.id}" type="button">Preview</button><button class="btn soft sm" data-collection-move="-1" type="button" aria-label="Move ${esc(video.t)} up" ${index===0?'disabled':''}>↑</button><button class="btn soft sm" data-collection-move="1" type="button" aria-label="Move ${esc(video.t)} down" ${index===selected.videos.length-1?'disabled':''}>↓</button><button class="btn soft sm" data-collection-remove="${video.id}" type="button">Remove</button></div></div>`).join('') : '<p class="photo-empty">Add uploaded videos to build this collection.</p>'}</div></div>` : ''}`;
    hydrateThumbImages(panel);
    $$('#videoCollectionAdminBody [data-video-collection-pick]').forEach(button => button.onclick = () => { selectedVideoCollectionId = Number(button.dataset.videoCollectionPick); renderAdminVideoCollections(panel); });
    if (!selected) return;
    const saveOrder = async ids => {
      try { await api(`/api/admin/video-collections/${selected.id}/videos`,{method:'PUT',body:JSON.stringify({videoIds:ids})}); await renderAdminVideoCollections(panel); }
      catch(error){ toast(error.message,'error'); }
    };
    $('#videoCollectionEdit').onclick = () => editVideoCollectionModal(selected);
    $('#videoCollectionAdd').onclick = () => saveOrder([...selected.videos.map(video => video.id),Number($('#videoCollectionPicker').value)]);
    $('#videoCollectionPublish').onclick = async () => {
      try { await api(`/api/admin/video-collections/${selected.id}/publish`,{method:'PATCH',body:JSON.stringify({published:selected.status!=='live'})}); await renderAdminVideoCollections(panel); toast(selected.status==='live'?'Collection unpublished.':'Collection published.','success'); }
      catch(error){ toast(error.message,'error'); }
    };
    $('#videoCollectionDelete').onclick = () => confirmAction(`Delete “${selected.title}”? The videos remain on the site.`,async () => {
      try { await api(`/api/admin/video-collections/${selected.id}`,{method:'DELETE'}); selectedVideoCollectionId=null; await renderAdminVideoCollections(panel); toast('Collection deleted.','success'); }
      catch(error){ toast(error.message,'error'); }
    },'Delete');
    $$('#videoCollectionAdminBody [data-collection-preview]').forEach(button => button.onclick = () => {
      const video = selected.videos.find(item => item.id === Number(button.dataset.collectionPreview));
      if (video) openAdminPreview(video);
    });
    $$('#videoCollectionAdminBody [data-collection-remove]').forEach(button => button.onclick = () => {
      saveOrder(selected.videos.map(video => video.id).filter(id => id !== Number(button.dataset.collectionRemove)));
    });
    $$('#videoCollectionAdminBody [data-collection-move]').forEach(button => button.onclick = () => {
      const ids = selected.videos.map(video => video.id), id = Number(button.closest('[data-video-id]').dataset.videoId), index = ids.indexOf(id), target = index + Number(button.dataset.collectionMove);
      if (index < 0 || target < 0 || target >= ids.length) return;
      [ids[index],ids[target]] = [ids[target],ids[index]];
      saveOrder(ids);
    });
  } catch(error){ if ($('#videoCollectionAdminBody')?.isConnected) $('#videoCollectionAdminBody').textContent = error.message || 'Could not load collections.'; }
}
function editVideoCollectionModal(collection=null){
  openModal({title:collection?'Edit video collection':'New video collection',body:`<div class="field"><label for="videoCollectionTitle">Title</label><input id="videoCollectionTitle" maxlength="120" value="${esc(collection?.title || '')}" required></div><div class="field"><label for="videoCollectionDescription">Description (optional)</label><textarea id="videoCollectionDescription" maxlength="1000">${esc(collection?.description || '')}</textarea></div>`,footer:'<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn primary" id="videoCollectionSave">Save collection</button>'});
  $('#videoCollectionSave').onclick = async () => {
    const button = $('#videoCollectionSave'); button.disabled = true;
    try {
      const result = await api(collection ? `/api/admin/video-collections/${collection.id}` : '/api/admin/video-collections',{method:collection?'PATCH':'POST',body:JSON.stringify({title:$('#videoCollectionTitle').value,description:$('#videoCollectionDescription').value})});
      selectedVideoCollectionId = result.collection.id;
      closeModal(); if (adminTab === 'videoCollections') await renderAdminVideoCollections($('#adminPanel')); toast('Video collection saved.','success');
    } catch(error){ button.disabled = false; toast(error.message,'error'); }
  };
}
let gallerySelectedId = null, galleryUploadBusy = false;
async function renderAdminGalleries(panel){
  panel.innerHTML = '<div class="admin-panel-head"><h3>Photo collections</h3><button class="btn accent sm" id="galleryCreate" type="button">＋ New collection</button></div><div class="storage-result" id="galleryAdminBody" role="status">Loading collections…</div>';
  $('#galleryCreate').onclick = () => editGalleryModal();
  try {
    const {galleries} = await api('/api/admin/galleries');
    if (!panel.isConnected || adminTab !== 'galleries' || galleryUploadBusy) return;
    const selected = galleries.find(gallery => gallery.id === gallerySelectedId);
    $('#galleryAdminBody').innerHTML = `<div class="gallery-admin-list">${galleries.length ? galleries.map(gallery => `<button class="gallery-admin-pick ${selected?.id===gallery.id?'active':''}" data-gallery-pick="${gallery.id}" type="button">${gallery.cover ? `<img src="${esc(gallery.cover)}" alt="">` : '<span class="gallery-admin-placeholder">＋</span>'}<span><strong>${esc(gallery.title)}</strong><small>${gallery.count} photos · ${fmtViews(gallery.views)} views · ${gallery.status==='live'?'Published':'Draft'}</small></span></button>`).join('') : '<p>No collections yet. Create one, add images, then publish it.</p>'}</div>
      ${selected ? `<div class="gallery-admin-detail"><div class="admin-panel-head"><div><h3>${esc(selected.title)}</h3><p class="photo-description">${esc(selected.description || 'No description')} · ${fmtViews(selected.views)} collection views</p></div><div class="gallery-admin-actions"><button class="btn soft sm" id="galleryEdit" type="button">Edit</button><button class="btn ${selected.status==='live'?'soft':'accent'} sm" id="galleryPublish" type="button">${selected.status==='live'?'Unpublish':'Publish'}</button><button class="btn soft sm" id="galleryDelete" type="button">Delete</button></div></div>
      <div class="field"><label for="galleryImageInput">Add photos (JPG, PNG or WebP)</label><input type="file" id="galleryImageInput" accept="image/jpeg,image/png,image/webp" multiple><div class="hint">Choose up to 20 at a time. Each source must be under 20 MB; large photos are resized before upload. Maximum 100 images per collection.</div></div><button class="btn accent sm" id="galleryUpload" type="button">Upload selected photos</button><p class="photo-description" id="galleryUploadStatus" role="status"></p>
      <div class="gallery-admin-images">${selected.images.map((image,i) => `<div class="gallery-admin-image"><button class="gallery-admin-preview" data-gallery-preview="${i}" type="button" aria-label="Preview photo ${i+1}"><img src="${esc(image.src)}" alt="${esc(image.alt || `Photo ${i+1}`)}" loading="lazy"></button><small class="collection-admin-views">${fmtViews(image.views)} views</small><button class="btn soft sm" data-gallery-remove="${image.id}" type="button" aria-label="Remove photo ${i+1}">Remove</button></div>`).join('')}</div></div>` : ''}`;
    $$('#galleryAdminBody [data-gallery-pick]').forEach(button => button.onclick = () => { gallerySelectedId = Number(button.dataset.galleryPick); renderAdminGalleries(panel); });
    if (!selected) return;
    $('#galleryEdit').onclick = () => editGalleryModal(selected);
    $('#galleryPublish').onclick = async () => {
      try {
        await api(`/api/admin/galleries/${selected.id}/publish`, {method:'PATCH',body:JSON.stringify({published:selected.status!=='live'})});
        await renderAdminGalleries(panel);
        toast(selected.status==='live'?'Collection unpublished.':'Collection published.','success');
      } catch(error) { toast(error.message,'error'); }
    };
    $('#galleryDelete').onclick = () => confirmAction(`Delete “${selected.title}” and all its images?`, async () => {
      try { await api(`/api/admin/galleries/${selected.id}`, {method:'DELETE'}); gallerySelectedId = null; await renderAdminGalleries(panel); toast('Collection deleted.','success'); }
      catch(error){ toast(error.message,'error'); }
    }, 'Delete');
    $$('#galleryAdminBody [data-gallery-preview]').forEach(button => button.onclick = () => openPhoto(selected, Number(button.dataset.galleryPreview)));
    $$('#galleryAdminBody [data-gallery-remove]').forEach(button => button.onclick = () => confirmAction('Remove this photo from the collection?', async () => {
      try { await api(`/api/admin/galleries/${selected.id}/images/${button.dataset.galleryRemove}`,{method:'DELETE'}); await renderAdminGalleries(panel); toast('Photo removed.','success'); }
      catch(error){ toast(error.message,'error'); }
    }, 'Remove'));
    $('#galleryUpload').onclick = async () => {
      const files = [...$('#galleryImageInput').files];
      if (!files.length) return toast('Select photos first.','warn');
      if (files.length > 20 || files.length + selected.count > 100) return toast('Choose up to 20 at a time and 100 per collection.','warn');
      const button = $('#galleryUpload'), input = $('#galleryImageInput'), status = $('#galleryUploadStatus');
      button.disabled = input.disabled = true;
      galleryUploadBusy = true;
      let uploaded = 0, failure = null;
      for (const file of files) {
        try {
          const mime = categoryImageMime(file);
          if (!mime || !file.size || file.size > MAX_CATEGORY_SOURCE_BYTES) throw new Error('Choose JPG, PNG or WebP images under 20 MB.');
          status.textContent = `Preparing ${uploaded+1} of ${files.length}…`;
          const prepared = await prepareGalleryImage(file,mime);
          status.textContent = `Uploading ${uploaded+1} of ${files.length}…`;
          const response = await fetch(`/api/admin/galleries/${selected.id}/images`, {method:'PUT',credentials:'same-origin',headers:{'Content-Type':prepared.type},body:prepared});
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Could not upload image.');
          uploaded++;
        } catch(error){ failure = error; break; }
      }
      galleryUploadBusy = false;
      if (!panel.isConnected || adminTab !== 'galleries') return;
      await renderAdminGalleries(panel);
      toast(failure ? `${uploaded} uploaded. ${failure.message}` : `${uploaded} photo${uploaded===1?'':'s'} uploaded.`, failure?'error':'success');
    };
  } catch(error){ if ($('#galleryAdminBody')?.isConnected) $('#galleryAdminBody').textContent = error.message || 'Could not load collections.'; }
}
async function prepareGalleryImage(file,mime){
  if (file.size <= 8 * 1024 * 1024) return file.type === mime ? file : new Blob([file], {type:mime});
  const objectURL = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectURL;
    await new Promise((resolve,reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Could not open this image.')); });
    return await optimizeCategoryImage(image);
  } finally { URL.revokeObjectURL(objectURL); }
}
function editGalleryModal(gallery=null){
  openModal({title:gallery?'Edit collection':'New collection',body:`<div class="field"><label for="galleryTitle">Collection title</label><input id="galleryTitle" maxlength="120" value="${esc(gallery?.title || '')}" required></div><div class="field"><label for="galleryDescription">Description (optional)</label><textarea id="galleryDescription" maxlength="1000">${esc(gallery?.description || '')}</textarea></div>`,footer:'<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn primary" id="gallerySave">Save collection</button>'});
  $('#gallerySave').onclick = async () => {
    const button = $('#gallerySave'); button.disabled = true;
    try {
      const result = await api(gallery ? `/api/admin/galleries/${gallery.id}` : '/api/admin/galleries', {method:gallery?'PATCH':'POST',body:JSON.stringify({title:$('#galleryTitle').value,description:$('#galleryDescription').value})});
      gallerySelectedId = result.gallery.id;
      closeModal(); if (adminTab === 'galleries') await renderAdminGalleries($('#adminPanel')); toast('Collection saved. Add images before publishing.','success');
    } catch(error){ button.disabled = false; toast(error.message,'error'); }
  };
}
function renderAdminCats(panel){
  panel.innerHTML = `<div class="admin-panel-head"><h3>Categories <span class="count">${DATA.categories.length}</span></h3><button class="btn accent sm" id="adminAddCat">＋ Add category</button></div>
    <table class="admin-category-table"><thead><tr><th>Name</th><th>Published videos</th><th style="text-align:right">Actions</th></tr></thead><tbody id="adminCatTable"></tbody></table>`;
  $('#adminCatTable').innerHTML = DATA.categories.map(category => `<tr data-id="${category.id}"><td><div class="admin-category-name"><span class="admin-category-thumb" style="${artStyle(category.seed)}">${category.image ? `<img src="${esc(category.image)}" alt="">` : ''}</span>${esc(category.n)}</div></td><td class="mono">${category.c}</td><td><div class="row-actions"><button class="row-act" data-act="edit" title="Edit category and image">✎</button><button class="row-act danger" data-act="delete" title="Delete">×</button></div></td></tr>`).join('');
  $('#adminAddCat').onclick = () => openCatEditModal(null);
  $('#adminCatTable').addEventListener('click', event => {
    const row = event.target.closest('tr[data-id]'), action = event.target.closest('[data-act]')?.dataset.act;
    if (!row || !action) return;
    const category = DATA.categories.find(item => Number(item.id) === Number(row.dataset.id));
    if (!category) return;
    if (action === 'edit') openCatEditModal(category);
    if (action === 'delete') confirmAction(`Delete “${category.n}”?`, async () => {
      try { await api(`/api/admin/categories/${category.id}`,{method:'DELETE'}); await renderAdminView(); toast('Category deleted.','success'); }
      catch(error){ toast(error.message,'error'); }
    }, 'Delete');
  });
}

function openCatEditModal(category=null){
  let savedCategory = category, selectedImage = null;
  openModal({title:category?'Edit category':'Add category',body:`
    <div class="field"><label for="ecN">Category name</label><input id="ecN" maxlength="80" value="${esc(category?.n||'')}"></div>
    <div class="field"><label for="ecImage">Category image (optional)</label>
      <div class="category-image-preview" id="ecPreview" style="${artStyle(category?.seed || 0)}">${category?.image ? `<img src="${esc(category.image)}" alt="Current category image">` : ''}</div>
      <input id="ecImage" type="file" accept="image/jpeg,image/png,image/webp">
      <div class="hint">JPG, PNG or WebP · images over 3 MB or 1600 px are resized before upload (up to 20 MB). Without an image, the color background remains.</div>
      <div class="hint" id="ecImageStatus" role="status"></div>
      ${category?.image ? '<button class="btn soft sm" id="ecRemoveImage" type="button">Remove image</button>' : ''}
    </div>`,footer:`<button class="mbtn" data-close-modal>Cancel</button><button class="mbtn primary" id="ecSave">${category?'Save':'Add'}</button>`});
  const imageInput = $('#ecImage'), preview = $('#ecPreview'), save = $('#ecSave'), status = $('#ecImageStatus');
  let selection = 0;
  imageInput.onchange = () => {
    const currentSelection = ++selection;
    const file = imageInput.files?.[0];
    if (categoryPreviewURL){ URL.revokeObjectURL(categoryPreviewURL); categoryPreviewURL = null; }
    selectedImage = null;
    if (!file) { preview.innerHTML = category?.image ? `<img src="${esc(category.image)}" alt="Current category image">` : ''; status.textContent = ''; save.disabled = false; return; }
    const mime = categoryImageMime(file);
    if (!mime || !file.size || file.size > MAX_CATEGORY_SOURCE_BYTES){
      status.textContent = 'Choose a JPG, PNG or WebP image up to 20 MB.';
      save.disabled = true;
      return;
    }
    save.disabled = true;
    status.textContent = 'Checking image…';
    categoryPreviewURL = URL.createObjectURL(file);
    const image = document.createElement('img');
    image.alt = 'New category image preview';
    image.onload = async () => {
      try {
        const resize = file.size > MAX_CATEGORY_IMAGE_BYTES || Math.max(image.naturalWidth, image.naturalHeight) > 1600;
        selectedImage = resize
          ? await optimizeCategoryImage(image)
          : (file.type === mime ? file : new Blob([file], {type:mime}));
        if (currentSelection !== selection) return;
        status.textContent = resize ? `Ready to upload · resized to ${fmtBytes(selectedImage.size)}` : `Ready to upload · ${fmtBytes(file.size)}`;
        save.disabled = false;
      } catch(error){
        if (currentSelection !== selection) return;
        selectedImage = null;
        status.textContent = error.message || 'Could not prepare this image.';
        save.disabled = true;
      }
    };
    image.onerror = () => {
      if (currentSelection !== selection) return;
      preview.replaceChildren();
      if (category?.image) {
        const current = document.createElement('img');
        current.src = category.image;
        current.alt = 'Current category image';
        preview.append(current);
      }
      status.textContent = 'This image could not be opened. Choose a JPG, PNG or WebP image.';
      save.disabled = true;
    };
    preview.replaceChildren(image);
    image.src = categoryPreviewURL;
  };
  $('#ecRemoveImage')?.addEventListener('click', async () => {
    try {
      await api(`/api/admin/categories/${category.id}/image`, {method:'DELETE'});
      selection++;
      selectedImage = null;
      imageInput.value = '';
      if (categoryPreviewURL){ URL.revokeObjectURL(categoryPreviewURL); categoryPreviewURL = null; }
      category.image = null;
      preview.innerHTML = '';
      status.textContent = 'Category image removed.';
      save.disabled = false;
      $('#ecRemoveImage').remove();
      await renderAdminView();
      renderCategories();
      toast('Category image removed.', 'success');
    } catch(error){ toast(error.message, 'error'); }
  });
  $('#ecSave').onclick = async () => {
    save.disabled = true;
    imageInput.disabled = true;
    $('#ecN').disabled = true;
    const removeButton = $('#ecRemoveImage');
    if (removeButton) removeButton.disabled = true;
    let detailsSaved = false;
    try {
      const result = savedCategory
        ? await api(`/api/admin/categories/${savedCategory.id}`,{method:'PATCH',body:JSON.stringify({name:$('#ecN').value})})
        : await api('/api/admin/categories',{method:'POST',body:JSON.stringify({name:$('#ecN').value})});
      savedCategory = result.category;
      detailsSaved = true;
      if (selectedImage) {
        status.textContent = 'Uploading image…';
        const response = await fetch(`/api/admin/categories/${savedCategory.id}/image`, {method:'PUT',credentials:'same-origin',headers:{'Content-Type':selectedImage.type},body:selectedImage});
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not upload category image.');
      }
      closeModal(); await renderAdminView(); renderCategories(); toast('Category saved.','success');
    } catch(error){
      const message = detailsSaved && selectedImage ? `Category name saved, but image upload failed: ${error.message}. Press Save to retry.` : `Save failed: ${error.message}`;
      status.textContent = message;
      toast(message,'error');
      save.disabled = false;
      imageInput.disabled = false;
      $('#ecN').disabled = false;
      if (removeButton) removeButton.disabled = false;
    }
  };
}

function renderAdminSettings(panel){
  const featuredOptions = DATA.videos.filter(video=>video.status==='live').map(video=>`<option value="${video.id}" ${String(SITE_SETTINGS.featuredVideoId)===String(video.id)?'selected':''}>${esc(video.t)}</option>`).join('');
  panel.innerHTML = `<div class="admin-panel-head"><h3>Site settings</h3></div>
    <div class="admin-settings-form">
      <div class="field"><label>Site name</label><input id="siteName" maxlength="60" value="${esc(SITE_SETTINGS.siteName)}"></div>
      <div class="field"><label>Tagline</label><input id="siteTagline" maxlength="160" value="${esc(SITE_SETTINGS.tagline)}"></div>
      <div class="field"><label>Homepage announcement</label><textarea id="adminAnnouncement" maxlength="300" placeholder="Optional announcement">${esc(SITE_SETTINGS.announcement)}</textarea></div>
      <div class="field"><label>Public contact email</label><input id="siteContactEmail" type="email" maxlength="254" placeholder="contact@example.com" value="${esc(SITE_SETTINGS.contactEmail || '')}"><p class="hint">Shown under Contact and copyright requests.</p></div>
      <div class="field"><label>Featured video</label><select id="siteFeatured"><option value="">Do not feature a video</option>${featuredOptions}</select></div>
      <button class="btn accent" id="saveSiteSettings">Save site settings</button>
    </div>`;
  $('#saveSiteSettings').onclick = async () => {
    try {
      const result = await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({siteName:$('#siteName').value,tagline:$('#siteTagline').value,announcement:$('#adminAnnouncement').value,contactEmail:$('#siteContactEmail').value,featuredVideoId:$('#siteFeatured').value})});
      SITE_SETTINGS = result.settings; applySiteBrand(); await renderAdminView(); toast('Site settings saved.','success');
    } catch(error){ toast(error.message,'error'); }
  };
}

function renderAdminAds(panel){
  const fields = placement => {
    const enabled = SITE_SETTINGS[`ad${placement}Enabled`] === '1';
    return `<div class="ad-admin-card">
      <div class="ad-admin-top"><div><h4>${placement === 'Home' ? 'Home video grid' : 'Video page'}</h4><p>${placement === 'Home' ? 'One ad row after the first six videos.' : 'One slot below the video description.'}</p></div>
        <label class="ad-switch"><input id="ad${placement}Enabled" type="checkbox" ${enabled ? 'checked' : ''}> On</label></div>
      <div class="ad-admin-fields">
        <div class="field"><label for="ad${placement}DesktopZone">Desktop zone ID</label><input id="ad${placement}DesktopZone" inputmode="numeric" pattern="[0-9]*" maxlength="15" placeholder="ExoClick zone ID" value="${esc(SITE_SETTINGS[`ad${placement}DesktopZone`] || '')}"></div>
        <div class="field"><label for="ad${placement}MobileZone">Mobile zone ID</label><input id="ad${placement}MobileZone" inputmode="numeric" pattern="[0-9]*" maxlength="15" placeholder="ExoClick zone ID" value="${esc(SITE_SETTINGS[`ad${placement}MobileZone`] || '')}"></div>
      </div><p class="hint">Use a responsive banner or native zone that fits the available width. Only devices with a zone ID show this ad.</p>
    </div>`;
  };
  panel.innerHTML = `<div class="admin-panel-head"><h3>Ad management</h3></div>
    <div class="admin-settings-form">
      <p class="ad-admin-intro">Add ExoClick banner or native ad zone IDs. Ads start off and appear only after you enable a placement. No popups or player overlays.</p>
      ${fields('Home')}${fields('Watch')}
      <button class="btn accent" id="saveAdSettings">Save ad settings</button>
    </div>`;
  $('#saveAdSettings').onclick = async () => {
    const button = $('#saveAdSettings');
    const next = {};
    for (const placement of ['Home', 'Watch']) {
      next[`ad${placement}Enabled`] = $(`#ad${placement}Enabled`).checked;
      for (const device of ['Desktop', 'Mobile']) next[`ad${placement}${device}Zone`] = $(`#ad${placement}${device}Zone`).value.trim();
    }
    button.disabled = true;
    try {
      const result = await api('/api/admin/settings', {method:'PATCH', body:JSON.stringify(next)});
      SITE_SETTINGS = result.settings;
      await renderAdminView();
      toast('Ad settings saved.','success');
    } catch (error) { toast(error.message,'error'); button.disabled = false; }
  };
}

async function exportAdminData(){
  const button = $('#adminExport'); button.disabled = true;
  try {
    const [{collections},{galleries}] = await Promise.all([api('/api/admin/video-collections'),api('/api/admin/galleries')]);
    const blob = new Blob([JSON.stringify({videos:DATA.videos,categories:DATA.categories,videoCollections:collections,photoCollections:galleries,settings:SITE_SETTINGS},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${brandFileName()}-catalog-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(url);
    toast('Catalog metadata exported. Use Backup for uploaded media.','success');
  } catch(error){ toast(error.message || 'Could not export catalog.','error'); }
  finally { if (button.isConnected) button.disabled = false; }
}

/* ============================================================
   SECTION 16 · UPLOAD MODAL
   ============================================================ */
let uploadFile = null;
let uploadDur = 0;
let uploadPreviewURL = null;
let uploadBusy = false;
let uploadDraftId = null;
let uploadFileUploaded = false;
let uploadExistingVideo = null;
let activeUploadRequest = null;
let uploadCancelRequested = false;
function parseTagInput(value){ return String(value || '').split(',').map(tag => tag.trim()).filter(Boolean); }

function openUploadModal(existing = null){
  if (uploadBusy) return;
  if (!isAdmin()){ toast('Sign in as the administrator to upload videos.','error'); return; }
  uploadFile = null; uploadDur = 0; uploadDraftId = existing?.id || null;
  uploadFileUploaded = false; uploadExistingVideo = existing; uploadCancelRequested = false;
  const catOpts = DATA.categories.map(category => `<option value="${esc(category.n)}">${esc(category.n)}</option>`).join('');
  openModal({title:existing ? `Replace file · ${existing.t}` : 'Upload video',size:'wide',body:`
    <div id="uploadStep1"><div class="upload-zone" id="uploadZone">
      <div class="icon">↑</div><h4>Choose a video file</h4><p>MP4 or WebM · up to ${RUNTIME.maxUploadMB || 2048} MB</p>
      <input type="file" id="uploadInput" accept="video/mp4,video/webm,.mp4,.webm" hidden>
    </div></div>
    <div id="uploadStep2" hidden>
      <div class="upload-preview"><div class="thumb-wrap"><video id="uploadPreview" playsinline controls preload="auto"></video></div>
        <div class="info"><div class="name" id="uploadName"></div><div class="meta" id="uploadMeta"></div><div class="actions"><button class="mbtn" id="uploadChange" type="button">Change file</button></div></div>
      </div>
      <div class="field" style="margin-top:22px"><label>Title</label><input id="upT" maxlength="160" placeholder="Video title" value="${esc(existing?.t || '')}"></div>
      <div class="field"><label>Description</label><textarea id="upDesc" maxlength="5000" placeholder="Optional video description">${esc(existing?.description || '')}</textarea></div>
      <div class="field"><label>Category</label><select id="upC">${catOpts}</select></div>
      <div class="field"><label for="upTags">Tags</label><input id="upTags" maxlength="300" placeholder="e.g. cinematic, outdoor" value="${esc((existing?.tags || []).join(', '))}"><p class="hint">Up to 8 comma-separated tags. Leave empty if they do not apply.</p></div>
      <div class="field"><label>After upload</label><select id="upSt"><option value="draft">Save as draft</option><option value="live">Publish immediately</option></select></div>
      <div class="progress-bar" id="uploadProgBar" style="display:none"><i id="uploadProgFill"></i></div>
      <div class="progress-text" id="uploadProgText" style="display:none"><span id="uploadProgLabel">Uploading…</span><span id="uploadProgPct">0%</span></div>
    </div>`,
    footer:`<button class="mbtn" id="uploadCancel">Cancel</button><button class="mbtn primary" id="uploadSubmit" disabled>${existing ? 'Replace file' : 'Upload video'}</button>`});
  if (existing){ $('#upC').value = existing.c; $('#upSt').value = existing.status === 'live' ? 'live' : 'draft'; }
  bindUploadModal();
}

function bindUploadModal(){
  const zone=$('#uploadZone'), input=$('#uploadInput');
  zone.onclick=()=>input.click();
  zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('drag');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag'));
  zone.addEventListener('drop',event=>{event.preventDefault();zone.classList.remove('drag');const file=event.dataTransfer.files?.[0];if(file)handleUploadFile(file);});
  input.onchange=event=>{const file=event.target.files?.[0];if(file)handleUploadFile(file);};
  $('#uploadChange').onclick=()=>{
    if (uploadBusy) return;
    uploadFile=null; uploadDur=0; uploadFileUploaded=false;
    const preview=$('#uploadPreview'); preview.pause(); preview.removeAttribute('src'); preview.load();
    if(uploadPreviewURL){URL.revokeObjectURL(uploadPreviewURL); uploadPreviewURL=null;}
    $('#uploadStep1').hidden=false; $('#uploadStep2').hidden=true; $('#uploadSubmit').disabled=true;
  };
  $('#uploadSubmit').onclick=doUpload;
  $('#uploadCancel').onclick=()=>{
    if (!uploadBusy) return closeModal();
    if (!activeUploadRequest) return toast('Finishing the current step. Please wait.', 'warn');
    uploadCancelRequested=true;
    activeUploadRequest.abort();
  };
}

function handleUploadFile(file){
  if (uploadBusy) return;
  const extension=file.name.toLowerCase().split('.').pop();
  if(!['mp4','webm'].includes(extension)){toast('Choose an MP4 or WebM video.','error');return;}
  if(file.type && file.type !== (extension === 'mp4' ? 'video/mp4' : 'video/webm')){toast('The file type does not match its extension.','error');return;}
  if(!file.size || file.size > (RUNTIME.maxUploadMB || 2048) * 1024 * 1024){toast('Choose a nonempty video within the upload limit.','error');return;}
  uploadFile=file;uploadDur=0;uploadFileUploaded=false;$('#uploadStep1').hidden=true;$('#uploadStep2').hidden=false;
  $('#uploadName').textContent=file.name;$('#uploadMeta').textContent=`${file.type||extension.toUpperCase()} · ${fmtBytes(file.size)}`;
  const preview=$('#uploadPreview');
  preview.pause();
  if(uploadPreviewURL) URL.revokeObjectURL(uploadPreviewURL);
  uploadPreviewURL=URL.createObjectURL(file);
  $('#uploadSubmit').disabled=true;
  preview.onloadedmetadata=()=>{
    if(uploadFile!==file) return;
    uploadDur=Number.isFinite(preview.duration)?preview.duration:0;
    $('#uploadMeta').textContent=`${file.type||extension.toUpperCase()} · ${fmtBytes(file.size)} · ${fmtTime(uploadDur)} · checking playback…`;
    if(!$('#upT').value){const title=file.name.replace(/\.[^.]+$/,'').replace(/[-_]+/g,' ').trim();$('#upT').value=title.charAt(0).toUpperCase()+title.slice(1);}
  };
  preview.onloadeddata=()=>{
    if(uploadFile!==file) return;
    $('#uploadMeta').textContent=`${file.type||extension.toUpperCase()} · ${fmtBytes(file.size)} · ${fmtTime(uploadDur)}`;
    $('#uploadSubmit').disabled=false;
  };
  preview.onerror=()=>{if(uploadFile!==file) return; uploadDur=0; $('#uploadSubmit').disabled=true; $('#uploadMeta').textContent='Preview unavailable · choose a browser-compatible MP4 or WebM';};
  preview.src=uploadPreviewURL;
}

// The browser sends 8 MiB TUS chunks directly to Bunny; uploads can resume.
function bunnyRequest(method,url,headers,body,onProgress){
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();activeUploadRequest=request;
    request.open(method,url);
    for(const [name,value] of Object.entries(headers))request.setRequestHeader(name,String(value));
    if(onProgress)request.upload.onprogress=event=>onProgress(event.loaded);
    request.onload=()=>{activeUploadRequest=null;
      if(request.status>=200&&request.status<300)resolve(request);
      else reject(new Error(`Bunny upload returned ${request.status}. Check the Stream library and try again.`));
    };
    request.onerror=()=>{activeUploadRequest=null;reject(new Error('Connection to Bunny was interrupted. Retry to resume.'));};
    request.onabort=()=>{activeUploadRequest=null;reject(new Error('Upload cancelled.'));};
    request.send(body||null);
  });
}
async function sendBunnyUpload(file,id,title){
  const mime=file.type || (file.name.toLowerCase().endsWith('.webm')?'video/webm':'video/mp4');
  const credentials=await api(`/api/admin/videos/${id}/bunny-upload`,{method:'POST',body:JSON.stringify({mime,size:file.size})});
  const auth={AuthorizationSignature:credentials.signature,AuthorizationExpire:credentials.expires,LibraryId:credentials.libraryId,VideoId:credentials.guid,'Tus-Resumable':'1.0.0'};
  const cacheKey=`aura-bunny-upload:${credentials.guid}:${file.size}:${file.name}:${file.lastModified}`;
  const validUrl=value=>{if(typeof value!=='string'||!value.trim())return null;try{const url=new URL(value,'https://video.bunnycdn.com');return url.protocol==='https:'&&url.hostname==='video.bunnycdn.com'?url.href:null;}catch{return null;}};
  const encode=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  let uploadUrl=validUrl(localStorage.getItem(cacheKey));
  let offset=0;
  if(uploadUrl){
    try{
      const head=await bunnyRequest('HEAD',uploadUrl,auth);
      offset=Number(head.getResponseHeader('Upload-Offset'));
      if(!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw new Error('Invalid upload position.');
    }catch(error){
      if(uploadCancelRequested||!/^Bunny upload returned (404|410)\./.test(error.message))throw error;
      uploadUrl=null;localStorage.removeItem(cacheKey);
    }
  }
  if(!uploadUrl){
    const created=await bunnyRequest('POST','https://video.bunnycdn.com/tusupload',{
      ...auth,'Upload-Length':file.size,'Upload-Metadata':`filetype ${encode(mime)},title ${encode(title)}`
    });
    uploadUrl=validUrl(created.getResponseHeader('Location'));
    if(!uploadUrl)throw new Error('Bunny returned an invalid upload address.');
    localStorage.setItem(cacheKey,uploadUrl);
  }
  while(offset<file.size){
    const start=offset,end=Math.min(file.size,start+8*1024*1024);
    let response;
    for(let attempt=0;attempt<3;attempt++){
      if(uploadCancelRequested)throw new Error('Upload cancelled.');
      try{
        response=await bunnyRequest('PATCH',uploadUrl,{...auth,'Content-Type':'application/offset+octet-stream','Upload-Offset':start},file.slice(start,end),loaded=>{
          const percent=Math.round((start+loaded)/file.size*100);
          $('#uploadProgFill').style.width=`${percent}%`;$('#uploadProgPct').textContent=`${percent}%`;
        });
        break;
      }catch(error){
        if(uploadCancelRequested)throw error;
        if(attempt===2)throw error;
        const head=await bunnyRequest('HEAD',uploadUrl,auth);
        const remoteOffset=Number(head.getResponseHeader('Upload-Offset'));
        if(remoteOffset>start&&remoteOffset<=file.size){offset=remoteOffset;break;}
      }
    }
    if(offset>start)continue;
    offset=Number(response.getResponseHeader('Upload-Offset'));
    if(!Number.isSafeInteger(offset)||offset<=start||offset>file.size)throw new Error('Bunny reported an invalid upload position.');
  }
  $('#uploadProgLabel').textContent='Confirming video with Bunny…';
  for(let attempt=0;attempt<5;attempt++){
    try{await api(`/api/admin/videos/${id}/bunny-upload/complete`,{method:'POST',body:'{}'});localStorage.removeItem(cacheKey);return;}
    catch(error){if(attempt===4||!error.message?.includes('full file'))throw error;await new Promise(resolve=>setTimeout(resolve,2000));}
  }
}

async function doUpload(){
  if(uploadBusy||!uploadFile||!isAdmin())return;
  const button=$('#uploadSubmit'),title=$('#upT').value.trim();
  if(!title){toast('Enter a video title.','error');return;}
  button.disabled=true; uploadBusy=true;
  $$('#modalBody input, #modalBody select, #modalBody textarea, #uploadChange').forEach(input => input.disabled = true);
  $('#uploadPreview').pause();
  $('#uploadProgBar').style.display='block';$('#uploadProgText').style.display='flex';
  $('#uploadProgLabel').textContent='Preparing upload…';
  try{
    const details={title,description:$('#upDesc').value,category:$('#upC').value,tags:parseTagInput($('#upTags').value),duration:uploadDur,quality:uploadExistingVideo?.quality || 'Auto'};
    const createdNow = !uploadDraftId;
    if(!uploadDraftId) {
      const created=await api('/api/admin/videos',{method:'POST',body:JSON.stringify(details)});
      uploadDraftId=created.item.id;
    }
    if(!uploadFileUploaded){
      $('#uploadProgLabel').textContent='Uploading video…';
      if(RUNTIME.bunnyEnabled) await sendBunnyUpload(uploadFile,uploadDraftId,title);
      else await new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest();
      activeUploadRequest=request;
      request.open('PUT',`/api/admin/videos/${uploadDraftId}/file`);
      request.withCredentials=true;request.setRequestHeader('Content-Type',uploadFile.type|| (uploadFile.name.toLowerCase().endsWith('.webm')?'video/webm':'video/mp4'));
      request.upload.onprogress=event=>{if(event.lengthComputable){const percent=Math.round(event.loaded/event.total*100);$('#uploadProgFill').style.width=`${percent}%`;$('#uploadProgPct').textContent=`${percent}%`;if(percent===100)$('#uploadProgLabel').textContent='Saving video…';}};
      request.onload=()=>{activeUploadRequest=null;let data={};try{data=JSON.parse(request.responseText);}catch{};if(request.status>=200&&request.status<300)resolve(data);else reject(new Error(data.error||'Upload failed.'));};
      request.onerror=()=>{activeUploadRequest=null;reject(new Error('Network error while uploading.'));};
      request.onabort=()=>{activeUploadRequest=null;reject(new Error('Upload cancelled.'));};
      request.send(uploadFile);
      });
      uploadFileUploaded=true;
      invalidateThumb(uploadDraftId);
    }
    if(!createdNow) await api(`/api/admin/videos/${uploadDraftId}`,{method:'PATCH',body:JSON.stringify(details)});
    if(($('#upSt').value==='live') !== (uploadExistingVideo?.status === 'live') || (RUNTIME.bunnyEnabled && $('#upSt').value==='live')){
      try{await api(`/api/admin/videos/${uploadDraftId}/publish`,{method:'PATCH',body:JSON.stringify({published:$('#upSt').value==='live'})});}
      catch(error){
        if(!RUNTIME.bunnyEnabled || !error.message?.includes('processing'))throw error;
        toast('Video saved as a draft while Bunny finishes encoding. Publish it from Videos when ready.','warn');
      }
    }
    $('#uploadProgFill').style.width='100%';$('#uploadProgPct').textContent='100%';$('#uploadProgLabel').textContent='Upload complete';
    uploadBusy=false; closeModal();
    try { await loadCatalog(); await renderAdminView(); toast(`“${title}” uploaded.`, 'success'); }
    catch(error){ toast(`“${title}” was saved. Refresh the panel to see the latest changes.`, 'warn'); }
  }catch(error){
    if(uploadCancelRequested){
      uploadBusy=false; closeModal();
      toast('Upload stopped. Check the draft in Admin before retrying.', 'warn');
      await renderAdminView().catch(()=>{});
      return;
    }
    $('#uploadProgLabel').textContent=uploadFileUploaded ? 'File saved · action incomplete' : 'Upload failed';
    toast(error.message||'Could not upload this video.','error');
    button.disabled=false; uploadBusy=false;
    $$('#modalBody input, #modalBody select, #modalBody textarea, #uploadChange').forEach(input => input.disabled = false);
    if(uploadDraftId && !uploadExistingVideo) await renderAdminView().catch(()=>{});
  }
}

/* ============================================================
   SECTION 17 · SEARCH
   ============================================================ */
const searchInput = $('#searchInput'), suggestBox = $('#suggestBox');

function buildSuggestions(q){
  if (!q.trim()) return [];
  const term = q.toLowerCase();
  const categories = DATA.categories.filter(c => c.n.toLowerCase().includes(term)).slice(0,3)
    .map(c => ({type:'category', label:c.n, sub:`${c.c} videos`}));
  const videos = DATA.videos.filter(v => v.status === 'live' && (v.t.toLowerCase().includes(term) || v.c.toLowerCase().includes(term) || (v.tags || []).some(tag => tag.toLowerCase().includes(term))))
    .slice(0, 6 - categories.length).map(v => ({type:'video', label:v.t, sub:v.s, id:v.id}));
  return [...categories, ...videos];
}

searchInput.addEventListener('input', e => {
  const q = e.target.value;
  const s = buildSuggestions(q);
  if (!s.length){ suggestBox.classList.remove('open'); return; }
  suggestBox.innerHTML = `<div class="suggest-head">Suggestions</div>` + s.map((it, i) => `
    <div class="suggest-item ${i===0?'active':''}" data-type="${it.type}" data-id="${it.id||''}" data-label="${esc(it.label)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        ${it.type === 'video' ? '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/>' : '<circle cx="12" cy="12" r="9"/>'}
      </svg>
      <span class="label">${esc(it.label)}${it.sub ? ` <span style="color:var(--faint);font-size:11.5px">· ${esc(it.sub)}</span>` : ''}</span>
      <span class="tag">${it.type}</span>
    </div>`).join('');
  suggestBox.classList.add('open');
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter'){
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q){ goHome(q); suggestBox.classList.remove('open'); searchInput.blur(); }
  }
  if (e.key === 'Escape'){ suggestBox.classList.remove('open'); searchInput.blur(); }
});

suggestBox.addEventListener('click', e => {
  const it = e.target.closest('.suggest-item');
  if (!it) return;
  if (it.dataset.type === 'video') goWatch(Number(it.dataset.id));
  else goHome('', it.dataset.label);
  suggestBox.classList.remove('open');
  searchInput.value = '';
});

document.addEventListener('click', e => { if (!e.target.closest('#searchWrap')) suggestBox.classList.remove('open'); });

/* ============================================================
   SECTION 18 · CARD MENUS / REPORT
   ============================================================ */
function openCardMenu(id){
  const v = getVideo(id);
  if (!v) return;
  const isFav = FAVORITES.includes(id), isLater = WATCHLATER.includes(id);
  openModal({
    title: v.t,
    size: 'small',
    body: `
      <div style="display:flex;gap:8px;flex-direction:column">
        <button class="mbtn" data-cm="watch" style="justify-content:flex-start;display:flex;gap:10px">▶ Play</button>
        <button class="mbtn" data-cm="fav" style="justify-content:flex-start">${isFav ? '− Remove from Liked' : '+ Add to Liked'}</button>
        <button class="mbtn" data-cm="later" style="justify-content:flex-start">${isLater ? '− Remove from Watch later' : '+ Save to Watch later'}</button>
        <button class="mbtn" data-cm="share" style="justify-content:flex-start">Copy link</button>
      </div>`,
    footer: `<button class="mbtn" data-close-modal>Close</button>`
  });
  $$('#modalBody [data-cm]').forEach(b => b.onclick = () => {
    const cm = b.dataset.cm;
    if (cm === 'watch'){ closeModal(); goWatch(id); }
    else if (cm === 'fav'){ const on = toggleFavorite(id); toast(on ? 'Added to Liked' : 'Removed', 'success'); closeModal(); }
    else if (cm === 'later'){ const on = toggleWatchLater(id); toast(on ? 'Saved' : 'Removed', 'success'); closeModal(); }
    else if (cm === 'share'){ closeModal(); copyVideoLink(id, v.t); }
  });
}

/* ============================================================
   SECTION 19 · GLOBAL EVENT DELEGATION
   ============================================================ */
document.addEventListener('click', e => {
  const tag = e.target.closest('[data-video-tag]');
  if (tag){ goHome(tag.dataset.videoTag); return; }
  const touchPreview = e.target.closest('[data-touch-preview]');
  if (touchPreview){
    e.preventDefault(); e.stopPropagation();
    const card = touchPreview.closest('.card');
    if (card) toggleTouchPreview(card, touchPreview);
    return;
  }
  // Card menu
  const cm = e.target.closest('[data-card-menu]');
  if (cm){ e.stopPropagation(); openCardMenu(Number(cm.dataset.cardMenu)); return; }

  // Nav
  const nav = e.target.closest('[data-nav]');
  if (nav){
    e.preventDefault();
    const d = nav.dataset.nav;
    if (d === 'home') goHome();
    else if (d === 'cats') goCats();
    else if (d === 'photos') goPhotos();
    else if (d === 'collections') goCollections();
    else if (d === 'trending') goHome('', 'Trending');
    else if (d === 'random'){
      api('/api/videos/random').then(({item}) => {
        if (!item) return toast('No published videos yet.','warn');
        cacheVideos([item]); goWatch(item.id);
      }).catch(error => toast(error.message || 'Could not find a video.', 'error'));
    }
    else if (['history','favorites','watchlater'].includes(d)) goLibrary(d);
    else if (d === 'settings') goSettings();
    else if (d === 'admin') goAdmin();
    else if (d === 'upload') openUploadModal();
    else if (d === 'logout') confirmAction('Sign out of admin?', logoutAdmin, 'Sign out');
    closeDrawer();
    return;
  }

  // Hero
  if (e.target.closest('#heroPlay')){ const id = Number($('#heroPlay').dataset.id); if (id) goWatch(id); return; }
  if (e.target.closest('#heroMotionToggle')){
    const player = $('#heroVideo');
    if (player.paused){
      heroMotionPausedByUser = false;
      player.play().then(()=>updateHeroMotionControl(false)).catch(()=>{});
    } else {
      heroMotionPausedByUser = true;
      player.pause();
      updateHeroMotionControl(true);
    }
    return;
  }

  // Browse all
  if (e.target.closest('#browseAll')){ e.preventDefault(); goHome(); return; }

  // Video card / side item
  const card = e.target.closest('.card, .side-item');
  if (card && card.dataset.id){ goWatch(Number(card.dataset.id)); return; }

  // Category
  const cat = e.target.closest('.cat-card');
  if (cat){ e.preventDefault(); goHome('', cat.dataset.cat); return; }

  // Logo (nav home)
  if (e.target.closest('#logoBtn')){ e.preventDefault(); goHome(); return; }

  // Upload button in header
  if (e.target.closest('#uploadBtn')){ openUploadModal(); return; }
});
document.addEventListener('keydown', e => {
  if (!['Enter', ' '].includes(e.key) || e.target.closest('button,a,input,select,textarea')) return;
  const card = e.target.closest('.card, .side-item');
  if (card?.dataset.id){ e.preventDefault(); goWatch(Number(card.dataset.id)); }
});

/* Header menu / search focus shortcuts */
$('#menuBtn').onclick = openDrawer;
$('#closeDrawer').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){ e.preventDefault(); searchInput.focus(); }
  // Ctrl/Cmd+K focus search
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); searchInput.focus(); searchInput.select(); }
});

/* Profile button */
$('#profileBtn').onclick = () => {
  const admin = isAdmin();
  openModal({
    title: 'Your library',
    size: 'small',
    body: `
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:22px">
        <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(140deg,#312D48,#211F33);color:#B9AEE6;display:grid;place-items:center;font-size:15px;font-weight:600">${esc($('#profileBtn').textContent)}</div>
        <div>
          <div style="font-size:14.5px;font-weight:500;color:var(--text)">${admin ? 'Administrator' : 'Guest'}</div>
          <div style="font-size:12.5px;color:var(--faint);margin-top:3px">${admin ? 'Signed in with full access' : 'Saved in this browser'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-direction:column">
        <button class="mbtn" data-pm="history" style="justify-content:flex-start;text-align:left">Watch history</button>
        <button class="mbtn" data-pm="favorites" style="justify-content:flex-start;text-align:left">Liked videos</button>
        <button class="mbtn" data-pm="settings" style="justify-content:flex-start;text-align:left">Settings</button>
        ${!RUNTIME.separateAdmin && !admin ? `<button class="mbtn" data-pm="login-admin" style="justify-content:flex-start;text-align:left;color:var(--accent-text);border-color:var(--accent-line)">Sign in as admin</button>` : ''}
        ${!RUNTIME.separateAdmin && admin ? `<button class="mbtn" data-pm="admin" style="justify-content:flex-start;text-align:left;color:var(--accent-text);border-color:var(--accent-line)">Open admin panel</button>` : ''}
      </div>`,
    footer: `<button class="mbtn" data-close-modal>Close</button>`
  });
  $$('#modalBody [data-pm]').forEach(b => b.onclick = () => {
    const pm = b.dataset.pm;
    closeModal();
    if (pm === 'settings') goSettings();
    else if (pm === 'admin') goAdmin();
    else if (pm === 'login-admin'){ goSettings(); }
    else goLibrary(pm);
  });
};

/* Settings admin button */
$('#adminLoginToggle').onclick = () => {
  if (isAdmin()) confirmAction('Sign out of admin?', logoutAdmin, 'Sign out');
  else goAdmin();
};

/* Settings actions */
$('#exportUserData').onclick = () => {
  const bundle = {prefs:PREFS, history:HISTORY, favorites:FAVORITES, watchLater:WATCHLATER};
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${brandFileName()}-viewer-${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
  toast('Exported.', 'success');
};
$('#clearHistoryBtn').onclick = () => confirmAction('Clear all watch history?', () => { HISTORY = []; writeJSON(KEYS.HIST, HISTORY); renderContinueRow().catch(error => console.warn(error)); toast('Cleared.', 'success'); }, 'Clear');
$('#resetAllBtn').onclick = () => confirmAction('Reset viewer settings, history, likes, and watch-later list?', async () => {
  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  location.reload();
}, 'Reset');

/* Auto-toggle for watch page */
document.addEventListener('click', e => {
  const t = e.target.closest('#autoToggle');
  if (t){ PREFS.autoplay = !PREFS.autoplay; savePrefs(); }
});

/* Mini player */
let miniVideoId = null, miniSavedSecond = -1;
function saveMiniProgress(){
  const mv = $('#miniVideo');
  if (miniVideoId && mv.currentTime > 3) addToHistory(miniVideoId, mv.currentTime, mv.duration);
}
$('#miniVideo').addEventListener('timeupdate', () => {
  const second = Math.floor($('#miniVideo').currentTime);
  if (second >= 5 && (miniSavedSecond < 0 || Math.abs(second-miniSavedSecond) >= 10)) { miniSavedSecond = second; saveMiniProgress(); }
});
$('#miniVideo').addEventListener('pause', saveMiniProgress);
$('#miniVideo').addEventListener('ended', saveMiniProgress);
window.addEventListener('pagehide', () => { saveMiniProgress(); disposePlayer(); });
window.addEventListener('pageshow', event => {
  if (event.persisted && location.hash.startsWith('#watch=')) goWatch(Number(location.hash.slice(7)));
});
$('#miniPlay').onclick = e => { e.stopPropagation(); const mv = $('#miniVideo'); if (mv.paused) mv.play().catch(()=>{}); else mv.pause(); };
$('#miniExpand').onclick = e => {
  e.stopPropagation();
  const mv = $('#miniVideo'), t = mv.currentTime, wasPlaying = !mv.paused;
  $('#miniPlayer').hidden = true;
  mv.pause();
  if (miniVideoId) goWatch(miniVideoId).then(() => {
    const mainVid = $('#video');
    if (!mainVid) return;
    const resume = () => { mainVid.currentTime = Math.min(t, mainVid.duration || t); if (wasPlaying) mainVid.play().catch(()=>{}); };
    if (mainVid.readyState >= 1) resume();
    else mainVid.addEventListener('loadedmetadata', resume, {once:true});
  });
};
$('#miniClose').onclick = e => { e.stopPropagation(); $('#miniPlayer').hidden = true; $('#miniVideo').pause(); };
$('#miniPlayer').addEventListener('click', e => {
  if (e.target.closest('.mini-btn') || e.target.closest('.mini-close')) return;
  const mv = $('#miniVideo'); if (mv.paused) mv.play().catch(()=>{}); else mv.pause();
});

/* ============================================================
   SECTION 20 · HASH ROUTING
   ============================================================ */
function handleHash(){
  const raw = location.hash.slice(1);
  if (raw === _hashSet){ _hashSet = null; return; }   // we set it ourselves, page is already showing
  if (RUNTIME.isAdminHost && raw !== 'admin') return goAdmin();
  const [k, ...rest] = raw.split('=');
  let val = ''; try { val = decodeURIComponent(rest.join('=')); } catch {}
  if (k === 'watch'){ const id = Number(val); if (id) return goWatch(id); }
  if (k === 'search' && val) return goHome(val);
  if (k === 'cat' && val) return goHome('', val);
  if (k === 'sort' && ['trending','new'].includes(val)) return goHome('', val === 'new' ? 'New' : 'Trending');
  if (raw === 'admin') return goAdmin();
  if (raw === 'settings') return goSettings();
  if (raw === 'categories') return goCats();
  if (raw === 'photos') return goPhotos();
  if (k === 'photos' && /^\d+$/.test(val)) return goPhotos(Number(val));
  if (raw === 'collections') return goCollections();
  if (k === 'collection' && /^\d+$/.test(val)) return goCollections(Number(val));
  if (['history','favorites','watchlater'].includes(raw)) return goLibrary(raw);
  goHome();
}
window.addEventListener('hashchange', handleHash);

/* ============================================================
   SECTION 21 · AGE GATE + BOOT
   ============================================================ */
function checkAge(){
  let v;
  try { v = localStorage.getItem(KEYS.AGE); } catch { v = null; }
  if (v === 'yes') return true;
  if (v === 'no'){ location.replace('about:blank'); return false; }
  $('#ageGate').hidden = false;
  document.body.classList.add('no-scroll');
  $$('.topbar, .drawer, #app').forEach(el => { el.inert = true; });
  return false;
}
$('#ageConfirm').onclick = () => {
  try { localStorage.setItem(KEYS.AGE, 'yes'); } catch {}
  $('#ageGate').hidden = true;
  document.body.classList.remove('no-scroll');
  $$('.topbar, .drawer, #app').forEach(el => { el.inert = false; });
  boot();
};
$('#ageDeny').onclick = () => { try { localStorage.setItem(KEYS.AGE, 'no'); } catch {} location.replace('about:blank'); };

async function boot(){
  applyPrefs();
  try {
    await loadCatalog();
    applySiteBrand();
    if (!RUNTIME.separateAdmin || RUNTIME.isAdminHost) {
      await api('/api/admin/session');
      adminAuthenticated = true;
      document.body.classList.add('is-admin');
      $$('.admin-only').forEach(el => el.style.display = '');
    }
  } catch(error) {
    adminAuthenticated = false;
    document.body.classList.remove('is-admin');
    $$('.admin-only').forEach(el => el.style.display = 'none');
    if (!DATA.videos.length) console.warn('AURA catalog could not be loaded:',error.message);
  }
  syncSettingsUI();
  if (RUNTIME.isAdminHost) return goAdmin();
  handleHash();
}

if (RUNTIME.isAdminHost) boot();
else if (checkAge()) boot();
else if (!$('#ageGate').hidden) api('/api/settings').then(data => {
  SITE_SETTINGS = data.settings || SITE_SETTINGS;
  applySiteBrand();
}).catch(() => {});

/* Global error boundary */
window.addEventListener('error', e => console.error('AURA:', e.error || e.message));
window.addEventListener('unhandledrejection', e => console.warn('AURA promise:', e.reason));
