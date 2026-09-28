'use strict';

// Run with the server stopped, after making a private full backup.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { sanitizeImage } = require('../lib/image-sanitize');

const ROOT = path.resolve(__dirname, '..');
const NAME = /^[a-f0-9-]{36}\.(jpg|png|webp)$/;

async function readEnv() {
  let lines;
  try { lines = (await fs.readFile(path.join(ROOT, '.env'),'utf8')).split(/\r?\n/); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of lines) {
    const value = line.trim(), index = value.indexOf('=');
    if (!value || value.startsWith('#') || index < 1) continue;
    const key = value.slice(0,index).trim();
    if (process.env[key] === undefined) process.env[key] = value.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && !['--check','--apply'].includes(process.argv[2])))
    throw new Error('Usage: node scripts/sanitize-existing-images.js [--check | --apply]');
  const apply = process.argv[2] === '--apply';
  await readEnv();
  const base = path.resolve(ROOT, process.env.DATA_DIR || './data');
  const databaseFile = path.join(base, 'aura.sqlite');
  await fs.access(databaseFile);
  const db = new DatabaseSync(databaseFile);
  let cleaned = 0, scanned = 0;
  try {
    const images = [
      ...db.prepare('SELECT id,image_path FROM categories WHERE image_path IS NOT NULL').all()
        .map(row => ({name:row.image_path,dir:'category-images'})),
      ...db.prepare('SELECT id,file_path FROM gallery_images').all()
        .map(row => ({id:row.id,name:row.file_path,dir:'gallery-images'})),
      ...(db.prepare('PRAGMA table_info(videos)').all().some(column => column.name === 'thumbnail_path')
        ? db.prepare('SELECT id,thumbnail_path FROM videos WHERE thumbnail_path IS NOT NULL').all()
          .map(row => ({id:row.id,name:row.thumbnail_path,dir:'video-thumbnails'}))
        : [])
    ];
    for (const image of images) {
      if (!NAME.test(image.name)) throw new Error(`Unexpected image name: ${image.name}`);
      const filename = path.join(base,image.dir,image.name);
      const stat = await fs.lstat(filename);
      const maxBytes = image.dir === 'gallery-images' ? 8 * 1024 * 1024 : 3 * 1024 * 1024;
      if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid image: ${filename}`);
      const bytes = await fs.readFile(filename);
      const mime = image.name.endsWith('.jpg') ? 'image/jpeg' : image.name.endsWith('.png') ? 'image/png' : 'image/webp';
      const clean = sanitizeImage(bytes,mime);
      scanned++;
      if (bytes.equals(clean)) continue;
      cleaned++;
      if (!apply) continue;
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, clean, {flag:'wx',mode:0o600});
        await fs.rename(temporary,filename);
        if (image.dir === 'gallery-images') db.prepare('UPDATE gallery_images SET file_size=? WHERE id=?').run(clean.length,image.id);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
  } finally { db.close(); }
  console.log(`${scanned} images checked; ${cleaned} ${apply ? 'cleaned' : 'need cleaning'}.`);
  if (!apply && cleaned) console.log('Stop the server, make a full backup, then run with --apply.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
