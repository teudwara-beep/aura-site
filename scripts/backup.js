'use strict';

// Local recovery tools: never overwrite an existing destination.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const MEDIA_NAME = /^[a-f0-9-]{36}\.(mp4|webm)$/i;
const BUNNY_MEDIA_NAME = /^bunny:[a-f0-9-]{36}$/i;
const CATEGORY_IMAGE_NAME = /^[a-f0-9-]{36}\.(jpg|png|webp)$/i;
const GALLERY_IMAGE_NAME = CATEGORY_IMAGE_NAME;

function loadEnvironment() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const value = line.trim(), index = value.indexOf('=');
    if (!value || value.startsWith('#') || index < 1) continue;
    const key = value.slice(0, index).trim();
    if (process.env[key] === undefined) process.env[key] = value.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
async function fingerprint(filename) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile()) throw new Error('Backup files must be regular files, not links or directories.');
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filename)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}
async function copyChecked(source, destination, expected) {
  const input = await fingerprint(source);
  if (expected && (input.size !== expected.size || input.sha256 !== expected.sha256)) throw new Error(`Backup checksum mismatch: ${path.basename(source)}`);
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o600);
  const output = await fingerprint(destination);
  if (input.size !== output.size || input.sha256 !== output.sha256) throw new Error('File changed while copying. Pause uploads/deletions and retry.');
  return output;
}
function mediaRows(db) {
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Database integrity check failed.');
  const rows = db.prepare('SELECT file_path,file_size FROM videos WHERE file_path IS NOT NULL').all();
  for (const row of rows) if (!MEDIA_NAME.test(row.file_path) && !BUNNY_MEDIA_NAME.test(row.file_path)) throw new Error('Database contains an unsupported media filename.');
  // Bunny references live in SQLite; the video bytes stay in Bunny Stream.
  return rows.filter(row => MEDIA_NAME.test(row.file_path));
}
function categoryImageRows(db) {
  if (!db.prepare('PRAGMA table_info(categories)').all().some(column => column.name === 'image_path')) return [];
  const rows = db.prepare('SELECT image_path FROM categories WHERE image_path IS NOT NULL').all();
  for (const row of rows) if (!CATEGORY_IMAGE_NAME.test(row.image_path)) throw new Error('Database contains an unsupported category image filename.');
  return rows;
}
function galleryImageRows(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gallery_images'").get()) return [];
  const rows = db.prepare('SELECT file_path,file_size FROM gallery_images').all();
  for (const row of rows) if (!GALLERY_IMAGE_NAME.test(row.file_path)) throw new Error('Database contains an unsupported collection image filename.');
  return rows;
}
async function newDestination(destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  // No recursive mkdir here: even an empty existing destination is refused.
  await fsp.mkdir(destination, { mode: 0o700 });
}
function inside(child, parent) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function backup({ dataDir, videoDir, destination }) {
  dataDir = path.resolve(dataDir); videoDir = path.resolve(videoDir); destination = path.resolve(destination);
  if (inside(destination, dataDir) || inside(destination, videoDir)) throw new Error('Keep backups outside the live data and video directories.');
  const sourcePath = path.join(dataDir, 'aura.sqlite');
  if (!(await fsp.lstat(sourcePath)).isFile()) throw new Error('Source database is not a regular file.');
  await newDestination(destination);
  try {
    const databasePath = path.join(destination, 'aura.sqlite');
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout=5000');
      source.prepare('VACUUM INTO ?').run(databasePath);
    } finally { source.close(); }
    await fsp.chmod(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath);
    let rows, images, galleryImages;
    try {
      // Restore uses the administrator configured in .env, never old sessions.
      snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; DELETE FROM sessions; DELETE FROM admins; VACUUM;');
      rows = mediaRows(snapshot);
      images = categoryImageRows(snapshot);
      galleryImages = galleryImageRows(snapshot);
    } finally { snapshot.close(); }
    await fsp.mkdir(path.join(destination, 'videos'), { mode: 0o700 });
    const files = [{ path: 'aura.sqlite', ...await fingerprint(databasePath) }];
    for (const row of rows) {
      const relative = `videos/${row.file_path}`;
      const info = await copyChecked(path.join(videoDir, row.file_path), path.join(destination, relative));
      if (info.size !== Number(row.file_size)) throw new Error('Video size differs from the catalog. Replace the damaged file before backing up.');
      files.push({ path: relative, ...info });
    }
    if (images.length) await fsp.mkdir(path.join(destination, 'images'), { mode: 0o700 });
    for (const row of images) {
      const relative = `images/${row.image_path}`;
      files.push({ path: relative, ...await copyChecked(path.join(dataDir, 'category-images', row.image_path), path.join(destination, relative)) });
    }
    if (galleryImages.length) await fsp.mkdir(path.join(destination, 'gallery-images'), { mode: 0o700 });
    for (const row of galleryImages) {
      const relative = `gallery-images/${row.file_path}`;
      const info = await copyChecked(path.join(dataDir, 'gallery-images', row.file_path), path.join(destination, relative));
      if (info.size !== Number(row.file_size)) throw new Error('Collection image size differs from the catalog.');
      files.push({ path: relative, ...info });
    }
    const manifest = { format: 'aura-backup', version: 1, createdAt: new Date().toISOString(), files };
    await fsp.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch(error) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
async function verify(directory) {
  directory = path.resolve(directory);
  const manifestPath = path.join(directory, 'manifest.json');
  const stat = await fsp.lstat(manifestPath);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid backup manifest.');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'aura-backup' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported backup format.');
  if (!(await fsp.lstat(path.join(directory, 'videos'))).isDirectory()) throw new Error('Invalid backup video directory.');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !(file.path === 'aura.sqlite' || (file.path.startsWith('videos/') && MEDIA_NAME.test(file.path.slice(7))) || (file.path.startsWith('images/') && CATEGORY_IMAGE_NAME.test(file.path.slice(7))) || (file.path.startsWith('gallery-images/') && GALLERY_IMAGE_NAME.test(file.path.slice(15))))) throw new Error('Invalid backup file path.');
    if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid backup file record.');
    paths.add(file.path);
    const actual = await fingerprint(path.join(directory, file.path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  if (!paths.has('aura.sqlite')) throw new Error('Backup database missing.');
  const db = new DatabaseSync(path.join(directory, 'aura.sqlite'), { readOnly: true });
  try {
    const rows = mediaRows(db);
    const images = categoryImageRows(db);
    const galleryImages = galleryImageRows(db);
    if (rows.length + images.length + galleryImages.length + 1 !== paths.size || rows.some(row => !paths.has(`videos/${row.file_path}`)) || images.some(row => !paths.has(`images/${row.image_path}`)) || galleryImages.some(row => !paths.has(`gallery-images/${row.file_path}`))) throw new Error('Backup does not contain every referenced media file.');
    for (const row of rows) {
      const entry = manifest.files.find(file => file.path === `videos/${row.file_path}`);
      if (entry.size !== Number(row.file_size)) throw new Error('Backup catalog and media sizes do not match.');
    }
    for (const row of images) {
      const entry = manifest.files.find(file => file.path === `images/${row.image_path}`);
      if (!entry || entry.size > 3 * 1024 * 1024) throw new Error('Invalid category image in backup.');
    }
    for (const row of galleryImages) {
      const entry = manifest.files.find(file => file.path === `gallery-images/${row.file_path}`);
      if (!entry || entry.size !== Number(row.file_size) || entry.size > 8 * 1024 * 1024) throw new Error('Invalid collection image in backup.');
    }
    if (db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count || db.prepare('SELECT COUNT(*) AS count FROM admins').get().count) throw new Error('Backup must not contain admin credentials or sessions.');
  } finally { db.close(); }
  return manifest;
}
async function restore({ source, destination }) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (inside(destination, source)) throw new Error('Restore into a new directory outside the backup.');
  const manifest = await verify(source);
  await newDestination(destination);
  try {
    await fsp.mkdir(path.join(destination, 'data'), { mode: 0o700 });
    await fsp.mkdir(path.join(destination, 'videos'), { mode: 0o700 });
    if (manifest.files.some(file => file.path.startsWith('images/'))) await fsp.mkdir(path.join(destination, 'data', 'category-images'), { mode: 0o700 });
    if (manifest.files.some(file => file.path.startsWith('gallery-images/'))) await fsp.mkdir(path.join(destination, 'data', 'gallery-images'), { mode: 0o700 });
    for (const file of manifest.files) {
      const target = file.path === 'aura.sqlite' ? 'data/aura.sqlite' : file.path.startsWith('images/') ? `data/category-images/${file.path.slice(7)}` : file.path.startsWith('gallery-images/') ? `data/gallery-images/${file.path.slice(15)}` : file.path;
      await copyChecked(path.join(source, file.path), path.join(destination, target), file);
    }
    return { dataDir: path.join(destination, 'data'), videoDir: path.join(destination, 'videos') };
  } catch(error) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
async function main() {
  loadEnvironment();
  const [command, first, second, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Too many arguments.');
  if (command === 'create' && !second) {
    const destination = path.resolve(first || path.join(ROOT, 'backups', `aura-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    const result = await backup({ dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'), videoDir: path.resolve(ROOT, process.env.VIDEO_DIR || 'storage/videos'), destination });
    console.log(`Backup complete: ${destination}\n${result.files.filter(file => file.path.startsWith('videos/')).length} videos, ${result.files.filter(file => file.path.startsWith('images/')).length} category images and ${result.files.filter(file => file.path.startsWith('gallery-images/')).length} collection images included. Copy this folder to a separate disk.`);
  } else if (command === 'verify' && first && !second) {
    const result = await verify(first);
    console.log(`Backup verified: database, ${result.files.filter(file => file.path.startsWith('videos/')).length} videos, ${result.files.filter(file => file.path.startsWith('images/')).length} category images and ${result.files.filter(file => file.path.startsWith('gallery-images/')).length} collection images.`);
  } else if (command === 'restore' && first && second) {
    const result = await restore({ source: first, destination: second });
    console.log(`Restore complete in a new directory. Stop the server, set these in .env, then restart:\nDATA_DIR=${result.dataDir}\nVIDEO_DIR=${result.videoDir}\nUse your existing ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET.`);
  } else throw new Error('Usage: node scripts/backup.js create [new-folder] | verify <backup-folder> | restore <backup-folder> <new-folder>');
}
if (require.main === module) main().catch(error => { console.error(`Recovery command failed: ${error.message}`); process.exitCode = 1; });
module.exports = { backup, verify, restore };
