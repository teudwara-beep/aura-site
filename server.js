'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { sanitizeImage } = require('./lib/image-sanitize');

const ROOT = __dirname;
const SITE_VERSION = require('./package.json').version;
loadEnv(path.join(ROOT, '.env'));
const PORT = numberEnv('PORT', 4180, 1, 65535);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');
// Keep admin sign-in on its own hostname during local development too.
const ADMIN_HOST_RAW = String(process.env.ADMIN_HOST || (NODE_ENV === 'development' ? 'admin.localhost' : '')).trim();
const ADMIN_HOST = normalizeHost(ADMIN_HOST_RAW);
const MAX_UPLOAD_BYTES = numberEnv('MAX_UPLOAD_MB', 2048, 1, 8192) * 1024 * 1024;
// Large admin uploads regularly exceed Node's five-minute request timeout.
const REQUEST_TIMEOUT_MINUTES = numberEnv('REQUEST_TIMEOUT_MINUTES', 60, 5, 240);
const DATA_DIR = resolveFromRoot(process.env.DATA_DIR || './data');
const VIDEO_DIR = resolveFromRoot(process.env.VIDEO_DIR || './storage/videos');
const BUNNY_LIBRARY_ID = String(process.env.BUNNY_LIBRARY_ID || '').trim();
const BUNNY_STREAM_API_KEY = String(process.env.BUNNY_STREAM_API_KEY || '').trim();
const BUNNY_TOKEN_KEY = String(process.env.BUNNY_TOKEN_KEY || '').trim();
const BUNNY_PULL_ZONE = String(process.env.BUNNY_PULL_ZONE || '').trim().toLowerCase();
const BUNNY_ENABLED = Boolean(BUNNY_LIBRARY_ID || BUNNY_STREAM_API_KEY || BUNNY_TOKEN_KEY);
if (BUNNY_ENABLED && (!/^\d+$/.test(BUNNY_LIBRARY_ID) || !BUNNY_STREAM_API_KEY || !BUNNY_TOKEN_KEY || (BUNNY_PULL_ZONE && !/^[a-z0-9-]+\.b-cdn\.net$/.test(BUNNY_PULL_ZONE)))) {
  console.error('Bunny setup: provide BUNNY_LIBRARY_ID, BUNNY_STREAM_API_KEY, BUNNY_TOKEN_KEY, and an optional BUNNY_PULL_ZONE (*.b-cdn.net).');
  process.exit(1);
}
const CATEGORY_IMAGE_DIR = path.join(DATA_DIR, 'category-images');
const MAX_CATEGORY_IMAGE_BYTES = 3 * 1024 * 1024;
const GALLERY_IMAGE_DIR = path.join(DATA_DIR, 'gallery-images');
const MAX_GALLERY_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GALLERY_IMAGES = 100;
const DB_PATH = path.join(DATA_DIR, 'aura.sqlite');
const SESSION_COOKIE = NODE_ENV === 'production' ? '__Host-aura_admin' : 'aura_admin';
const PUBLIC_PAGE_SIZE = 24;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();
const recentViews = new Map();
const videoMutations = new Set();
const categoryMutations = new Set();
const galleryMutations = new Set();
const videoCollectionMutations = new Set();
const reportAttempts = new Map();
const VIEW_WINDOW_MS = 30 * 60 * 1000;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const REPORT_MAX_PER_IP = 8;
// Only trust the forwarding header when the proxy connects over loopback.
const REPORT_TRUST_PROXY = process.env.REPORT_TRUST_PROXY === '1';

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL) || ADMIN_PASSWORD.length < 12 || ADMIN_PASSWORD.startsWith('change-this-') || SESSION_SECRET.length < 32 || SESSION_SECRET.startsWith('replace-with-') || (ADMIN_HOST_RAW && !ADMIN_HOST) || (NODE_ENV === 'production' && (!ADMIN_HOST || ADMIN_HOST_RAW.includes(':')))) {
  console.error('Setup required: set a valid ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), SESSION_SECRET (32+ characters), and ADMIN_HOST (for production, e.g. admin.example.com).');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(CATEGORY_IMAGE_DIR, { recursive: true });
fs.mkdirSync(GALLERY_IMAGE_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    image_path TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'Auto',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','private','live')),
    views INTEGER NOT NULL DEFAULT 0,
    seed INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    file_mime TEXT,
    file_size INTEGER,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bunny_uploads (
    video_id INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    guid TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS videos_public_idx ON videos(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS videos_public_trending_idx ON videos(status, views DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS videos_public_category_idx ON videos(status, category, updated_at DESC);
  CREATE TABLE IF NOT EXISTS galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','live')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS gallery_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    alt_text TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','live')),
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS video_collection_items (
    collection_id INTEGER NOT NULL REFERENCES video_collections(id) ON DELETE CASCADE,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY(collection_id,video_id)
  );
  CREATE INDEX IF NOT EXISTS video_collections_public_idx ON video_collections(status,published_at DESC);
  CREATE INDEX IF NOT EXISTS video_collection_items_order_idx ON video_collection_items(collection_id,position);
  CREATE INDEX IF NOT EXISTS galleries_public_idx ON galleries(status,published_at DESC);
  CREATE INDEX IF NOT EXISTS gallery_images_order_idx ON gallery_images(gallery_id,position,id);
  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS removal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
    original_video_id INTEGER NOT NULL,
    video_title TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('copyright','privacy','safety','other')),
    reporter_name TEXT NOT NULL,
    reporter_email TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','resolved','declined')),
    admin_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS removal_requests_queue_idx ON removal_requests(status,created_at DESC);
  CREATE INDEX IF NOT EXISTS removal_requests_email_idx ON removal_requests(reporter_email,created_at DESC);
`);
if (!db.prepare('PRAGMA table_info(videos)').all().some(column => column.name === 'published_at')) db.exec('ALTER TABLE videos ADD COLUMN published_at INTEGER');
if (!db.prepare('PRAGMA table_info(videos)').all().some(column => column.name === 'tags')) db.exec("ALTER TABLE videos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
if (!db.prepare('PRAGMA table_info(categories)').all().some(column => column.name === 'image_path')) db.exec('ALTER TABLE categories ADD COLUMN image_path TEXT');
if (!db.prepare('PRAGMA table_info(galleries)').all().some(column => column.name === 'views')) db.exec('ALTER TABLE galleries ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
if (!db.prepare('PRAGMA table_info(gallery_images)').all().some(column => column.name === 'views')) db.exec('ALTER TABLE gallery_images ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
db.exec("UPDATE videos SET published_at=updated_at WHERE status='live' AND published_at IS NULL; CREATE INDEX IF NOT EXISTS videos_published_idx ON videos(status,published_at DESC);");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const index = value.indexOf('=');
    if (index < 1) continue;
    const key = value.slice(0, index).trim();
    const parsed = value.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = parsed;
  }
}
function resolveFromRoot(value) { return path.resolve(ROOT, value); }
function normalizeHost(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s/@?#]/.test(raw)) return '';
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.hostname.toLowerCase();
  } catch { return ''; }
}
function isAdminHost(req) { return Boolean(ADMIN_HOST && normalizeHost(req.headers.host) === ADMIN_HOST); }
function reportClientIP(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
  if (!loopback) return remote || 'unknown';
  if (REPORT_TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
    if (isIP(forwarded)) return forwarded;
  }
  // Without a trusted forwarded address, a production loopback proxy shares
  // one socket address across viewers. The email quota still applies.
  return NODE_ENV === 'production' ? null : remote;
}
function numberEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  return value;
}
function passwordHash(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function digest(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function sendJSON(res, status, body) {
  const output = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': output.length, 'Cache-Control': 'no-store' });
  res.end(output);
}
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function cookie(res, name, value, age) {
  const secure = NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}${secure}`);
}
const sql = {
  adminByEmail: db.prepare('SELECT * FROM admins WHERE email=?'),
  addAdmin: db.prepare('INSERT INTO admins(id,email,password_hash,created_at) VALUES(?,?,?,?)'),
  updateAdminPassword: db.prepare('UPDATE admins SET password_hash=? WHERE id=?'),
  session: db.prepare('SELECT a.id,a.email,s.expires_at FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=?'),
  addSession: db.prepare('INSERT INTO sessions(token_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
  categories: db.prepare('SELECT id,name,sort_order,image_path FROM categories ORDER BY sort_order,name COLLATE NOCASE'),
  categoryById: db.prepare('SELECT * FROM categories WHERE id=?'),
  addCategory: db.prepare('INSERT INTO categories(name,sort_order,created_at) VALUES(?,?,?)'),
  updateCategory: db.prepare('UPDATE categories SET name=? WHERE id=?'),
  setCategoryImage: db.prepare('UPDATE categories SET image_path=? WHERE id=?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE id=?'),
  gallery: db.prepare('SELECT * FROM galleries WHERE id=?'),
  publicGalleries: db.prepare("SELECT * FROM galleries WHERE status='live' AND EXISTS (SELECT 1 FROM gallery_images WHERE gallery_id=galleries.id) ORDER BY published_at DESC,id DESC LIMIT ? OFFSET ?"),
  countPublicGalleries: db.prepare("SELECT COUNT(*) AS n FROM galleries WHERE status='live' AND EXISTS (SELECT 1 FROM gallery_images WHERE gallery_id=galleries.id)"),
  adminGalleries: db.prepare('SELECT * FROM galleries ORDER BY updated_at DESC,id DESC'),
  galleryImages: db.prepare('SELECT * FROM gallery_images WHERE gallery_id=? ORDER BY position,id'),
  galleryImage: db.prepare('SELECT * FROM gallery_images WHERE id=? AND gallery_id=?'),
  galleryImageCount: db.prepare('SELECT COUNT(*) AS n FROM gallery_images WHERE gallery_id=?'),
  createGallery: db.prepare('INSERT INTO galleries(title,description,created_at,updated_at) VALUES(?,?,?,?)'),
  editGallery: db.prepare('UPDATE galleries SET title=?,description=?,updated_at=? WHERE id=?'),
  publishGallery: db.prepare("UPDATE galleries SET status=?,published_at=CASE WHEN ?='live' AND status!='live' THEN ? ELSE published_at END,updated_at=? WHERE id=?"),
  addGalleryImage: db.prepare('INSERT INTO gallery_images(gallery_id,file_path,file_size,alt_text,position,created_at) VALUES(?,?,?,?,?,?)'),
  deleteGalleryImage: db.prepare('DELETE FROM gallery_images WHERE id=? AND gallery_id=?'),
  deleteGallery: db.prepare('DELETE FROM galleries WHERE id=?'),
  incrementGalleryViews: db.prepare("UPDATE galleries SET views=views+1 WHERE id=? AND status='live'"),
  incrementGalleryImageViews: db.prepare('UPDATE gallery_images SET views=views+1 WHERE id=? AND gallery_id=?'),
  videoCollection: db.prepare('SELECT * FROM video_collections WHERE id=?'),
  publicVideoCollections: db.prepare("SELECT * FROM video_collections WHERE status='live' AND EXISTS (SELECT 1 FROM video_collection_items i JOIN videos v ON v.id=i.video_id WHERE i.collection_id=video_collections.id AND v.status='live' AND v.file_path IS NOT NULL) ORDER BY published_at DESC,id DESC LIMIT ? OFFSET ?"),
  countPublicVideoCollections: db.prepare("SELECT COUNT(*) AS n FROM video_collections WHERE status='live' AND EXISTS (SELECT 1 FROM video_collection_items i JOIN videos v ON v.id=i.video_id WHERE i.collection_id=video_collections.id AND v.status='live' AND v.file_path IS NOT NULL)"),
  adminVideoCollections: db.prepare('SELECT * FROM video_collections ORDER BY updated_at DESC,id DESC'),
  videoCollectionItems: db.prepare('SELECT v.* FROM video_collection_items i JOIN videos v ON v.id=i.video_id WHERE i.collection_id=? ORDER BY i.position,i.video_id'),
  createVideoCollection: db.prepare('INSERT INTO video_collections(title,description,created_at,updated_at) VALUES(?,?,?,?)'),
  editVideoCollection: db.prepare('UPDATE video_collections SET title=?,description=?,updated_at=? WHERE id=?'),
  publishVideoCollection: db.prepare("UPDATE video_collections SET status=?,published_at=CASE WHEN ?='live' AND status!='live' THEN ? ELSE published_at END,updated_at=? WHERE id=?"),
  deleteVideoCollectionItems: db.prepare('DELETE FROM video_collection_items WHERE collection_id=?'),
  addVideoCollectionItem: db.prepare('INSERT INTO video_collection_items(collection_id,video_id,position) VALUES(?,?,?)'),
  touchVideoCollection: db.prepare('UPDATE video_collections SET updated_at=? WHERE id=?'),
  deleteVideoCollection: db.prepare('DELETE FROM video_collections WHERE id=?'),
  incrementVideoCollectionViews: db.prepare("UPDATE video_collections SET views=views+1 WHERE id=? AND status='live'"),
  randomVideo: db.prepare("SELECT * FROM videos WHERE status='live' AND file_path IS NOT NULL ORDER BY RANDOM() LIMIT 1"),
  publicVideoById: db.prepare("SELECT * FROM videos WHERE id=? AND status='live' AND file_path IS NOT NULL"),
  publicVideoPage: db.prepare(`SELECT * FROM videos
    WHERE status='live' AND file_path IS NOT NULL
      AND (?='' OR title LIKE ? ESCAPE '^' OR category LIKE ? ESCAPE '^' OR EXISTS (SELECT 1 FROM json_each(videos.tags) AS tag WHERE tag.value LIKE ? ESCAPE '^'))
      AND (?='' OR category=?)
    ORDER BY CASE WHEN ?='trending' THEN views END DESC,
      CASE WHEN ?='new' THEN COALESCE(published_at,updated_at) END DESC,
      COALESCE(published_at,updated_at) DESC, id DESC
    LIMIT ? OFFSET ?`),
  publicVideoCount: db.prepare(`SELECT COUNT(*) AS count FROM videos
    WHERE status='live' AND file_path IS NOT NULL
      AND (?='' OR title LIKE ? ESCAPE '^' OR category LIKE ? ESCAPE '^' OR EXISTS (SELECT 1 FROM json_each(videos.tags) AS tag WHERE tag.value LIKE ? ESCAPE '^'))
      AND (?='' OR category=?)`),
  publicRelated: db.prepare("SELECT * FROM videos WHERE status='live' AND file_path IS NOT NULL AND id<>?"),
  adminVideos: db.prepare('SELECT * FROM videos ORDER BY updated_at DESC'),
  video: db.prepare('SELECT * FROM videos WHERE id=?'),
  createVideo: db.prepare('INSERT INTO videos(title,description,category,duration,quality,tags,status,seed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
  updateVideo: db.prepare('UPDATE videos SET title=?,description=?,category=?,duration=?,quality=?,tags=?,updated_at=? WHERE id=?'),
  publish: db.prepare("UPDATE videos SET status=?,updated_at=?,published_at=CASE WHEN ?='live' AND status!='live' THEN ? ELSE published_at END WHERE id=?"),
  setFile: db.prepare('UPDATE videos SET file_path=?,file_mime=?,file_size=?,duration=CASE WHEN ?>0 THEN ? ELSE duration END,updated_at=? WHERE id=?'),
  deleteVideo: db.prepare('DELETE FROM videos WHERE id=?'),
  incrementViews: db.prepare('UPDATE videos SET views=views+1 WHERE id=?'),
  setting: db.prepare('SELECT value FROM site_settings WHERE key=?'),
  setSetting: db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  countViews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM videos'),
  countGalleryViews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM galleries'),
  countPhotoViews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM gallery_images'),
  countVideoCollectionViews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM video_collections'),
  countStoredBytes: db.prepare('SELECT COALESCE(SUM(file_size),0) AS count FROM videos WHERE file_path IS NOT NULL'),
  countPublished: db.prepare("SELECT COUNT(*) AS count FROM videos WHERE status='live'"),
  countDrafts: db.prepare("SELECT COUNT(*) AS count FROM videos WHERE status!='live'"),
  countOpenReports: db.prepare("SELECT COUNT(*) AS count FROM removal_requests WHERE status IN ('new','reviewing')"),
  reports: db.prepare(`SELECT * FROM removal_requests WHERE (?='all' OR status=?)
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, created_at DESC LIMIT 20 OFFSET ?`),
  reportCount: db.prepare("SELECT COUNT(*) AS count FROM removal_requests WHERE (?='all' OR status=?)"),
  report: db.prepare('SELECT * FROM removal_requests WHERE id=?'),
  addReport: db.prepare(`INSERT INTO removal_requests(video_id,original_video_id,video_title,reason,reporter_name,reporter_email,details,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`),
  duplicateReport: db.prepare(`SELECT id FROM removal_requests WHERE original_video_id=? AND reporter_email=? AND reason=?
    AND status IN ('new','reviewing') AND created_at>? ORDER BY id DESC LIMIT 1`),
  recentEmailReports: db.prepare('SELECT COUNT(*) AS count FROM removal_requests WHERE reporter_email=? AND created_at>?'),
  updateReport: db.prepare('UPDATE removal_requests SET status=?,admin_note=?,updated_at=? WHERE id=?')
};
const now = Date.now();
let admin = sql.adminByEmail.get(ADMIN_EMAIL);
if (!admin) {
  admin = { id: `admin-${crypto.randomUUID()}`, email: ADMIN_EMAIL };
  sql.addAdmin.run(admin.id, ADMIN_EMAIL, passwordHash(ADMIN_PASSWORD), now);
} else {
  if (!verifyPassword(ADMIN_PASSWORD, admin.password_hash)) {
    sql.updateAdminPassword.run(passwordHash(ADMIN_PASSWORD), admin.id);
    db.prepare('DELETE FROM sessions WHERE admin_id=?').run(admin.id);
  }
}
db.prepare('DELETE FROM admins WHERE id<>?').run(admin.id);
if (!sql.categories.all().length) {
  ['Cinematic', 'Romantic', 'Amateur', 'Solo', 'Couples', 'VR'].forEach((name, index) => sql.addCategory.run(name, index, now));
}
const defaultSettings = {
  siteName: 'AURA', tagline: 'A curated video experience', announcement: '', featuredVideoId: '', contactEmail: '',
  adHomeEnabled: '0', adHomeDesktopZone: '', adHomeMobileZone: '',
  adWatchEnabled: '0', adWatchDesktopZone: '', adWatchMobileZone: ''
};
const insertDefaultSetting = db.prepare('INSERT OR IGNORE INTO site_settings(key,value) VALUES(?,?)');
for (const [key, value] of Object.entries(defaultSettings)) insertDefaultSetting.run(key, value);

function currentAdmin(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = digest(token);
  const session = sql.session.get(tokenHash);
  if (!session || session.expires_at <= Date.now()) { sql.deleteSession.run(tokenHash); return null; }
  return { id: session.id, email: session.email };
}
function requireAdmin(req) { const adminUser = currentAdmin(req); if (!adminUser) throw httpError(401, 'Admin sign-in required.'); return adminUser; }
function checkOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  // A sibling subdomain is same-site but must not change admin state.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw httpError(403, 'Cross-origin request blocked.');
  const origin = req.headers.origin;
  if (!origin && req.url.startsWith('/api/admin/')) throw httpError(403, 'Request origin required.');
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw httpError(403, 'Invalid request origin.'); }
  if (parsed.host !== req.headers.host || parsed.protocol !== (NODE_ENV === 'production' ? 'https:' : 'http:')) throw httpError(403, 'Cross-origin request blocked.');
}
async function readJSON(req, maxBytes = 128 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Request body must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, 'Request body must be a JSON object.');
  return parsed;
}
function videoId(value) {
  if (!/^\d{1,12}$/.test(String(value))) throw httpError(400, 'Invalid video ID.');
  return Number(value);
}
function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 8) throw httpError(400, 'Add up to 8 tags per video.');
  const result = [], seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') throw httpError(400, 'Tags must be text.');
    const tag = entry.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!tag || tag.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _-]*$/u.test(tag))
      throw httpError(400, 'Tags must be 1–32 letters or numbers; spaces, - and _ are allowed.');
    const normalized = tag.toLocaleLowerCase('und');
    if (!seen.has(normalized)) { seen.add(normalized); result.push(tag); }
  }
  return result;
}
function videoTags(row) {
  try { const tags = JSON.parse(row.tags || '[]'); return Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : []; }
  catch { return []; }
}
function relatedVideos(video) {
  const tags = new Set(videoTags(video).map(tag => tag.toLocaleLowerCase('und')));
  const now = Date.now();
  return sql.publicRelated.all(video.id).map(row => {
    const shared = videoTags(row).filter(tag => tags.has(tag.toLocaleLowerCase('und'))).length;
    const sameCategory = row.category === video.category ? 1 : 0;
    const ageDays = Math.max(0, (now - (row.published_at || row.updated_at)) / 86400000);
    return { row, score: shared * 20 + sameCategory * 5 + 1 / (1 + ageDays / 30) + Math.log1p(Math.max(0, row.views)) * .08 };
  }).sort((a,b) => b.score - a.score || (b.row.published_at || b.row.updated_at) - (a.row.published_at || a.row.updated_at) || b.row.id - a.row.id)
    .slice(0, 8).map(candidate => mapVideo(candidate.row));
}
function normalizeVideo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Invalid video details.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const categoryInput = typeof input.category === 'string' ? input.category.trim() : '';
  const duration = Number(input.duration) || 0;
  const quality = ['Auto', '720p', '1080p', '4K'].includes(input.quality) ? input.quality : 'Auto';
  if (!title || title.length > 160) throw httpError(400, 'Title must be 1 to 160 characters.');
  const categoryRow = sql.categories.all().find(row => row.name.toLowerCase() === categoryInput.toLowerCase());
  if (!categoryRow) throw httpError(400, 'Choose an existing category.');
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400) throw httpError(400, 'Video duration is invalid.');
  return { title, category: categoryRow.name, duration, quality, description: String(input.description || '').trim().slice(0, 5000),
    tags: Object.hasOwn(input, 'tags') ? normalizeTags(input.tags) : undefined };
}
function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return minutes < 2 ? 'just now' : `${minutes} minutes ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hours ago`;
  const days = Math.floor(minutes / 1440);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
function mapVideo(row) {
  const isUploaded = Boolean(row.file_path);
  const bunnyGuid = bunnyVideoId(row.file_path);
  return {
    id: row.id, t: row.title, s: getSettings().siteName || 'AURA', c: row.category, d: formatTime(row.duration), duration: row.duration,
    v: row.views, age: timeAgo(row.status === 'live' ? (row.published_at || row.updated_at) : row.updated_at), seed: row.seed, status: row.status, quality: row.quality,
    description: row.description, tags: videoTags(row), uploaded: isUploaded, hasFile: isUploaded, bunny: Boolean(bunnyGuid),
    bunnyPreview: bunnyGuid && BUNNY_PULL_ZONE ? `https://${BUNNY_PULL_ZONE}/${bunnyGuid}/preview_hq.mp4` : null,
    bunnyThumbnail: bunnyGuid && BUNNY_PULL_ZONE ? `https://${BUNNY_PULL_ZONE}/${bunnyGuid}/thumbnail.jpg` : null,
    live: false, vr: false
  };
}
function bunnyVideoId(filePath) {
  const match = /^bunny:([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(filePath || '');
  return match?.[1] || null;
}
async function bunnyAPI(method, suffix, body) {
  if (!BUNNY_ENABLED) throw httpError(503, 'Bunny Stream is not configured.');
  let response;
  try {
    response = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos${suffix}`, {
      method, headers: { AccessKey:BUNNY_STREAM_API_KEY, Accept:'application/json', ...(body ? {'Content-Type':'application/json'} : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
    });
  } catch { throw httpError(503, 'Bunny Stream is unreachable. Try again.'); }
  if (!response.ok) {
    if (response.status === 404 && method === 'DELETE') return null;
    if (response.status === 404) throw httpError(409, 'Video is missing from Bunny Stream. Replace its file.');
    throw httpError(503, `Bunny Stream request failed (${response.status}). Try again.`);
  }
  return method === 'DELETE' || response.status === 204 ? null : response.json();
}
function bunnyEmbedUrl(guid) {
  if (!BUNNY_ENABLED) throw httpError(503, 'Configure Bunny Stream to play this video.');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = crypto.createHash('sha256').update(`${BUNNY_TOKEN_KEY}${guid}${expires}`).digest('hex');
  return `https://player.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${guid}?token=${token}&expires=${expires}&autoplay=false`;
}
async function playableVideo(row) {
  const guid = bunnyVideoId(row.file_path);
  if (guid) {
    const remote = await bunnyAPI('GET', `/${guid}`);
    // Bunny status 4 = all output resolutions finished encoding.
    if (remote.status !== 4) throw httpError(409, 'Bunny is still processing this video. Retry publishing when encoding finishes.');
    return true;
  }
  try { await fsp.access(path.join(VIDEO_DIR, row.file_path)); return true; }
  catch { throw httpError(409, 'The uploaded video file is missing. Replace it before publishing.'); }
}
async function removeStoredVideo(row) {
  if (!row.file_path) return;
  const guid = bunnyVideoId(row.file_path);
  if (guid) return bunnyAPI('DELETE', `/${guid}`);
  await fsp.unlink(path.join(VIDEO_DIR, row.file_path)).catch(error => {
    if (error.code !== 'ENOENT') throw httpError(503, 'Could not delete the video file. Check storage permissions and retry.');
  });
}
function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function mapCategory(row) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE category=? AND status=\'live\' AND file_path IS NOT NULL').get(row.name).n;
  return { id: row.id, n: row.name, c: count, seed: row.id % 12,
    image: categoryImageName(row.image_path) ? `/api/categories/${row.id}/image?v=${encodeURIComponent(row.image_path)}` : null };
}
function categoryImageName(filename) { return /^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(filename || '') ? filename : null; }
function categoryImageMime(filename) { return filename.endsWith('.jpg') ? 'image/jpeg' : filename.endsWith('.png') ? 'image/png' : 'image/webp'; }
async function readImage(req, maxBytes, label) {
  const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw httpError(415, 'Use a JPG, PNG or WebP image.');
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw httpError(413, `${label} must be ${maxBytes / 1048576} MB or smaller.`);
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw httpError(413, `${label} must be ${maxBytes / 1048576} MB or smaller.`);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  const valid = mime === 'image/jpeg' ? data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : mime === 'image/png' ? data.length > 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR'
    : data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw httpError(415, 'This file is not a valid JPG, PNG or WebP image.');
  let clean;
  try { clean = sanitizeImage(data, mime); }
  catch { throw httpError(415, 'Image could not be verified. Save it again as JPG, PNG or WebP.'); }
  return { data: clean, ext: mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp' };
}
function readCategoryImage(req) { return readImage(req, MAX_CATEGORY_IMAGE_BYTES, 'Category images'); }
function safeGalleryDetails(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!title || title.length > 120) throw httpError(400, 'Collection title must be 1 to 120 characters.');
  if (description.length > 1000) throw httpError(400, 'Collection description must be under 1000 characters.');
  return { title, description };
}
function mapGallery(row, admin = false) {
  const images = sql.galleryImages.all(row.id);
  const photo = image => ({ id:image.id, alt:image.alt_text, views:image.views,
    src:`${admin ? '/api/admin' : '/api'}/galleries/${row.id}/images/${image.id}/file` });
  return { id:row.id, title:row.title, description:row.description, status:admin ? row.status : undefined,
    count:images.length, views:row.views, cover:images.length ? photo(images[0]).src : null,
    images:images.map(photo) };
}
function mapVideoCollection(row, admin = false, includeVideos = true) {
  const all = sql.videoCollectionItems.all(row.id);
  const available = all.filter(video => video.status === 'live' && video.file_path);
  const videos = admin ? all : available;
  return { id:row.id, title:row.title, description:row.description, status:admin ? row.status : undefined,
    views:row.views, count:videos.length, availableCount:admin ? available.length : undefined,
    coverVideoId:available[0]?.id || null, videos:includeVideos ? videos.map(mapVideo) : undefined };
}
function recordViewerView(req, res, key, increment) {
  // The same viewer cookie is used for videos and collections, with separate keys.
  let viewer = cookieValue(req, 'aura_viewer');
  if (!/^[A-Za-z0-9_-]{22}$/.test(viewer)) {
    viewer = crypto.randomBytes(16).toString('base64url');
    cookie(res, 'aura_viewer', viewer, 365 * 24 * 60 * 60);
  }
  const hashedKey = `${key}:${digest(viewer)}`;
  const last = recentViews.get(hashedKey) || 0;
  if (Date.now() - last >= VIEW_WINDOW_MS) { increment(); recentViews.set(hashedKey, Date.now()); }
}
async function streamGalleryImage(req, res, row) {
  const name = categoryImageName(row?.file_path);
  if (!name) throw httpError(404, 'Image not found.');
  const file = path.join(GALLERY_IMAGE_DIR, name);
  let stat;
  try { stat = await fsp.stat(file); } catch { throw httpError(404, 'Image not found.'); }
  res.writeHead(200, { 'Content-Type':categoryImageMime(name), 'Content-Length':stat.size,
    'Cache-Control':'private, no-store' });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res);
}
function getSettings() {
  const settings = { ...defaultSettings };
  for (const key of Object.keys(settings)) settings[key] = sql.setting.get(key)?.value ?? settings[key];
  return settings;
}
function safeSettings(input) {
  const current = getSettings();
  const next = { ...current };
  if (typeof input.siteName === 'string') next.siteName = input.siteName.trim().slice(0, 60) || 'AURA';
  if (typeof input.tagline === 'string') next.tagline = input.tagline.trim().slice(0, 160);
  if (typeof input.announcement === 'string') next.announcement = input.announcement.trim().slice(0, 300);
  if (typeof input.contactEmail === 'string') {
    const email = input.contactEmail.trim().toLowerCase();
    if (email && (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) throw httpError(400, 'Enter a valid contact email.');
    next.contactEmail = email;
  }
  if (Object.hasOwn(input, 'featuredVideoId')) {
    if (input.featuredVideoId === '' || input.featuredVideoId == null) next.featuredVideoId = '';
    else if (Number.isInteger(Number(input.featuredVideoId)) && sql.publicVideoById.get(Number(input.featuredVideoId))) next.featuredVideoId = String(Number(input.featuredVideoId));
    else throw httpError(400, 'Choose a valid featured video.');
  }
  for (const placement of ['Home', 'Watch']) {
    const enabledKey = `ad${placement}Enabled`;
    if (Object.hasOwn(input, enabledKey)) {
      if (typeof input[enabledKey] !== 'boolean') throw httpError(400, 'Ad placement must be on or off.');
      next[enabledKey] = input[enabledKey] ? '1' : '0';
    }
    for (const device of ['Desktop', 'Mobile']) {
      const zoneKey = `ad${placement}${device}Zone`;
      if (Object.hasOwn(input, zoneKey)) {
        if (typeof input[zoneKey] !== 'string' || !/^\d{0,15}$/.test(input[zoneKey].trim())) throw httpError(400, 'Use a numeric ExoClick zone ID (up to 15 digits).');
        next[zoneKey] = input[zoneKey].trim();
      }
    }
    if (next[enabledKey] === '1' && !next[`ad${placement}DesktopZone`] && !next[`ad${placement}MobileZone`])
      throw httpError(400, `${placement} ads need at least one zone ID before being enabled.`);
  }
  return next;
}
function safeCategoryName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[<>\u0000-\u001f]/.test(name)) throw httpError(400, 'Category name must be 1 to 80 characters.');
  if (['all', 'trending', 'new'].includes(name.toLowerCase())) throw httpError(400, 'Choose a category name other than All, Trending, or New.');
  return name;
}
function escapeHTML(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
async function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'Method not allowed.');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw httpError(400, 'Invalid path.'); }
  const publicFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/css/styles.css', 'css/styles.css'], ['/js/app.js', 'js/app.js'], ['/assets/favicon.svg', 'assets/favicon.svg'], ['/manifest.webmanifest', 'manifest.webmanifest']]);
  const relative = publicFiles.get(decoded);
  if (!relative) throw httpError(404, 'Not found.');
  const filename = path.join(ROOT, relative);
  let stat;
  try { stat = await fsp.stat(filename); } catch { throw httpError(404, 'Not found.'); }
  if (!stat.isFile()) throw httpError(404, 'Not found.');
  if (relative === 'index.html') {
    const {siteName, tagline} = getSettings();
    const name = siteName || 'AURA';
    const values = {
      SITE_NAME: escapeHTML(name),
      SITE_DESCRIPTION: escapeHTML(`${name} — ${tagline || 'Curated videos and photos'}`),
      SITE_TAGLINE: escapeHTML(tagline),
      TAGLINE_VISIBILITY: tagline ? '' : 'hidden',
      SITE_VERSION: escapeHTML(SITE_VERSION)
    };
    const html = (await fsp.readFile(filename, 'utf8')).replace(/__(SITE_NAME|SITE_DESCRIPTION|SITE_TAGLINE|TAGLINE_VISIBILITY|SITE_VERSION)__/g, (_, key) => values[key]);
    const output = Buffer.from(html);
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Content-Length':output.length, 'Cache-Control':'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : output);
  }
  if (relative === 'manifest.webmanifest') {
    const {siteName, tagline} = getSettings();
    const name = siteName || 'AURA';
    const manifest = JSON.parse(await fsp.readFile(filename, 'utf8'));
    manifest.name = `${name} — Curated`;
    manifest.short_name = name;
    manifest.description = tagline || `${name} — Curated videos and photos`;
    const output = Buffer.from(JSON.stringify(manifest));
    res.writeHead(200, { 'Content-Type':'application/manifest+json; charset=utf-8', 'Content-Length':output.length, 'Cache-Control':'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : output);
  }
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const ext = path.extname(filename).toLowerCase();
  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': ['.html', '.css', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=3600' });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(filename), res);
}
async function validateVideoFile(filename, mime) {
  const handle = await fsp.open(filename, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const isMp4 = bytesRead >= 12 && header.readUInt32BE(0) >= 12 && header.toString('ascii', 4, 8) === 'ftyp';
    const isWebm = bytesRead >= 16 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && header.toString('ascii', 0, bytesRead).includes('webm');
    if (mime === 'video/mp4' ? !isMp4 : !isWebm) throw httpError(415, 'This file is not a valid MP4 or WebM container.');
  } finally { await handle.close(); }
}
async function saveVideo(req, res, row) {
  const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const ext = mime === 'video/mp4' ? '.mp4' : mime === 'video/webm' ? '.webm' : '';
  if (!ext) throw httpError(415, 'Use an MP4 or WebM video file.');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) throw httpError(413, `Video is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  const filename = `${crypto.randomUUID()}${ext}`;
  const finalPath = path.join(VIDEO_DIR, filename), tempPath = `${finalPath}.part`;
  let total = 0;
  let committed = false;
  const meter = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total > MAX_UPLOAD_BYTES ? httpError(413, 'Video is above the configured upload limit.') : null, chunk);
  } });
  try {
    await pipeline(req, meter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (!total) throw httpError(400, 'The video file is empty.');
    await validateVideoFile(tempPath, mime);
    await fsp.rename(tempPath, finalPath);
    sql.setFile.run(filename, mime, total, 0, 0, Date.now(), row.id);
    committed = true;
    if (row.file_path) await removeStoredVideo(row).catch(error => console.error('Could not remove replaced media:', error.message));
    sendJSON(res, 200, { item: mapVideo(sql.video.get(row.id)) });
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    if (!committed) await fsp.unlink(finalPath).catch(() => {});
    throw error;
  }
}
async function streamVideo(req, res, row) {
  if (!row.file_path) throw httpError(404, 'Video file is not available.');
  if (bunnyVideoId(row.file_path)) throw httpError(404, 'Use the Bunny player for this video.');
  const filename = path.join(VIDEO_DIR, row.file_path);
  let stat;
  try { stat = await fsp.stat(filename); } catch { throw httpError(404, 'Video file is missing.'); }
  const etag = `"${row.file_path}-${stat.size}"`;
  const base = { 'Accept-Ranges': 'bytes', 'Content-Type': row.file_mime || 'application/octet-stream', 'Cache-Control': 'private, no-cache', ETag: etag };
  const range = req.headers['if-range'] && req.headers['if-range'] !== etag ? null : req.headers.range;
  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' });
    return res.end();
  }
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(filename), res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : NaN, end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start)) { const suffix = end; if (!suffix) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); } start = Math.max(0, stat.size - suffix); end = stat.size - 1; }
  else if (Number.isNaN(end)) end = stat.size - 1;
  if (start < 0 || end < start || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(filename, { start, end }), res);
}

const cleanup = setInterval(() => {
  try { sql.deleteExpiredSessions.run(Date.now()); } catch {}
  for (const [key, time] of recentViews) if (Date.now() - time >= VIEW_WINDOW_MS) recentViews.delete(key);
  for (const [ip, times] of loginAttempts) if (times.every(time => Date.now() - time >= LOGIN_WINDOW_MS)) loginAttempts.delete(ip);
  for (const [ip, times] of reportAttempts) if (times.every(time => Date.now() - time >= REPORT_WINDOW_MS)) reportAttempts.delete(ip);
}, 60 * 60 * 1000);
cleanup.unref();

const server = http.createServer(async (req, res) => {
  let lockedVideo = null;
  let lockedCategory = null;
  let lockedGallery = null;
  let lockedVideoCollection = null;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const adSettings = getSettings();
  const adsActive = !isAdminHost(req) && ['Home', 'Watch'].some(placement => adSettings[`ad${placement}Enabled`] === '1' &&
    (adSettings[`ad${placement}DesktopZone`] || adSettings[`ad${placement}MobileZone`]));
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${BUNNY_ENABLED ? ' https://assets.mediadelivery.net' : ''}${adsActive ? ' https://a.magsrv.com' : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' https: blob:; connect-src 'self'${BUNNY_ENABLED ? ' https://video.bunnycdn.com' : ''}${adsActive ? ' https:' : ''}; frame-src https://player.mediadelivery.net${adsActive ? ' https:' : ''}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`);
  try {
    checkOrigin(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (ADMIN_HOST && pathname.startsWith('/api/admin/') && !isAdminHost(req)) throw httpError(404, 'Not found.');
    const mutation = pathname.match(/^\/api\/admin\/videos\/(\d+)(?:\/file|\/publish)?$/);
    if (mutation && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(mutation[1]);
      if (videoMutations.has(id)) throw httpError(409, 'This video is being updated. Wait for the current operation to finish.');
      videoMutations.add(id);
      lockedVideo = id;
    }
    const categoryMutation = pathname.match(/^\/api\/admin\/categories\/(\d+)(?:\/image)?$/);
    if (categoryMutation && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(categoryMutation[1]);
      if (categoryMutations.has(id)) throw httpError(409, 'This category is being updated. Try again shortly.');
      categoryMutations.add(id);
      lockedCategory = id;
    }
    const galleryMutation = pathname.match(/^\/api\/admin\/galleries\/(\d+)(?:\/publish|\/images(?:\/\d+)?)?$/);
    if (galleryMutation && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(galleryMutation[1]);
      if (galleryMutations.has(id)) throw httpError(409, 'This collection is being updated. Try again shortly.');
      galleryMutations.add(id);
      lockedGallery = id;
    }
    const videoCollectionMutation = pathname.match(/^\/api\/admin\/video-collections\/(\d+)(?:\/publish|\/videos)?$/);
    if (videoCollectionMutation && ['PUT','PATCH','DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(videoCollectionMutation[1]);
      if (videoCollectionMutations.has(id)) throw httpError(409, 'This collection is being updated. Try again shortly.');
      videoCollectionMutations.add(id);
      lockedVideoCollection = id;
    }

    if (pathname === '/runtime-config.js' && ['GET', 'HEAD'].includes(req.method)) {
      const config = { separateAdmin: Boolean(ADMIN_HOST), isAdminHost: isAdminHost(req), maxUploadMB: MAX_UPLOAD_BYTES / 1024 / 1024, bunnyEnabled: BUNNY_ENABLED };
      const output = Buffer.from(`window.AURA_RUNTIME=Object.freeze(${JSON.stringify(config)});document.documentElement.classList.toggle('admin-host',window.AURA_RUNTIME.isAdminHost);document.documentElement.classList.toggle('admin-separated',window.AURA_RUNTIME.separateAdmin&&!window.AURA_RUNTIME.isAdminHost);`);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': output.length, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return res.end(output);
    }

    if (pathname === '/api/health' && req.method === 'GET') return sendJSON(res, 200, { ok: true, service: 'aura' });
    if (pathname === '/api/reports' && req.method === 'POST') {
      if (isAdminHost(req)) throw httpError(404, 'Not found.');
      const ip = reportClientIP(req);
      const attempts = ip ? (reportAttempts.get(ip) || []).filter(time => Date.now() - time < REPORT_WINDOW_MS) : [];
      if (ip && attempts.length >= REPORT_MAX_PER_IP) throw httpError(429, 'Too many requests from this connection. Try again later or use the site contact email.');
      if (ip) { attempts.push(Date.now()); reportAttempts.set(ip, attempts); }
      const body = await readJSON(req, 8 * 1024);
      const id = videoId(body.videoId), video = sql.publicVideoById.get(id);
      if (!video) throw httpError(404, 'This published video is no longer available. Use the site contact email if you need to report an older link.');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const details = typeof body.details === 'string' ? body.details.trim() : '';
      if (!['copyright','privacy','safety','other'].includes(body.reason)) throw httpError(400, 'Choose a reason for the request.');
      if (name.length < 2 || name.length > 120) throw httpError(400, 'Enter your name (2 to 120 characters).');
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
      if (details.length < 20 || details.length > 4000) throw httpError(400, 'Describe the issue in 20 to 4000 characters.');
      const timestamp = Date.now();
      const duplicate = sql.duplicateReport.get(id, email, body.reason, timestamp - 24 * REPORT_WINDOW_MS);
      if (duplicate) return sendJSON(res, 200, { ok:true, reference:`AUR-${duplicate.id}` });
      if (sql.recentEmailReports.get(email, timestamp - 24 * REPORT_WINDOW_MS).count >= 3) throw httpError(429, 'Too many requests for this email today. Use the site contact email for urgent issues.');
      const result = sql.addReport.run(id, id, video.title, body.reason, name, email, details, timestamp, timestamp);
      return sendJSON(res, 201, { ok:true, reference:`AUR-${result.lastInsertRowid}` });
    }
    if (pathname === '/api/admin/session' && req.method === 'GET') {
      const current = currentAdmin(req);
      return sendJSON(res, current ? 200 : 401, current ? { admin: { email: current.email } } : { error: 'Not signed in.' });
    }
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const ip = reportClientIP(req) || req.socket.remoteAddress || 'unknown';
      const attempts = (loginAttempts.get(ip) || []).filter(time => Date.now() - time < LOGIN_WINDOW_MS);
      if (attempts.length >= LOGIN_MAX_ATTEMPTS) throw httpError(429, 'Too many attempts. Try again later.');
      const body = await readJSON(req, 16 * 1024);
      const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
      const found = sql.adminByEmail.get(email);
      if (!found || !verifyPassword(password, found.password_hash)) {
        attempts.push(Date.now()); loginAttempts.set(ip, attempts);
        return sendJSON(res, 401, { error: 'Email or password is incorrect.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sql.addSession.run(digest(token), found.id, Date.now() + SESSION_TTL_MS, Date.now());
      cookie(res, SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { admin: { email: found.email } });
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      const token = cookieValue(req, SESSION_COOKIE);
      if (token) sql.deleteSession.run(digest(token));
      cookie(res, SESSION_COOKIE, '', 0);
      return sendJSON(res, 200, { ok: true });
    }
    const categoryImageMatch = pathname.match(/^\/api\/categories\/(\d+)\/image$/);
    if (categoryImageMatch && ['GET', 'HEAD'].includes(req.method)) {
      const category = sql.categoryById.get(videoId(categoryImageMatch[1]));
      const filename = categoryImageName(category?.image_path);
      if (!filename) throw httpError(404, 'Category image not found.');
      let stat;
      try { stat = await fsp.stat(path.join(CATEGORY_IMAGE_DIR, filename)); }
      catch { throw httpError(404, 'Category image not found.'); }
      res.writeHead(200, { 'Content-Type': categoryImageMime(filename), 'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=3600' });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(path.join(CATEGORY_IMAGE_DIR, filename)), res);
    }
    if (pathname === '/api/galleries' && req.method === 'GET') {
      const pageText = url.searchParams.get('page') || '1';
      if (!/^\d{1,6}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000) throw httpError(400, 'Page must be between 1 and 100000.');
      const page = Number(pageText), total = Number(sql.countPublicGalleries.get().n);
      return sendJSON(res, 200, { galleries:sql.publicGalleries.all(PUBLIC_PAGE_SIZE, (page-1)*PUBLIC_PAGE_SIZE).map(row => {
        const gallery = mapGallery(row); delete gallery.images; return gallery;
      }), pagination:{page,total,hasMore:page*PUBLIC_PAGE_SIZE<total} });
    }
    const publicGalleryMatch = pathname.match(/^\/api\/galleries\/(\d+)$/);
    if (publicGalleryMatch && req.method === 'GET') {
      const row = sql.gallery.get(videoId(publicGalleryMatch[1]));
      if (!row || row.status !== 'live' || !sql.galleryImageCount.get(row.id).n) throw httpError(404, 'Collection not found.');
      return sendJSON(res, 200, { gallery:mapGallery(row) });
    }
    const galleryView = pathname.match(/^\/api\/galleries\/(\d+)\/view$/);
    if (galleryView && req.method === 'POST') {
      if (isAdminHost(req)) throw httpError(404, 'Not found.');
      const id = videoId(galleryView[1]), row = sql.gallery.get(id);
      if (!row || row.status !== 'live' || !sql.galleryImageCount.get(id).n) throw httpError(404, 'Collection not found.');
      recordViewerView(req, res, `gallery:${id}`, () => sql.incrementGalleryViews.run(id));
      return sendJSON(res, 200, {ok:true,views:sql.gallery.get(id).views});
    }
    const photoView = pathname.match(/^\/api\/galleries\/(\d+)\/images\/(\d+)\/view$/);
    if (photoView && req.method === 'POST') {
      if (isAdminHost(req)) throw httpError(404, 'Not found.');
      const galleryId = videoId(photoView[1]), imageId = videoId(photoView[2]);
      if (sql.gallery.get(galleryId)?.status !== 'live' || !sql.galleryImage.get(imageId,galleryId)) throw httpError(404, 'Image not found.');
      recordViewerView(req, res, `photo:${imageId}`, () => sql.incrementGalleryImageViews.run(imageId,galleryId));
      return sendJSON(res, 200, {ok:true,views:sql.galleryImage.get(imageId,galleryId).views});
    }
    const publicGalleryImage = pathname.match(/^\/api\/galleries\/(\d+)\/images\/(\d+)\/file$/);
    if (publicGalleryImage && ['GET', 'HEAD'].includes(req.method)) {
      const id = videoId(publicGalleryImage[1]), row = sql.gallery.get(id);
      if (!row || row.status !== 'live') throw httpError(404, 'Image not found.');
      return streamGalleryImage(req, res, sql.galleryImage.get(videoId(publicGalleryImage[2]), id));
    }
    if (pathname === '/api/video-collections' && req.method === 'GET') {
      const pageText = url.searchParams.get('page') || '1';
      if (!/^\d{1,6}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000) throw httpError(400, 'Page must be between 1 and 100000.');
      const page = Number(pageText), total = Number(sql.countPublicVideoCollections.get().n);
      return sendJSON(res, 200, { collections:sql.publicVideoCollections.all(PUBLIC_PAGE_SIZE,(page-1)*PUBLIC_PAGE_SIZE).map(row => mapVideoCollection(row,false,false)), pagination:{page,total,hasMore:page*PUBLIC_PAGE_SIZE<total} });
    }
    const publicVideoCollection = pathname.match(/^\/api\/video-collections\/(\d+)$/);
    if (publicVideoCollection && req.method === 'GET') {
      const row = sql.videoCollection.get(videoId(publicVideoCollection[1]));
      if (!row || row.status !== 'live') throw httpError(404, 'Collection not found.');
      const collection = mapVideoCollection(row);
      if (!collection.count) throw httpError(404, 'Collection not found.');
      return sendJSON(res, 200, {collection});
    }
    const videoCollectionView = pathname.match(/^\/api\/video-collections\/(\d+)\/view$/);
    if (videoCollectionView && req.method === 'POST') {
      if (isAdminHost(req)) throw httpError(404, 'Not found.');
      const id = videoId(videoCollectionView[1]), row = sql.videoCollection.get(id);
      if (!row || row.status !== 'live' || !mapVideoCollection(row,false,false).count) throw httpError(404, 'Collection not found.');
      recordViewerView(req, res, `video-collection:${id}`, () => sql.incrementVideoCollectionViews.run(id));
      return sendJSON(res, 200, {ok:true,views:sql.videoCollection.get(id).views});
    }
    if (pathname === '/api/catalog' && req.method === 'GET') {
      if (url.searchParams.has('ids')) {
        const rawIds = url.searchParams.get('ids') || '';
        const idValues = rawIds ? rawIds.split(',') : [];
        if (idValues.length > 100 || idValues.some(value => !/^\d{1,12}$/.test(value))) throw httpError(400, 'Request up to 100 valid video IDs at a time.');
        const ids = [...new Set(idValues.map(Number))];
        const rows = ids.length ? db.prepare(`SELECT * FROM videos WHERE status='live' AND file_path IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
        const byId = new Map(rows.map(row => [row.id, mapVideo(row)]));
        return sendJSON(res, 200, { videos: ids.map(id => byId.get(id)).filter(Boolean) });
      }
      const pageText = url.searchParams.get('page') || '1';
      if (!/^\d{1,6}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000) throw httpError(400, 'Page must be between 1 and 100000.');
      const page = Number(pageText);
      const sort = url.searchParams.get('sort') || 'trending';
      if (!['trending', 'new'].includes(sort)) throw httpError(400, 'Sort must be trending or new.');
      const rawSearch = url.searchParams.get('q') || '';
      if (rawSearch.length > 100) throw httpError(400, 'Search is limited to 100 characters.');
      const search = rawSearch.trim();
      const rawCategory = url.searchParams.get('category') || '';
      if (rawCategory.length > 80) throw httpError(400, 'Category name is too long.');
      const category = rawCategory.trim();
      const pattern = search ? `%${search.replace(/[\^%_]/g, match => `^${match}`)}%` : '';
      const filters = [search, pattern, pattern, pattern, category, category];
      const total = Number(sql.publicVideoCount.get(...filters).count);
      const videos = sql.publicVideoPage.all(...filters, sort, sort, PUBLIC_PAGE_SIZE, (page - 1) * PUBLIC_PAGE_SIZE).map(mapVideo);
      const categories = sql.categories.all().map(mapCategory);
      const settings = getSettings();
      const featuredId = Number(settings.featuredVideoId);
      const featured = (featuredId ? sql.publicVideoById.get(featuredId) : null);
      const featuredVideo = featured ? mapVideo(featured) : null;
      return sendJSON(res, 200, {
        videos, categories, settings, featuredVideo, featuredId: featuredVideo?.id || null,
        pagination: { page, pageSize: PUBLIC_PAGE_SIZE, total, hasMore: page * PUBLIC_PAGE_SIZE < total }
      });
    }
    if (pathname === '/api/settings' && req.method === 'GET') return sendJSON(res, 200, { settings: getSettings() });
    const relatedMatch = pathname.match(/^\/api\/videos\/(\d+)\/related$/);
    if (relatedMatch && req.method === 'GET') {
      const video = sql.publicVideoById.get(videoId(relatedMatch[1]));
      if (!video) throw httpError(404, 'Video not found.');
      return sendJSON(res, 200, { videos: relatedVideos(video) });
    }
    if (pathname === '/api/videos/random' && req.method === 'GET') {
      const row = sql.randomVideo.get();
      return sendJSON(res, 200, { item: row ? mapVideo(row) : null });
    }
    const publicVideoMatch = pathname.match(/^\/api\/videos\/(\d+)\/file$/);
    if (publicVideoMatch && ['GET', 'HEAD'].includes(req.method)) {
      const row = sql.video.get(videoId(publicVideoMatch[1]));
      if (!row || row.status !== 'live' || !row.file_path) throw httpError(404, 'Video not found.');
      return await streamVideo(req, res, row);
    }
    const publicBunnyEmbed = pathname.match(/^\/api\/videos\/(\d+)\/embed$/);
    if (publicBunnyEmbed && req.method === 'GET') {
      const row = sql.publicVideoById.get(videoId(publicBunnyEmbed[1]));
      if (!row || !bunnyVideoId(row.file_path)) throw httpError(404, 'Video not found.');
      return sendJSON(res, 200, { url:bunnyEmbedUrl(bunnyVideoId(row.file_path)) });
    }
    const viewMatch = pathname.match(/^\/api\/videos\/(\d+)\/view$/);
    if (viewMatch && req.method === 'POST') {
      const id = videoId(viewMatch[1]);
      if (!sql.publicVideoById.get(id)) throw httpError(404, 'Video not found.');
      recordViewerView(req, res, `video:${id}`, () => sql.incrementViews.run(id));
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      requireAdmin(req);
      const videos = sql.adminVideos.all().map(mapVideo);
      return sendJSON(res, 200, { videos, categories: sql.categories.all().map(mapCategory), settings: getSettings(), stats: { videos: videos.length, published: Number(sql.countPublished.get().count), drafts: Number(sql.countDrafts.get().count), views: Number(sql.countViews.get().count), galleryViews: Number(sql.countGalleryViews.get().count), photoViews:Number(sql.countPhotoViews.get().count), videoCollectionViews:Number(sql.countVideoCollectionViews.get().count), storageBytes: Number(sql.countStoredBytes.get().count), openReports: Number(sql.countOpenReports.get().count) } });
    }
    if (pathname === '/api/admin/video-collections' && req.method === 'GET') {
      requireAdmin(req);
      return sendJSON(res, 200, {collections:sql.adminVideoCollections.all().map(row => mapVideoCollection(row,true))});
    }
    if (pathname === '/api/admin/video-collections' && req.method === 'POST') {
      requireAdmin(req);
      const {title,description} = safeGalleryDetails(await readJSON(req,8*1024));
      const now = Date.now(), result = sql.createVideoCollection.run(title,description,now,now);
      return sendJSON(res, 201, {collection:mapVideoCollection(sql.videoCollection.get(Number(result.lastInsertRowid)),true)});
    }
    const adminVideoCollection = pathname.match(/^\/api\/admin\/video-collections\/(\d+)$/);
    if (adminVideoCollection && ['PATCH','DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(adminVideoCollection[1]), row = sql.videoCollection.get(id);
      if (!row) throw httpError(404, 'Collection not found.');
      if (req.method === 'PATCH') {
        const {title,description} = safeGalleryDetails(await readJSON(req,8*1024));
        sql.editVideoCollection.run(title,description,Date.now(),id);
        return sendJSON(res, 200, {collection:mapVideoCollection(sql.videoCollection.get(id),true)});
      }
      sql.deleteVideoCollection.run(id);
      return sendJSON(res, 200, {ok:true});
    }
    const adminCollectionVideos = pathname.match(/^\/api\/admin\/video-collections\/(\d+)\/videos$/);
    if (adminCollectionVideos && req.method === 'PUT') {
      requireAdmin(req);
      const id = videoId(adminCollectionVideos[1]);
      if (!sql.videoCollection.get(id)) throw httpError(404, 'Collection not found.');
      const {videoIds} = await readJSON(req,4*1024);
      if (!Array.isArray(videoIds) || videoIds.length > 100 || videoIds.some(item => !Number.isSafeInteger(item) || item <= 0) || new Set(videoIds).size !== videoIds.length)
        throw httpError(400, 'Choose up to 100 different video IDs.');
      for (const videoIdValue of videoIds) {
        const video = sql.video.get(videoIdValue);
        if (!video?.file_path) throw httpError(400, `Video #${videoIdValue} is unavailable or has no uploaded file.`);
      }
      db.exec('BEGIN');
      try {
        sql.deleteVideoCollectionItems.run(id);
        videoIds.forEach((item,index) => sql.addVideoCollectionItem.run(id,item,index));
        sql.touchVideoCollection.run(Date.now(),id);
        db.exec('COMMIT');
      } catch(error){ db.exec('ROLLBACK'); throw error; }
      return sendJSON(res, 200, {collection:mapVideoCollection(sql.videoCollection.get(id),true)});
    }
    const adminVideoCollectionPublish = pathname.match(/^\/api\/admin\/video-collections\/(\d+)\/publish$/);
    if (adminVideoCollectionPublish && req.method === 'PATCH') {
      requireAdmin(req);
      const id = videoId(adminVideoCollectionPublish[1]), row = sql.videoCollection.get(id);
      if (!row) throw httpError(404, 'Collection not found.');
      const body = await readJSON(req,2048);
      if (typeof body.published !== 'boolean') throw httpError(400, 'published must be true or false.');
      if (body.published) {
        const available = sql.videoCollectionItems.all(id).filter(video => video.status === 'live' && video.file_path);
        if (!available.length) throw httpError(409, 'Add a published video before publishing this collection.');
        let playable = false;
        for (const video of available) {
          try { await playableVideo(video); playable = true; break; } catch {}
        }
        if (!playable) throw httpError(409, 'Collection video files are missing. Restore or replace them before publishing.');
      }
      const status = body.published ? 'live' : 'draft', now = Date.now();
      sql.publishVideoCollection.run(status,status,now,now,id);
      return sendJSON(res, 200, {collection:mapVideoCollection(sql.videoCollection.get(id),true)});
    }
    if (pathname === '/api/admin/galleries' && req.method === 'GET') {
      requireAdmin(req);
      return sendJSON(res, 200, { galleries:sql.adminGalleries.all().map(row => mapGallery(row, true)) });
    }
    if (pathname === '/api/admin/galleries' && req.method === 'POST') {
      requireAdmin(req);
      const {title,description} = safeGalleryDetails(await readJSON(req, 8 * 1024));
      const now = Date.now(), result = sql.createGallery.run(title, description, now, now);
      return sendJSON(res, 201, { gallery:mapGallery(sql.gallery.get(Number(result.lastInsertRowid)), true) });
    }
    const adminGalleryImageFile = pathname.match(/^\/api\/admin\/galleries\/(\d+)\/images\/(\d+)\/file$/);
    if (adminGalleryImageFile && ['GET', 'HEAD'].includes(req.method)) {
      requireAdmin(req);
      return streamGalleryImage(req, res, sql.galleryImage.get(videoId(adminGalleryImageFile[2]), videoId(adminGalleryImageFile[1])));
    }
    const adminGalleryMatch = pathname.match(/^\/api\/admin\/galleries\/(\d+)$/);
    if (adminGalleryMatch && ['PATCH','DELETE'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(adminGalleryMatch[1]), row = sql.gallery.get(id);
      if (!row) throw httpError(404, 'Collection not found.');
      if (req.method === 'PATCH') {
        const {title,description} = safeGalleryDetails(await readJSON(req, 8 * 1024));
        sql.editGallery.run(title, description, Date.now(), id);
        return sendJSON(res, 200, { gallery:mapGallery(sql.gallery.get(id), true) });
      }
      const images = sql.galleryImages.all(id);
      sql.deleteGallery.run(id);
      for (const image of images) await fsp.unlink(path.join(GALLERY_IMAGE_DIR, image.file_path)).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove deleted collection image:', error);
      });
      return sendJSON(res, 200, { ok:true });
    }
    const adminGalleryPublish = pathname.match(/^\/api\/admin\/galleries\/(\d+)\/publish$/);
    if (adminGalleryPublish && req.method === 'PATCH') {
      requireAdmin(req);
      const id = videoId(adminGalleryPublish[1]), row = sql.gallery.get(id);
      if (!row) throw httpError(404, 'Collection not found.');
      const body = await readJSON(req, 2048);
      if (typeof body.published !== 'boolean') throw httpError(400, 'published must be true or false.');
      if (body.published) {
        const images = sql.galleryImages.all(id);
        if (!images.length) throw httpError(409, 'Add at least one image before publishing.');
        for (const image of images) try { await fsp.access(path.join(GALLERY_IMAGE_DIR, image.file_path)); }
        catch { throw httpError(409, 'A collection image is missing. Remove or replace it before publishing.'); }
      }
      const status = body.published ? 'live' : 'draft', now = Date.now();
      sql.publishGallery.run(status, status, now, now, id);
      return sendJSON(res, 200, { gallery:mapGallery(sql.gallery.get(id), true) });
    }
    const adminGalleryImages = pathname.match(/^\/api\/admin\/galleries\/(\d+)\/images$/);
    if (adminGalleryImages && req.method === 'PUT') {
      requireAdmin(req);
      const id = videoId(adminGalleryImages[1]), row = sql.gallery.get(id);
      if (!row) throw httpError(404, 'Collection not found.');
      const position = Number(sql.galleryImageCount.get(id).n);
      if (position >= MAX_GALLERY_IMAGES) throw httpError(409, `A collection can have up to ${MAX_GALLERY_IMAGES} images.`);
      const {data,ext} = await readImage(req, MAX_GALLERY_IMAGE_BYTES, 'Collection images');
      const filename = `${crypto.randomUUID()}${ext}`;
      await fsp.writeFile(path.join(GALLERY_IMAGE_DIR, filename), data, {flag:'wx',mode:0o600});
      try { sql.addGalleryImage.run(id, filename, data.length, '', Date.now(), Date.now()); }
      catch(error) { await fsp.unlink(path.join(GALLERY_IMAGE_DIR, filename)).catch(() => {}); throw error; }
      return sendJSON(res, 201, { gallery:mapGallery(sql.gallery.get(id), true) });
    }
    const adminGalleryImage = pathname.match(/^\/api\/admin\/galleries\/(\d+)\/images\/(\d+)$/);
    if (adminGalleryImage && req.method === 'DELETE') {
      requireAdmin(req);
      const id = videoId(adminGalleryImage[1]), image = sql.galleryImage.get(videoId(adminGalleryImage[2]), id);
      if (!image) throw httpError(404, 'Image not found.');
      // Hide a collection if its last image is removed.
      db.exec('BEGIN');
      try {
        if (sql.galleryImageCount.get(id).n === 1) sql.publishGallery.run('draft','draft',Date.now(),Date.now(),id);
        sql.deleteGalleryImage.run(image.id, id);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      await fsp.unlink(path.join(GALLERY_IMAGE_DIR, image.file_path)).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove deleted collection image:', error);
      });
      return sendJSON(res, 200, { gallery:mapGallery(sql.gallery.get(id), true) });
    }
    if (pathname === '/api/admin/reports' && req.method === 'GET') {
      requireAdmin(req);
      const status = url.searchParams.get('status') || 'all', pageText = url.searchParams.get('page') || '1';
      if (!['all','new','reviewing','resolved','declined'].includes(status) || !/^\d{1,6}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000) throw httpError(400, 'Invalid report filter or page.');
      const page = Number(pageText), total = Number(sql.reportCount.get(status, status).count);
      const reports = sql.reports.all(status, status, (page - 1) * 20).map(row => ({ ...row, video_status: row.video_id ? sql.video.get(row.video_id)?.status || null : null }));
      return sendJSON(res, 200, { reports, pagination:{ page, total, hasMore:page * 20 < total } });
    }
    const reportMatch = pathname.match(/^\/api\/admin\/reports\/(\d+)$/);
    if (reportMatch && req.method === 'PATCH') {
      requireAdmin(req);
      const id = videoId(reportMatch[1]), report = sql.report.get(id);
      if (!report) throw httpError(404, 'Request not found.');
      const body = await readJSON(req, 8 * 1024);
      if (!['new','reviewing','resolved','declined'].includes(body.status)) throw httpError(400, 'Invalid request status.');
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (note.length > 2000 || (['resolved','declined'].includes(body.status) && note.length < 5)) throw httpError(400, 'Add a private review note (5 to 2000 characters) before closing a request.');
      sql.updateReport.run(body.status, note, Date.now(), id);
      return sendJSON(res, 200, { report:sql.report.get(id) });
    }
    const reportUnpublish = pathname.match(/^\/api\/admin\/reports\/(\d+)\/unpublish$/);
    if (reportUnpublish && req.method === 'POST') {
      requireAdmin(req);
      const id = videoId(reportUnpublish[1]), report = sql.report.get(id);
      if (!report) throw httpError(404, 'Request not found.');
      const video = report.video_id ? sql.video.get(report.video_id) : null;
      if (!video) throw httpError(409, 'The video has already been deleted. Close the request with a review note.');
      if (videoMutations.has(video.id)) throw httpError(409, 'The video is being updated. Try again shortly.');
      videoMutations.add(video.id); lockedVideo = video.id;
      const body = await readJSON(req, 8 * 1024);
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (note.length < 5 || note.length > 2000) throw httpError(400, 'Add a private reason for unpublishing (5 to 2000 characters).');
      db.exec('BEGIN');
      try {
        if (video.status === 'live') sql.publish.run('private', Date.now(), 'private', Date.now(), video.id);
        if (getSettings().featuredVideoId === String(video.id)) sql.setSetting.run('featuredVideoId', '');
        sql.updateReport.run('resolved', note, Date.now(), id);
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      return sendJSON(res, 200, { report:sql.report.get(id), videoStatus:sql.video.get(video.id).status });
    }
    if (pathname === '/api/admin/storage-check' && req.method === 'GET') {
      requireAdmin(req);
      const rows = sql.adminVideos.all();
      const files = new Set((await fsp.readdir(VIDEO_DIR, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name));
      const referenced = new Set(rows.map(row => row.file_path).filter(name => name && !bunnyVideoId(name)));
      const missing = rows.filter(row => row.file_path && !bunnyVideoId(row.file_path) && !files.has(row.file_path)).map(row => ({ id: row.id, title: row.title }));
      const bunnyVideos = rows.filter(row => bunnyVideoId(row.file_path)).length;
      const pendingBunnyUploads = db.prepare('SELECT COUNT(*) AS n FROM bunny_uploads').get().n;
      const unreferencedFiles = [...files].filter(name => /\.(mp4|webm)$/.test(name) && !referenced.has(name)).length;
      const imageFiles = new Set((await fsp.readdir(CATEGORY_IMAGE_DIR, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name));
      const imageRows = sql.categories.all().filter(row => row.image_path);
      const missingCategoryImages = imageRows.filter(row => !imageFiles.has(row.image_path)).map(row => ({ id:row.id, name:row.name }));
      const imageRefs = new Set(imageRows.map(row => row.image_path));
      const unreferencedCategoryImages = [...imageFiles].filter(name => categoryImageName(name) && !imageRefs.has(name)).length;
      const galleryFiles = new Set((await fsp.readdir(GALLERY_IMAGE_DIR, { withFileTypes:true })).filter(entry => entry.isFile()).map(entry => entry.name));
      const galleryRows = db.prepare('SELECT i.id,i.file_path,g.title FROM gallery_images i JOIN galleries g ON g.id=i.gallery_id').all();
      const missingGalleryImages = galleryRows.filter(row => !galleryFiles.has(row.file_path)).map(row => ({id:row.id,title:row.title}));
      const galleryRefs = new Set(galleryRows.map(row => row.file_path));
      const unreferencedGalleryImages = [...galleryFiles].filter(name => categoryImageName(name) && !galleryRefs.has(name)).length;
      const disk = await fsp.statfs(VIDEO_DIR).catch(() => null);
      return sendJSON(res, 200, { missing, unreferencedFiles, bunnyVideos, pendingBunnyUploads, activeUploads: videoMutations.size,
        missingCategoryImages, unreferencedCategoryImages, activeCategoryOperations: categoryMutations.size,
        missingGalleryImages, unreferencedGalleryImages, activeGalleryOperations: galleryMutations.size,
        availableBytes: disk ? Number(disk.bavail) * Number(disk.bsize) : null,
        checkedAt: new Date().toISOString() });
    }
    if (pathname === '/api/admin/videos' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readJSON(req);
      const item = normalizeVideo(body), timestamp = Date.now();
      const result = sql.createVideo.run(item.title, item.description, item.category, item.duration, item.quality, JSON.stringify(item.tags || []), 'draft', crypto.randomInt(0, 12), timestamp, timestamp);
      return sendJSON(res, 201, { item: mapVideo(sql.video.get(Number(result.lastInsertRowid))) });
    }
    if (pathname === '/api/admin/categories' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readJSON(req, 16 * 1024), name = safeCategoryName(body.name);
      try {
        const result = sql.addCategory.run(name, Number(sql.categories.all().length), Date.now());
        return sendJSON(res, 201, { category: mapCategory(sql.categoryById.get(Number(result.lastInsertRowid))) });
      } catch (error) { if (String(error.code).includes('CONSTRAINT')) throw httpError(409, 'That category already exists.'); throw error; }
    }
    if (pathname === '/api/admin/settings' && req.method === 'PATCH') {
      requireAdmin(req);
      const body = await readJSON(req, 16 * 1024), settings = safeSettings(body);
      for (const [key, value] of Object.entries(settings)) sql.setSetting.run(key, String(value));
      return sendJSON(res, 200, { settings });
    }
    const categoryMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
    if (categoryMatch && req.method === 'PATCH') {
      requireAdmin(req);
      const id = Number(categoryMatch[1]), existing = sql.categoryById.get(id);
      if (!existing) throw httpError(404, 'Category not found.');
      const name = safeCategoryName((await readJSON(req, 16 * 1024)).name);
      db.exec('BEGIN');
      try {
        sql.updateCategory.run(name, id);
        db.prepare('UPDATE videos SET category=?,updated_at=? WHERE category=?').run(name, Date.now(), existing.name);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (String(error.code).includes('CONSTRAINT')) throw httpError(409, 'That category already exists.');
        throw error;
      }
      return sendJSON(res, 200, { category: mapCategory(sql.categoryById.get(id)) });
    }
    if (categoryMatch && req.method === 'DELETE') {
      requireAdmin(req);
      const id = Number(categoryMatch[1]), existing = sql.categoryById.get(id);
      if (!existing) throw httpError(404, 'Category not found.');
      if (sql.categories.all().length < 2) throw httpError(409, 'Keep at least one category on the site.');
      if (db.prepare('SELECT COUNT(*) AS n FROM videos WHERE category=?').get(existing.name).n) throw httpError(409, 'Move or delete videos in this category first.');
      sql.deleteCategory.run(id);
      if (categoryImageName(existing.image_path)) await fsp.unlink(path.join(CATEGORY_IMAGE_DIR, existing.image_path)).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove deleted category image:', error);
      });
      return sendJSON(res, 200, { ok: true });
    }
    const adminCategoryImage = pathname.match(/^\/api\/admin\/categories\/(\d+)\/image$/);
    if (adminCategoryImage && req.method === 'PUT') {
      requireAdmin(req);
      const id = videoId(adminCategoryImage[1]), category = sql.categoryById.get(id);
      if (!category) throw httpError(404, 'Category not found.');
      const {data, ext} = await readCategoryImage(req);
      const filename = `${crypto.randomUUID()}${ext}`;
      const target = path.join(CATEGORY_IMAGE_DIR, filename);
      await fsp.writeFile(target, data, { flag:'wx', mode:0o600 });
      try { sql.setCategoryImage.run(filename, id); }
      catch(error) { await fsp.unlink(target).catch(() => {}); throw error; }
      if (categoryImageName(category.image_path)) await fsp.unlink(path.join(CATEGORY_IMAGE_DIR, category.image_path)).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove replaced category image:', error);
      });
      return sendJSON(res, 200, { category:mapCategory(sql.categoryById.get(id)) });
    }
    if (adminCategoryImage && req.method === 'DELETE') {
      requireAdmin(req);
      const id = videoId(adminCategoryImage[1]), category = sql.categoryById.get(id);
      if (!category) throw httpError(404, 'Category not found.');
      sql.setCategoryImage.run(null, id);
      if (categoryImageName(category.image_path)) await fsp.unlink(path.join(CATEGORY_IMAGE_DIR, category.image_path)).catch(error => {
        if (error.code !== 'ENOENT') console.error('Could not remove category image:', error);
      });
      return sendJSON(res, 200, { category:mapCategory(sql.categoryById.get(id)) });
    }
    const adminVideoFileMatch = pathname.match(/^\/api\/admin\/videos\/(\d+)\/file$/);
    const bunnyUploadMatch = pathname.match(/^\/api\/admin\/videos\/(\d+)\/bunny-upload(?:\/(complete|status))?$/);
    if (bunnyUploadMatch && ['POST','GET'].includes(req.method)) {
      requireAdmin(req);
      const id = videoId(bunnyUploadMatch[1]), row = sql.video.get(id), action = bunnyUploadMatch[2] || 'start';
      if (!row) throw httpError(404, 'Video not found.');
      if (!BUNNY_ENABLED) throw httpError(503, 'Bunny Stream is not configured.');
      if (action === 'start' && req.method === 'POST') {
        const body = await readJSON(req, 4096);
        if (!['video/mp4','video/webm'].includes(body.mime) || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX_UPLOAD_BYTES) throw httpError(400, 'Choose an MP4 or WebM video within the upload limit.');
        let pending = db.prepare('SELECT * FROM bunny_uploads WHERE video_id=?').get(id);
        if (pending && (pending.size !== body.size || pending.mime !== body.mime)) {
          await bunnyAPI('DELETE', `/${pending.guid}`);
          db.prepare('DELETE FROM bunny_uploads WHERE video_id=?').run(id); pending = null;
        }
        if (!pending) {
          const created = await bunnyAPI('POST', '', { title:row.title });
          if (!/^[0-9a-f-]{36}$/i.test(created.guid)) throw httpError(503, 'Bunny returned an invalid video ID.');
          db.prepare('INSERT INTO bunny_uploads(video_id,guid,mime,size,created_at) VALUES(?,?,?,?,?)').run(id,created.guid,body.mime,body.size,Date.now());
          pending = { guid:created.guid, mime:body.mime, size:body.size };
        }
        const expires = Math.floor(Date.now()/1000) + 86400;
        const signature = crypto.createHash('sha256').update(`${BUNNY_LIBRARY_ID}${BUNNY_STREAM_API_KEY}${expires}${pending.guid}`).digest('hex');
        return sendJSON(res, 200, { guid:pending.guid, libraryId:BUNNY_LIBRARY_ID, expires, signature });
      }
      if (action === 'complete' && req.method === 'POST') {
        const pending = db.prepare('SELECT * FROM bunny_uploads WHERE video_id=?').get(id);
        if (!pending) throw httpError(409, 'Start a Bunny upload first.');
        const remote = await bunnyAPI('GET', `/${pending.guid}`);
        if (!remote || String(remote.guid).toLowerCase() !== pending.guid.toLowerCase()) throw httpError(409, 'Bunny has not confirmed this video yet. Retry once the upload finishes.');
        sql.setFile.run(`bunny:${pending.guid}`,pending.mime,pending.size,0,0,Date.now(),id);
        if (row.status === 'live') sql.publish.run('draft',Date.now(),'draft',Date.now(),id);
        db.prepare('DELETE FROM bunny_uploads WHERE video_id=?').run(id);
        if (row.file_path) await removeStoredVideo(row).catch(error => console.error('Could not remove replaced video:',error.message));
        return sendJSON(res, 200, { item:mapVideo(sql.video.get(id)), status:remote.status });
      }
      if (action === 'status' && req.method === 'GET') {
        const guid = bunnyVideoId(row.file_path);
        if (!guid) throw httpError(404, 'This video is stored locally.');
        const remote = await bunnyAPI('GET', `/${guid}`);
        return sendJSON(res, 200, { ready:remote.status === 4, status:remote.status });
      }
      throw httpError(405, 'Unsupported action.');
    }
    const adminBunnyEmbed = pathname.match(/^\/api\/admin\/videos\/(\d+)\/embed$/);
    if (adminBunnyEmbed && req.method === 'GET') {
      requireAdmin(req);
      const row = sql.video.get(videoId(adminBunnyEmbed[1]));
      if (!row || !bunnyVideoId(row.file_path)) throw httpError(404, 'Bunny video not found.');
      return sendJSON(res, 200, { url:bunnyEmbedUrl(bunnyVideoId(row.file_path)) });
    }
    if (adminVideoFileMatch && req.method === 'PUT') {
      requireAdmin(req);
      if (BUNNY_ENABLED) throw httpError(409, 'Use the Bunny upload flow for new videos.');
      const row = sql.video.get(videoId(adminVideoFileMatch[1]));
      if (!row) throw httpError(404, 'Video not found.');
      return await saveVideo(req, res, row);
    }
    if (adminVideoFileMatch && ['GET', 'HEAD'].includes(req.method)) {
      requireAdmin(req);
      const row = sql.video.get(videoId(adminVideoFileMatch[1]));
      if (!row) throw httpError(404, 'Video not found.');
      return await streamVideo(req, res, row);
    }
    const publishMatch = pathname.match(/^\/api\/admin\/videos\/(\d+)\/publish$/);
    if (publishMatch && req.method === 'PATCH') {
      requireAdmin(req);
      const id = videoId(publishMatch[1]), row = sql.video.get(id), body = await readJSON(req, 4096);
      if (!row) throw httpError(404, 'Video not found.');
      if (typeof body.published !== 'boolean') throw httpError(400, 'published must be true or false.');
      if (body.published && !row.file_path) throw httpError(409, 'Upload the video file before publishing.');
      if (body.published) await playableVideo(row);
      const status = body.published ? 'live' : (row.status === 'private' ? 'private' : 'draft');
      const timestamp = Date.now();
      sql.publish.run(status, timestamp, status, timestamp, id);
      return sendJSON(res, 200, { item: mapVideo(sql.video.get(id)) });
    }
    const adminVideoMatch = pathname.match(/^\/api\/admin\/videos\/(\d+)$/);
    if (adminVideoMatch && req.method === 'PATCH') {
      requireAdmin(req);
      const id = videoId(adminVideoMatch[1]), row = sql.video.get(id);
      if (!row) throw httpError(404, 'Video not found.');
      const item = normalizeVideo(await readJSON(req));
      sql.updateVideo.run(item.title, item.description, item.category, item.duration || row.duration, item.quality, JSON.stringify(item.tags ?? videoTags(row)), Date.now(), id);
      return sendJSON(res, 200, { item: mapVideo(sql.video.get(id)) });
    }
    if (adminVideoMatch && req.method === 'DELETE') {
      requireAdmin(req);
      const id = videoId(adminVideoMatch[1]), row = sql.video.get(id);
      if (!row) throw httpError(404, 'Video not found.');
      if (row.file_path) await removeStoredVideo(row);
      const pending = db.prepare('SELECT guid FROM bunny_uploads WHERE video_id=?').get(id);
      if (pending) await bunnyAPI('DELETE', `/${pending.guid}`);
      sql.deleteVideo.run(id);
      if (getSettings().featuredVideoId === String(id)) sql.setSetting.run('featuredVideoId', '');
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) throw httpError(404, 'API route not found.');
    return await serveStatic(req, res, pathname);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error);
    return sendJSON(res, status, { error: status >= 500 ? 'Internal server error.' : error.message });
  } finally {
    if (lockedVideo !== null) videoMutations.delete(lockedVideo);
    if (lockedCategory !== null) categoryMutations.delete(lockedCategory);
    if (lockedGallery !== null) galleryMutations.delete(lockedGallery);
    if (lockedVideoCollection !== null) videoCollectionMutations.delete(lockedVideoCollection);
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MINUTES * 60 * 1000;
// Close idle connections while allowing uploads that continue making progress.
server.setTimeout(2 * 60 * 1000);
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`AURA is running at http://${process.env.HOST || '127.0.0.1'}:${PORT}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
