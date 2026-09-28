'use strict';

// Optional integration check: requires ffmpeg for tiny, real MP4/WebM fixtures.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backup, verify, restore } = require('./backup');
const { sanitizeImage } = require('../lib/image-sanitize');

const root = path.resolve(__dirname, '..');
const adminHost = 'admin.aura.test', publicHost = 'www.aura.test';
let port, processHandle;

async function request(url, { host = adminHost, method = 'GET', json, bytes, mime, cookie, range, etag, ifRange, origin, fetchSite, forwarded } = {}) {
  const body = json === undefined ? bytes : Buffer.from(JSON.stringify(json));
  const headers = { Host: `${host}:${port}` };
  if (body) { headers['Content-Type'] = mime || 'application/json'; headers['Content-Length'] = body.length; }
  if (cookie) headers.Cookie = cookie;
  if (range) headers.Range = range;
  if (etag) headers['If-None-Match'] = etag;
  if (ifRange) headers['If-Range'] = ifRange;
  if (origin || (origin !== null && url.startsWith('/api/admin/') && ['POST','PUT','PATCH','DELETE'].includes(method)))
    headers.Origin = origin || `http://${host}:${port}`;
  if (fetchSite) headers['Sec-Fetch-Site'] = fetchSite;
  if (forwarded) headers['X-Forwarded-For'] = forwarded;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const data = res.headers['content-type']?.includes('application/json') ? JSON.parse(raw.toString()) : raw;
        resolve({ status: res.statusCode, headers: res.headers, data, raw });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const available = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return available;
}

function fixture(filename, codec) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '0.5', '-c:v', codec, '-an', '-y', filename], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr || result.error}`);
}

function pngChunk(type, content) {
  const data = Buffer.concat([Buffer.from(type), content]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, checksum]);
}

function webpChunk(type, content) {
  const header = Buffer.alloc(8);
  header.write(type); header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content, content.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-smoke-'));
  try {
    const mp4Path = path.join(tmp, 'test.mp4'), webmPath = path.join(tmp, 'test.webm');
    fixture(mp4Path, 'libx264'); fixture(webmPath, 'libvpx-vp9');
    const mp4 = await fs.readFile(mp4Path), webm = await fs.readFile(webmPath);
    port = await freePort();
    const logs = [];
    const serverEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development', ADMIN_HOST: adminHost, ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD: 'a-strong-test-password-2026', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters-long', MAX_UPLOAD_MB: '1', DATA_DIR: path.join(tmp, 'db'), VIDEO_DIR: path.join(tmp, 'videos'), REPORT_TRUST_PROXY: '1' };
    const startServer = () => {
      processHandle = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      processHandle.stderr.on('data', chunk => logs.push(chunk.toString()));
    };
    startServer();
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (processHandle.exitCode !== null) throw new Error(`Server exited: ${logs.join('')}`);
      try { ready = (await request('/api/health')).status === 200; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Server did not start: ${logs.join('')}`);
    const check = async (expected, url, options) => {
      const result = await request(url, options);
      assert.equal(result.status, expected, `${options?.method || 'GET'} ${url}: ${result.raw.toString().slice(0, 200)}`);
      return result;
    };
    assert.match((await check(200, '/', { host: adminHost })).headers['content-security-policy'], /img-src [^;]*\bblob:/);
    assert.match((await check(200, '/runtime-config.js')).raw.toString(), /"isAdminHost":true/);
    assert.match((await check(200, '/runtime-config.js', { host: publicHost })).raw.toString(), /"isAdminHost":false/);
    for (const url of ['/server.js', '/.env.example', '/scripts/check-html.js', '/.gitignore']) await check(404, url, { host: publicHost });
    assert.match((await check(200, '/assets/favicon.svg', { host: publicHost })).raw.toString(), /<svg/);
    await check(404, '/api/admin/overview', { host: publicHost });
    await check(401, '/api/admin/overview');
    await check(401, '/api/admin/storage-check');
    await check(404, '/api/admin/storage-check', { host: publicHost });
    await check(401, '/api/admin/reports');
    await check(404, '/api/admin/reports', { host: publicHost });
    await check(403, '/api/admin/login', { method:'POST',json:{email:'owner@example.test',password:'bad'},fetchSite:'same-site' });
    await check(403, '/api/admin/login', { method:'POST',json:{email:'owner@example.test',password:'bad'},fetchSite:'cross-site' });
    await check(401, '/api/admin/login', { method: 'POST', json: { email: 'owner@example.test', password: 'wrong' } });
    const login = await check(200, '/api/admin/login', { method: 'POST', json: { email: 'owner@example.test', password: 'a-strong-test-password-2026' } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0], /HttpOnly.*SameSite=Lax/);
    const auth = { cookie };
    // Ad controls must stay on the admin host, start disabled, validate IDs,
    // and only loosen public CSP when an enabled slot has a valid zone.
    await check(404, '/api/admin/settings', {host:publicHost,method:'PATCH',json:{adHomeEnabled:true}});
    await check(401, '/api/admin/settings', {method:'PATCH',json:{adHomeEnabled:true}});
    const initialAds = await check(200, '/api/settings', {host:publicHost});
    assert.equal(initialAds.data.settings.adHomeEnabled, '0');
    assert.doesNotMatch(initialAds.headers['content-security-policy'], /a\.magsrv\.com/);
    await check(400, '/api/admin/settings', {...auth,method:'PATCH',json:{adHomeDesktopZone:'12<script>'}});
    await check(400, '/api/admin/settings', {...auth,method:'PATCH',json:{adHomeEnabled:true}});
    const adsEnabled = (await check(200, '/api/admin/settings', {...auth,method:'PATCH',json:{adHomeEnabled:true,adHomeDesktopZone:'123456',adHomeMobileZone:'654321',adWatchEnabled:true,adWatchMobileZone:'456789'}})).data.settings;
    assert.equal(adsEnabled.adHomeEnabled, '1');
    assert.equal(adsEnabled.adWatchMobileZone, '456789');
    const publicAds = await check(200, '/api/settings', {host:publicHost});
    assert.equal(publicAds.data.settings.adHomeDesktopZone, '123456');
    assert.match(publicAds.headers['content-security-policy'], /script-src 'self' https:\/\/a\.magsrv\.com/);
    assert.doesNotMatch((await check(200, '/api/settings', auth)).headers['content-security-policy'], /a\.magsrv\.com/);
    const imageFile = path.join(tmp, 'category.png');
    const imageResult = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=#62587e:s=400x320:d=0.1','-frames:v','1','-y',imageFile], {encoding:'utf8'});
    if (imageResult.status !== 0) throw new Error(`Category image fixture failed: ${imageResult.stderr || imageResult.error}`);
    const categoryImage = await fs.readFile(imageFile);
    const secretMarker = Buffer.from('EXIF_GPS_PRIVATE_LOCATION');
    const imageWithMetadata = Buffer.concat([categoryImage.subarray(0, categoryImage.length - 12), pngChunk('tEXt', secretMarker), categoryImage.subarray(categoryImage.length - 12)]);
    assert.deepEqual(sanitizeImage(imageWithMetadata, 'image/png'), categoryImage);
    const imageCategory = (await check(201, '/api/admin/categories', { ...auth, method:'POST', json:{ name:'Gallery' } })).data.category;
    const imageUrl = `/api/categories/${imageCategory.id}/image`;
    await check(404, imageUrl, { host:publicHost });
    await check(401, `/api/admin/categories/${imageCategory.id}/image`, { method:'PUT',mime:'image/png',bytes:categoryImage });
    await check(415, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/svg+xml',bytes:categoryImage });
    await check(415, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/png',bytes:Buffer.from('not an image') });
    await check(415, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/png',bytes:categoryImage.subarray(0, 24) });
    await check(413, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/png',bytes:Buffer.alloc(3 * 1024 * 1024 + 1) });
    const firstImage = (await check(200, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/png',bytes:imageWithMetadata })).data.category;
    assert.match(firstImage.image, /\/api\/categories\/\d+\/image\?v=/);
    assert.deepEqual((await check(200, imageUrl, {host:publicHost})).raw, categoryImage);
    assert.equal((await check(200, imageUrl, {host:publicHost,method:'HEAD'})).headers['content-type'], 'image/png');
    const jpegFile = path.join(tmp, 'category.jpg');
    const jpegResult = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=#62587e:s=400x320:d=0.1','-frames:v','1','-y',jpegFile], {encoding:'utf8'});
    if (jpegResult.status !== 0) throw new Error(`JPEG fixture failed: ${jpegResult.stderr || jpegResult.error}`);
    const jpegImage = await fs.readFile(jpegFile);
    const jpegSecret = Buffer.concat([Buffer.from('Exif\0\0'),secretMarker]);
    const jpegHeader = Buffer.from([0xff, 0xe1, 0, jpegSecret.length + 2]);
    const jpegWithMetadata = Buffer.concat([jpegImage.subarray(0,2),jpegHeader,jpegSecret,jpegImage.subarray(2)]);
    const cleanJpeg = sanitizeImage(jpegImage, 'image/jpeg');
    assert.deepEqual(sanitizeImage(jpegWithMetadata,'image/jpeg'), cleanJpeg);
    await check(200, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/jpeg',bytes:jpegImage });
    assert.deepEqual((await check(200, imageUrl, {host:publicHost})).raw, cleanJpeg);
    const webpFile = path.join(tmp, 'category.webp');
    const webpResult = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=#62587e:s=400x320:d=0.1','-frames:v','1','-c:v','libwebp','-y',webpFile], {encoding:'utf8'});
    if (webpResult.status !== 0) throw new Error(`WebP fixture failed: ${webpResult.stderr || webpResult.error}`);
    const webpImage = await fs.readFile(webpFile);
    const extended = Buffer.alloc(10);
    extended[0] = 0x08; // EXIF chunk present.
    extended[4] = 399 & 255; extended[5] = 399 >>> 8;
    extended[7] = 319 & 255; extended[8] = 319 >>> 8;
    const webpWithMetadata = Buffer.concat([webpImage.subarray(0,12),webpChunk('VP8X',extended),webpImage.subarray(12),webpChunk('EXIF',secretMarker)]);
    webpWithMetadata.writeUInt32LE(webpWithMetadata.length - 8, 4);
    const cleanWebp = sanitizeImage(webpWithMetadata, 'image/webp');
    assert.equal(cleanWebp.includes(secretMarker), false);
    const cleanWebpFile = path.join(tmp, 'clean.webp');
    await fs.writeFile(cleanWebpFile, cleanWebp);
    const decodeWebp = spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-i',cleanWebpFile,'-f','null','-'],{encoding:'utf8'});
    assert.equal(decodeWebp.status,0,`Sanitized WebP must still decode: ${decodeWebp.stderr}`);
    await check(200, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/webp',bytes:webpWithMetadata });
    assert.deepEqual((await check(200, imageUrl, {host:publicHost})).raw, cleanWebp);
    const firstImageName = new URL(firstImage.image, 'http://localhost').searchParams.get('v');
    const secondImage = (await check(200, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'PUT',mime:'image/png',bytes:categoryImage })).data.category;
    assert.notEqual(secondImage.image, firstImage.image);
    await assert.rejects(() => fs.access(path.join(serverEnv.DATA_DIR, 'category-images', firstImageName)), /ENOENT/);
    assert.equal((await check(200, '/api/catalog', {host:publicHost})).data.categories.find(item => item.id === imageCategory.id).image, secondImage.image);
    await check(403, '/api/admin/videos', { ...auth, method: 'POST', json: { title: 'Bad' }, origin: `http://${publicHost}:${port}` });
    await check(403, '/api/admin/categories', { ...auth, method: 'POST',json:{name:'Injected'},fetchSite:'same-site',origin:`http://${adminHost}:${port}` });
    await check(403, '/api/admin/categories', { ...auth, method: 'POST',json:{name:'Injected'},fetchSite:'same-origin',origin:null });
    await check(201, '/api/admin/categories', { ...auth, method:'POST',json:{name:'Origin tested'},fetchSite:'same-origin',origin:`http://${adminHost}:${port}` });
    await check(400, '/api/admin/settings', { ...auth, method: 'PATCH', json: null });
    await check(400, '/api/admin/categories', { ...auth, method: 'POST', json: { name: 'Trending' } });
    await check(400, '/api/admin/videos', { ...auth, method: 'POST', json: { title: 'Bad tags', category: 'Cinematic', tags: ['<script>'] } });
    await check(400, '/api/admin/videos', { ...auth, method: 'POST', json: { title: 'Too many tags', category: 'Cinematic', tags: Array(9).fill('cinematic') } });
    const created = await check(201, '/api/admin/videos', { ...auth, method: 'POST', json: { title: '100% AURA', category: 'Cinematic', duration: 0.5, tags: ['Ambient', 'Cinematic', 'ambient'] } });
    const id = created.data.item.id;
    assert.deepEqual(created.data.item.tags, ['Ambient','Cinematic']);
    await check(404, `/api/videos/${id}/related`, {host:publicHost});
    await check(404, '/api/reports', { host:publicHost, method:'POST', json:{ videoId:id } });
    await check(409, `/api/admin/videos/${id}/publish`, { ...auth, method: 'PATCH', json: { published: true } });
    await check(415, `/api/admin/videos/${id}/file`, { ...auth, method: 'PUT', bytes: Buffer.from('<html>bad</html>'), mime: 'video/mp4' });
    await check(415, `/api/admin/videos/${id}/file`, { ...auth, method: 'PUT', bytes: webm, mime: 'video/mp4' });
    await check(413, `/api/admin/videos/${id}/file`, { ...auth, method: 'PUT', bytes: Buffer.alloc(1024 * 1024 + 1), mime: 'video/mp4' });
    assert.deepEqual((await fs.readdir(path.join(tmp, 'videos'))), []);
    await check(200, `/api/admin/videos/${id}/file`, { ...auth, method: 'PUT', bytes: mp4, mime: 'video/mp4' });
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.storageBytes, mp4.length);
    // Hold a replacement mid-stream; conflicting changes must not remove its row/file.
    let uploadRequest;
    const uploading = new Promise((resolve, reject) => {
      uploadRequest = http.request({ host:'127.0.0.1', port, path:`/api/admin/videos/${id}/file`, method:'PUT', headers:{ Host:`${adminHost}:${port}`, Origin:`http://${adminHost}:${port}`, Cookie:cookie, 'Content-Type':'video/mp4', 'Content-Length':mp4.length } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      uploadRequest.on('error', reject);
      uploadRequest.write(mp4.subarray(0, 16));
    });
    let inProgress = false;
    for (let n=0; n<80; n++) {
      if ((await fs.readdir(serverEnv.VIDEO_DIR)).some(name => name.endsWith('.part'))) { inProgress = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    try {
      assert.ok(inProgress, 'Partial upload started');
      await check(409, `/api/admin/videos/${id}`, { ...auth, method:'DELETE' });
      await check(409, `/api/admin/videos/${id}/publish`, { ...auth, method:'PATCH', json:{published:true} });
    } finally { uploadRequest.end(mp4.subarray(16)); }
    assert.equal(await uploading, 200);
    const storage = (await check(200, '/api/admin/storage-check', auth)).data;
    assert.deepEqual(storage.missing, []); assert.equal(storage.unreferencedFiles, 0);
    assert.deepEqual(storage.missingCategoryImages, []); assert.equal(storage.unreferencedCategoryImages, 0);
    await check(401, `/api/admin/videos/${id}/file`);
    assert.equal((await check(206, `/api/admin/videos/${id}/file`, { ...auth, range: 'bytes=0-11' })).raw.toString('ascii', 4, 8), 'ftyp');
    await check(404, `/api/videos/${id}/file`, { host: publicHost });
    await check(400, '/api/admin/settings', { ...auth, method: 'PATCH', json: { featuredVideoId: String(id) } });
    await check(200, `/api/admin/videos/${id}/publish`, { ...auth, method: 'PATCH', json: { published: true } });
    await check(400, '/api/admin/settings', { ...auth, method: 'PATCH', json: { contactEmail: 'not-an-email' } });
    await check(200, '/api/admin/settings', { ...auth, method: 'PATCH', json: { siteName: 'NOVA & Co', tagline: 'Curated <calm> videos', featuredVideoId: String(id), announcement: 'New release', contactEmail: 'contact@example.test' } });
    const catalog = await check(200, '/api/catalog?page=1', { host: publicHost });
    assert.equal(catalog.data.featuredVideo.id, id);
    assert.equal(catalog.data.featuredVideo.s, 'NOVA & Co');
    assert.equal(catalog.data.settings.siteName, 'NOVA & Co');
    assert.equal(catalog.data.settings.tagline, 'Curated <calm> videos');
    assert.equal(catalog.data.settings.announcement, 'New release');
    assert.equal(catalog.data.settings.contactEmail, 'contact@example.test');
    assert.equal((await check(200, '/api/settings', { host: publicHost })).data.settings.siteName, 'NOVA & Co');
    const home = await check(200, '/', { host: publicHost });
    const homeHTML = home.raw.toString();
    assert.match(homeHTML, /<title>NOVA &amp; Co — Curated<\/title>/);
    assert.match(homeHTML, /<meta name="description" content="NOVA &amp; Co — Curated &lt;calm&gt; videos">/);
    assert.match(homeHTML, /About NOVA &amp; Co/);
    assert.match(homeHTML, /class="age-brand">NOVA &amp; Co<\/span>/);
    assert.match(homeHTML, /id="siteTaglineText" >Curated &lt;calm&gt; videos<\/p>/);
    assert.ok(homeHTML.includes(`<div class="desc">${require('../package.json').version}</div>`));
    assert.doesNotMatch(homeHTML, /__SITE_(?:NAME|DESCRIPTION|TAGLINE|VERSION)__/);
    assert.deepEqual((await check(200, '/index.html', { host: adminHost })).raw, home.raw);
    const homeHead = await check(200, '/', { host: publicHost, method: 'HEAD' });
    assert.equal(homeHead.raw.length, 0);
    assert.equal(homeHead.headers['content-length'], String(home.raw.length));
    const appManifest = await check(200, '/manifest.webmanifest', { host: publicHost });
    const appDetails = JSON.parse(appManifest.raw.toString());
    assert.equal(appDetails.name, 'NOVA & Co — Curated');
    assert.equal(appDetails.short_name, 'NOVA & Co');
    assert.equal(appDetails.description, 'Curated <calm> videos');
    assert.equal((await check(200, '/manifest.webmanifest', { host: publicHost, method: 'HEAD' })).headers['content-length'], String(appManifest.raw.length));
    const requestBody = {videoId:id,reason:'privacy',name:'Concerned viewer',email:'viewer@example.test',details:'This video may reveal someone without permission. Please review it.'};
    await check(404, '/api/reports', {method:'POST',json:requestBody});
    await check(403, '/api/reports', {host:publicHost,method:'POST',json:requestBody,origin:`http://${adminHost}:${port}`});
    await check(400, '/api/reports', {host:publicHost,method:'POST',json:{...requestBody,reason:'invalid'}});
    await check(400, '/api/reports', {host:publicHost,method:'POST',json:{...requestBody,details:'short'}});
    const removal = await check(201, '/api/reports', {host:publicHost,method:'POST',json:requestBody});
    assert.match(removal.data.reference, /^AUR-\d+$/);
    const duplicate = await check(200, '/api/reports', {host:publicHost,method:'POST',json:requestBody});
    assert.equal(duplicate.data.reference, removal.data.reference);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.openReports, 1);
    const reportId = Number(removal.data.reference.slice(4));
    const inbox = (await check(200, '/api/admin/reports?status=new&page=1', auth)).data;
    assert.equal(inbox.pagination.total, 1);
    assert.equal(inbox.reports[0].reporter_email, requestBody.email);
    await check(400, '/api/admin/reports?status=fake', auth);
    await check(401, `/api/admin/reports/${reportId}`, {method:'PATCH',json:{status:'reviewing',note:'Reviewing details'}});
    await check(400, `/api/admin/reports/${reportId}`, { ...auth,method:'PATCH',json:{status:'resolved',note:''} });
    await check(200, `/api/admin/reports/${reportId}`, { ...auth,method:'PATCH',json:{status:'reviewing',note:'Reviewing details'} });
    assert.equal((await check(200, '/api/admin/reports?status=reviewing', auth)).data.pagination.total, 1);
    const firstRange = await check(206, `/api/videos/${id}/file`, { host: publicHost, range: 'bytes=0-11' });
    assert.equal(firstRange.raw.length, 12);
    assert.equal(firstRange.headers['cache-control'], 'private, no-cache');
    const oldTag = firstRange.headers.etag;
    await check(304, `/api/videos/${id}/file`, { host: publicHost, etag: oldTag });
    assert.equal((await check(200, `/api/videos/${id}/file`, { host: publicHost, range: 'bytes=0-11', ifRange: '"stale"' })).raw.length, mp4.length);
    await check(416, `/api/videos/${id}/file`, { host: publicHost, range: 'bytes=999999-' });
    assert.equal((await check(200, `/api/videos/${id}/file`, { host: publicHost, method: 'HEAD' })).headers['content-length'], String(mp4.length));
    await check(200, `/api/videos/${id}/file`, { host: publicHost });
    await check(200, `/api/admin/videos/${id}/file`, { ...auth, method: 'PUT', bytes: mp4, mime: 'video/mp4' });
    const replacement = await check(206, `/api/videos/${id}/file`, { host: publicHost, range: 'bytes=0-11' });
    assert.notEqual(replacement.headers.etag, oldTag);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.views, 0);
    const played = await check(200, `/api/videos/${id}/view`, { host: publicHost, method: 'POST', json: {} });
    const viewerCookie = played.headers['set-cookie'][0].split(';')[0];
    await check(200, `/api/videos/${id}/view`, { host: publicHost, method: 'POST', json: {}, cookie: viewerCookie });
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.views, 1);

    // Exercise both formats, server pages, literal search, draft privacy, and deletion.
    let secondId;
    for (let n = 2; n <= 26; n++) {
      const item = (await check(201, '/api/admin/videos', { ...auth, method: 'POST', json: { title: `Release ${n}`, category: 'Cinematic', duration: 0.5, ...(n === 2 ? {tags:['ambient']} : {}) } })).data.item;
      if (n === 2) secondId = item.id;
      const isWebm = n === 2;
      await check(200, `/api/admin/videos/${item.id}/file`, { ...auth, method: 'PUT', bytes: isWebm ? webm : mp4, mime: isWebm ? 'video/webm' : 'video/mp4' });
      if (isWebm) assert.deepEqual((await check(206, `/api/admin/videos/${item.id}/file`, { ...auth, range: 'bytes=0-3' })).raw, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      await check(200, `/api/admin/videos/${item.id}/publish`, { ...auth, method: 'PATCH', json: { published: true } });
    }
    assert.equal((await check(200, '/api/catalog?page=1', { host: publicHost })).data.videos.length, 24);
    const page2 = (await check(200, '/api/catalog?page=2', { host: publicHost })).data;
    assert.equal(page2.videos.length, 2); assert.equal(page2.pagination.hasMore, false);
    assert.equal((await check(200, '/api/catalog?q=ambient', {host:publicHost})).data.pagination.total, 2);
    const related = (await check(200, `/api/videos/${id}/related`, {host:publicHost})).data.videos;
    assert.equal(related[0].id, secondId, 'Tag match is recommended ahead of other videos even beyond the first page');
    assert.equal(related.every(video => video.status === 'live' && video.id !== id), true);
    await check(404, '/api/admin/video-collections', {host:publicHost});
    await check(401, '/api/admin/video-collections');
    await check(400, '/api/admin/video-collections', {...auth,method:'POST',json:{title:''}});
    const videoCollection = (await check(201, '/api/admin/video-collections', {...auth,method:'POST',json:{title:'Starter picks',description:'Watch in order'}})).data.collection;
    const videoCollectionURL = `/api/video-collections/${videoCollection.id}`;
    await check(404, videoCollectionURL, {host:publicHost});
    await check(409, `/api/admin/video-collections/${videoCollection.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    await check(401, `/api/admin/video-collections/${videoCollection.id}/videos`, {method:'PUT',json:{videoIds:[id]}});
    await check(400, `/api/admin/video-collections/${videoCollection.id}/videos`, {...auth,method:'PUT',json:{videoIds:[id,id]}});
    await check(400, `/api/admin/video-collections/${videoCollection.id}/videos`, {...auth,method:'PUT',json:{videoIds:[999999]}});
    await check(200, `/api/admin/video-collections/${videoCollection.id}/videos`, {...auth,method:'PUT',json:{videoIds:[id,secondId]}});
    await check(200, `/api/admin/video-collections/${videoCollection.id}`, {...auth,method:'PATCH',json:{title:'Starter picks updated',description:'Two clips'}});
    await check(404, videoCollectionURL, {host:publicHost});
    await check(200, `/api/admin/video-collections/${videoCollection.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    assert.deepEqual((await check(200, videoCollectionURL, {host:publicHost})).data.collection.videos.map(item => item.id), [id,secondId]);
    assert.equal((await check(200, '/api/video-collections?page=1', {host:publicHost})).data.collections[0].count, 2);
    const collectionVisit = await check(200, `${videoCollectionURL}/view`, {host:publicHost,method:'POST',json:{}});
    const collectionCookie = collectionVisit.headers['set-cookie'][0].split(';')[0];
    assert.equal(collectionVisit.data.views, 1);
    assert.equal((await check(200, `${videoCollectionURL}/view`, {host:publicHost,method:'POST',json:{},cookie:collectionCookie})).data.views, 1);
    await check(404, `${videoCollectionURL}/view`, {method:'POST',json:{}});
    await check(200, `/api/admin/video-collections/${videoCollection.id}/videos`, {...auth,method:'PUT',json:{videoIds:[secondId,id]}});
    assert.deepEqual((await check(200, videoCollectionURL, {host:publicHost})).data.collection.videos.map(item => item.id), [secondId,id]);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.videoCollectionViews, 1);
    await check(200, `/api/admin/video-collections/${videoCollection.id}/publish`, {...auth,method:'PATCH',json:{published:false}});
    await check(404, `${videoCollectionURL}/view`, {host:publicHost,method:'POST',json:{},cookie:collectionCookie});
    await check(200, `/api/admin/video-collections/${videoCollection.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    await check(400, `/api/admin/videos/${secondId}`, { ...auth, method:'PATCH', json:{title:'Edited release', category:'Cinematic', duration:0.5, tags:['a','bad<tag>']} });
    assert.equal((await check(200, '/api/catalog?q=%25', { host: publicHost })).data.pagination.total, 1);
    assert.equal((await check(200, '/api/catalog?q=Release&category=VR', { host: publicHost })).data.pagination.total, 0);
    await check(200, `/api/admin/videos/${secondId}`, { ...auth, method: 'PATCH', json: { title: 'Edited release', category: 'Cinematic', duration: 0.5 } });
    assert.deepEqual((await check(200, '/api/admin/overview', auth)).data.videos.find(video => video.id === secondId).tags, ['ambient']);
    assert.equal((await check(200, '/api/catalog?sort=new', { host: publicHost })).data.videos[0].t, 'Release 26');
    const category = (await check(200, '/api/admin/overview', auth)).data.categories.find(item => item.n === 'Cinematic');
    await check(200, `/api/admin/categories/${category.id}`, { ...auth, method: 'PATCH', json: { name: 'Film' } });
    assert.equal((await check(200, '/api/catalog?category=Film', { host: publicHost })).data.pagination.total, 26);
    await check(200, `/api/admin/categories/${category.id}`, { ...auth, method: 'PATCH', json: { name: 'Cinematic' } });
    await check(401, `/api/admin/reports/${reportId}/unpublish`, {method:'POST',json:{note:'Issue checked with publisher'} });
    await check(400, `/api/admin/reports/${reportId}/unpublish`, { ...auth,method:'POST',json:{note:''} });
    await check(200, `/api/admin/reports/${reportId}/unpublish`, { ...auth,method:'POST',json:{note:'Content hidden pending consent review'} });
    assert.equal((await check(200, '/api/admin/reports?status=resolved', auth)).data.reports[0].video_status, 'private');
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.openReports, 0);
    await check(404, `/api/videos/${id}/file`, {host:publicHost});
    await check(404, '/api/reports', {host:publicHost,method:'POST',json:requestBody});
    await check(200, `/api/admin/videos/${id}`, { ...auth, method: 'DELETE' });
    assert.deepEqual((await check(200, videoCollectionURL, {host:publicHost})).data.collection.videos.map(item => item.id), [secondId]);
    assert.equal((await check(200, '/api/catalog', { host: publicHost })).data.featuredVideo, null);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.settings.featuredVideoId, '');
    await check(200, '/api/admin/settings', { ...auth, method:'PATCH', json:{ tagline:'', announcement:'', contactEmail:'', featuredVideoId:'' } });
    const clearedSettings = (await check(200, '/api/settings', { host:publicHost })).data.settings;
    assert.equal(clearedSettings.tagline, '');
    assert.equal(clearedSettings.announcement, '');
    assert.equal(clearedSettings.contactEmail, '');
    assert.equal(clearedSettings.featuredVideoId, '');
    assert.match((await check(200, '/', { host:publicHost })).raw.toString(), /id="siteTaglineText" hidden><\/p>/);
    assert.equal(JSON.parse((await check(200, '/manifest.webmanifest', { host:publicHost })).raw.toString()).description, 'NOVA & Co — Curated videos and photos');
    await check(404, `/api/videos/${id}/file`, { host: publicHost });
    const retainedReport = (await check(200, '/api/admin/reports?status=resolved', auth)).data.reports[0];
    assert.equal(retainedReport.video_id, null);
    assert.equal(retainedReport.original_video_id, id);
    // Collections have separate admin media, published public URLs, and private drafts.
    await check(404, '/api/admin/galleries', {host:publicHost});
    await check(401, '/api/admin/galleries');
    await check(400, '/api/admin/galleries', {...auth,method:'POST',json:{title:''}});
    const gallery = (await check(201, '/api/admin/galleries', {...auth,method:'POST',json:{title:'Photo story',description:'A small gallery'}})).data.gallery;
    const galleryUrl = `/api/galleries/${gallery.id}`;
    await check(409, `/api/admin/galleries/${gallery.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    await check(404, galleryUrl, {host:publicHost});
    await check(401, `/api/admin/galleries/${gallery.id}/images`, {method:'PUT',mime:'image/png',bytes:categoryImage});
    await check(415, `/api/admin/galleries/${gallery.id}/images`, {...auth,method:'PUT',mime:'image/svg+xml',bytes:categoryImage});
    await check(415, `/api/admin/galleries/${gallery.id}/images`, {...auth,method:'PUT',mime:'image/png',bytes:Buffer.from('fake image')});
    const uploadedGallery = (await check(201, `/api/admin/galleries/${gallery.id}/images`, {...auth,method:'PUT',mime:'image/png',bytes:categoryImage})).data.gallery;
    const firstPhoto = uploadedGallery.images[0];
    await check(404, `/api/galleries/${gallery.id}/images/${firstPhoto.id}/file`, {host:publicHost});
    await check(401, firstPhoto.src);
    assert.deepEqual((await check(200, firstPhoto.src, auth)).raw, categoryImage);
    await check(201, `/api/admin/galleries/${gallery.id}/images`, {...auth,method:'PUT',mime:'image/jpeg',bytes:jpegWithMetadata});
    await check(200, `/api/admin/galleries/${gallery.id}`, {...auth,method:'PATCH',json:{title:'Photo story updated',description:'Two photos'}});
    await check(200, `/api/admin/galleries/${gallery.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    const publicGallery = (await check(200, galleryUrl, {host:publicHost})).data.gallery;
    assert.equal(publicGallery.count, 2);
    assert.equal(publicGallery.title, 'Photo story updated');
    assert.equal((await check(200, '/api/galleries', {host:publicHost})).data.galleries[0].cover, publicGallery.cover);
    assert.deepEqual((await check(200, publicGallery.images[0].src, {host:publicHost})).raw, categoryImage);
    const galleryVisit = await check(200, `${galleryUrl}/view`, {host:publicHost,method:'POST',json:{}});
    const galleryCookie = galleryVisit.headers['set-cookie'][0].split(';')[0];
    assert.equal(galleryVisit.data.views, 1);
    assert.equal((await check(200, `${galleryUrl}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie})).data.views, 1);
    const firstPhotoVisit = (await check(200, `/api/galleries/${gallery.id}/images/${firstPhoto.id}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie})).data;
    assert.equal(firstPhotoVisit.views, 1);
    assert.equal((await check(200, `/api/galleries/${gallery.id}/images/${firstPhoto.id}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie})).data.views, 1);
    assert.equal((await check(200, `/api/admin/galleries`, auth)).data.galleries[0].images[0].views, 1);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.galleryViews, 1);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.photoViews, 1);
    await check(404, `${galleryUrl}/view`, {method:'POST',json:{}});
    await check(200, `/api/admin/galleries/${gallery.id}/publish`, {...auth,method:'PATCH',json:{published:false}});
    await check(404, publicGallery.images[0].src, {host:publicHost});
    await check(404, `${galleryUrl}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie});
    await check(404, `/api/galleries/${gallery.id}/images/${firstPhoto.id}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie});
    await check(200, `/api/admin/galleries/${gallery.id}/images/${firstPhoto.id}`, {...auth,method:'DELETE'});
    await check(200, `/api/admin/galleries/${gallery.id}/publish`, {...auth,method:'PATCH',json:{published:true}});
    const survivingPhoto = (await check(200, galleryUrl, {host:publicHost})).data.gallery.images[0];
    assert.deepEqual((await check(200, survivingPhoto.src, {host:publicHost})).raw, cleanJpeg);
    assert.equal((await check(200, `/api/galleries/${gallery.id}/images/${survivingPhoto.id}/view`, {host:publicHost,method:'POST',json:{},cookie:galleryCookie})).data.views, 1);
    assert.deepEqual((await check(200, '/api/admin/storage-check', auth)).data.missingGalleryImages, []);
    // Full recovery round-trip includes SQLite and media, and refuses destructive restore.
    const backupPath = path.join(tmp, 'backup'), restorePath = path.join(tmp, 'restored');
    const manifest = await backup({ dataDir:serverEnv.DATA_DIR, videoDir:serverEnv.VIDEO_DIR, destination:backupPath });
    assert.equal(manifest.files.length, 28);
    await verify(backupPath);
    const restored = await restore({ source:backupPath, destination:restorePath });
    await assert.rejects(() => restore({ source:backupPath, destination:restorePath }), /EEXIST/);
    const restoredDb = new DatabaseSync(path.join(restored.dataDir, 'aura.sqlite'));
    assert.deepEqual(JSON.parse(restoredDb.prepare('SELECT tags FROM videos WHERE id=?').get(secondId).tags), ['ambient']);
    assert.equal(restoredDb.prepare('SELECT views FROM video_collections WHERE id=?').get(videoCollection.id).views, 1);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM video_collection_items WHERE collection_id=?').get(videoCollection.id).n, 1);
    assert.equal(restoredDb.prepare('SELECT views FROM galleries WHERE id=?').get(gallery.id).views, 1);
    assert.equal(restoredDb.prepare('SELECT views FROM gallery_images WHERE id=?').get(survivingPhoto.id).views, 1);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM videos').get().n, 25);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM removal_requests').get().n, 1);
    const storedVideo = restoredDb.prepare('SELECT file_path FROM videos LIMIT 1').get().file_path;
    const storedImage = restoredDb.prepare('SELECT image_path FROM categories WHERE id=?').get(imageCategory.id).image_path;
    const storedGalleryImage = restoredDb.prepare('SELECT file_path FROM gallery_images WHERE gallery_id=?').get(gallery.id).file_path;
    restoredDb.close();
    assert.deepEqual(await fs.readFile(path.join(restored.videoDir, storedVideo)), await fs.readFile(path.join(serverEnv.VIDEO_DIR, storedVideo)));
    assert.deepEqual(await fs.readFile(path.join(restored.dataDir, 'category-images', storedImage)), categoryImage);
    assert.deepEqual(await fs.readFile(path.join(restored.dataDir, 'gallery-images', storedGalleryImage)), cleanJpeg);
    await check(200, `/api/admin/video-collections/${videoCollection.id}/videos`, {...auth,method:'PUT',json:{videoIds:[]}});
    await check(404, videoCollectionURL, {host:publicHost});
    await check(404, `${videoCollectionURL}/view`, {host:publicHost,method:'POST',json:{},cookie:collectionCookie});
    await check(200, `/api/admin/video-collections/${videoCollection.id}`, {...auth,method:'DELETE'});
    assert.equal((await check(200, `/api/catalog?ids=${secondId}`, {host:publicHost})).data.videos.length, 1);
    const liveGalleryImage = path.join(serverEnv.DATA_DIR, 'gallery-images', storedGalleryImage);
    await fs.rename(liveGalleryImage, `${liveGalleryImage}.hidden`);
    assert.equal((await check(200, '/api/admin/storage-check', auth)).data.missingGalleryImages.length, 1);
    await fs.rename(`${liveGalleryImage}.hidden`, liveGalleryImage);
    await check(200, `/api/admin/galleries/${gallery.id}/images/${survivingPhoto.id}`, {...auth,method:'DELETE'});
    assert.equal((await check(200, `/api/admin/galleries`, auth)).data.galleries[0].status, 'draft');
    await check(404, galleryUrl, {host:publicHost});
    await check(200, `/api/admin/galleries/${gallery.id}`, {...auth,method:'DELETE'});
    const liveImage = path.join(serverEnv.DATA_DIR, 'category-images', storedImage);
    await fs.rename(liveImage, `${liveImage}.hidden`);
    assert.equal((await check(200, '/api/admin/storage-check', auth)).data.missingCategoryImages.length, 1);
    await fs.rename(`${liveImage}.hidden`, liveImage);
    await check(200, `/api/admin/categories/${imageCategory.id}/image`, { ...auth,method:'DELETE' });
    await check(404, imageUrl, {host:publicHost});
    await check(200, `/api/admin/categories/${imageCategory.id}`, { ...auth,method:'DELETE' });
    const mediaRecord = manifest.files.find(file => file.path.startsWith('videos/'));
    await fs.appendFile(path.join(backupPath, mediaRecord.path), 'damage');
    await assert.rejects(() => verify(backupPath), /checksum mismatch/);
    await assert.rejects(() => restore({ source:backupPath, destination:path.join(tmp, 'bad-restore') }), /checksum mismatch/);
    await assert.rejects(() => fs.access(path.join(tmp, 'bad-restore')), /ENOENT/);
    const liveFile = path.join(serverEnv.VIDEO_DIR, storedVideo);
    await fs.rename(liveFile, `${liveFile}.hidden`);
    const missing = (await check(200, '/api/admin/storage-check', auth)).data;
    assert.equal(missing.missing.length, 1);
    await assert.rejects(() => backup({ dataDir:serverEnv.DATA_DIR, videoDir:serverEnv.VIDEO_DIR, destination:path.join(tmp, 'incomplete') }), /ENOENT/);
    await assert.rejects(() => fs.access(path.join(tmp, 'incomplete')), /ENOENT/);
    await fs.rename(`${liveFile}.hidden`, liveFile);
    const wrongLogin = {email:'owner@example.test',password:'incorrect-password'};
    for (let attempt=0; attempt<10; attempt++) await check(401, '/api/admin/login', {method:'POST',json:wrongLogin,forwarded:'203.0.113.10'});
    await check(429, '/api/admin/login', {method:'POST',json:{...wrongLogin,password:serverEnv.ADMIN_PASSWORD},forwarded:'203.0.113.10'});
    await check(200, '/api/admin/login', {method:'POST',json:{...wrongLogin,password:serverEnv.ADMIN_PASSWORD},forwarded:'203.0.113.11'});
    processHandle.kill('SIGTERM');
    await new Promise(resolve => processHandle.once('exit', resolve));
    // Simulate an existing installation created before the publication-date column.
    const legacyDb = new DatabaseSync(path.join(tmp, 'db', 'aura.sqlite'));
    legacyDb.exec('DROP INDEX IF EXISTS videos_published_idx; ALTER TABLE videos DROP COLUMN published_at; ALTER TABLE videos DROP COLUMN tags; ALTER TABLE galleries DROP COLUMN views; ALTER TABLE gallery_images DROP COLUMN views');
    legacyDb.close();
    startServer();
    let restarted = false;
    for (let i = 0; i < 80; i++) {
      try { restarted = (await request('/api/health')).status === 200; if (restarted) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(restarted, `Server did not restart: ${logs.join('')}`);
    await check(200, '/api/admin/overview', auth);
    assert.equal((await check(200, '/api/admin/overview', auth)).data.stats.galleryViews, 0);
    assert.equal((await check(200, '/api/settings', { host:publicHost })).data.settings.siteName, 'NOVA & Co');
    assert.equal((await check(200, '/api/settings', { host:publicHost })).data.settings.adWatchMobileZone, '456789');
    assert.match((await check(200, '/', { host:publicHost })).raw.toString(), /<title>NOVA &amp; Co — Curated<\/title>/);
    assert.equal((await check(200, '/api/catalog', { host: publicHost })).data.pagination.total, 25);
    processHandle.kill('SIGTERM');
    await new Promise(resolve => processHandle.once('exit', resolve));
    serverEnv.ADMIN_EMAIL = 'new-owner@example.test';
    serverEnv.ADMIN_PASSWORD = 'a-different-strong-password-2026';
    startServer();
    for (let i = 0; i < 80; i++) {
      try { if ((await request('/api/health')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await check(401, '/api/admin/overview', auth);
    await check(401, '/api/admin/login', { method: 'POST', json: { email: 'owner@example.test', password: 'a-strong-test-password-2026' } });
    const newLogin = await check(200, '/api/admin/login', { method: 'POST', json: { email: 'new-owner@example.test', password: 'a-different-strong-password-2026' } });
    const newAuth = { cookie: newLogin.headers['set-cookie'][0].split(';')[0] };
    await check(200, '/api/admin/overview', newAuth);
    await check(200, '/api/admin/logout', { ...newAuth, method: 'POST', json: {} });
    await check(401, '/api/admin/overview', auth);
    processHandle.kill('SIGTERM');
    await new Promise(resolve => processHandle.once('exit', resolve));
    serverEnv.DATA_DIR = restored.dataDir;
    serverEnv.VIDEO_DIR = restored.videoDir;
    startServer();
    let restoredReady = false;
    for (let i=0; i<80; i++) {
      try { restoredReady = (await request('/api/health')).status === 200; if (restoredReady) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(restoredReady, 'Restored server starts');
    await check(401, '/api/admin/overview', auth);
    const restoredLogin = await check(200, '/api/admin/login', { method:'POST', json:{email:serverEnv.ADMIN_EMAIL, password:serverEnv.ADMIN_PASSWORD} });
    const restoredAuth = { cookie:restoredLogin.headers['set-cookie'][0].split(';')[0] };
    assert.deepEqual((await check(200, '/api/admin/storage-check', restoredAuth)).data.missing, []);
    assert.equal((await check(200, '/api/admin/reports?status=resolved', restoredAuth)).data.reports[0].original_video_id, id);
    assert.equal((await check(200, '/api/catalog', { host:publicHost })).data.pagination.total, 25);
    await check(206, `/api/videos/${secondId}/file`, { host:publicHost, range:'bytes=0-11' });
    processHandle.kill('SIGTERM');
    await new Promise(resolve => processHandle.once('exit', resolve));
    const legacyImage = path.join(restored.dataDir, 'gallery-images', storedGalleryImage);
    await fs.writeFile(legacyImage, jpegWithMetadata);
    const cleanupEnv = {...serverEnv, DATA_DIR:restored.dataDir};
    const previewCleanup = spawnSync(process.execPath, [path.join(root,'scripts/sanitize-existing-images.js'),'--check'],{cwd:root,env:cleanupEnv,encoding:'utf8'});
    assert.equal(previewCleanup.status,0,previewCleanup.stderr);
    assert.match(previewCleanup.stdout,/1 need cleaning/);
    const applyCleanup = spawnSync(process.execPath, [path.join(root,'scripts/sanitize-existing-images.js'),'--apply'],{cwd:root,env:cleanupEnv,encoding:'utf8'});
    assert.equal(applyCleanup.status,0,applyCleanup.stderr);
    assert.deepEqual(await fs.readFile(legacyImage),cleanJpeg);
    const verifiedDb = new DatabaseSync(path.join(restored.dataDir,'aura.sqlite'));
    assert.equal(verifiedDb.prepare('SELECT file_size FROM gallery_images WHERE file_path=?').get(storedGalleryImage).file_size,cleanJpeg.length);
    verifiedDb.close();
    console.log('Smoke checks passed: admin isolation, origin controls, metadata cleanup, video collection order/publishing/deletion, photo collection/image view counts and privacy, video uploads/previews, storage health, removal requests, media streaming, filtering/pagination, backup/restore/checksums, and legacy DB migration.');
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill('SIGTERM');
      await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
