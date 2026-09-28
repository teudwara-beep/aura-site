'use strict';

// Keep the encoded picture intact while discarding camera, location and text
// metadata. This runs on the server, including for clients bypassing the UI.
function jpeg(data) {
  if (data.length < 6 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Invalid JPEG image.');
  const pieces = [data.subarray(0, 2)];
  let offset = 2, scans = 0;
  while (offset < data.length) {
    const start = offset;
    if (data[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
    while (data[offset] === 0xff) offset++;
    if (offset >= data.length) throw new Error('Incomplete JPEG image.');
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!scans) throw new Error('JPEG image has no picture data.');
      pieces.push(data.subarray(start, offset));
      return Buffer.concat(pieces);
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('Invalid JPEG marker.');
    if (offset + 2 > data.length) throw new Error('Incomplete JPEG segment.');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) throw new Error('Invalid JPEG segment.');
    offset += length;
    // APP0 (JFIF) and APP14 (Adobe) affect some image decoders; other APP
    // segments and COM may contain EXIF, XMP, GPS, thumbnails or private text.
    if ((marker < 0xe0 || marker > 0xef || marker === 0xe0 || marker === 0xee) && marker !== 0xfe)
      pieces.push(data.subarray(start, offset));
    if (marker !== 0xda) continue;
    scans++;
    const scanStart = offset;
    while (offset < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const markerStart = offset++;
      while (data[offset] === 0xff) offset++;
      if (offset >= data.length) throw new Error('Incomplete JPEG scan.');
      if (data[offset] === 0x00 || (data[offset] >= 0xd0 && data[offset] <= 0xd7)) { offset++; continue; }
      pieces.push(data.subarray(scanStart, markerStart));
      offset = markerStart;
      break;
    }
  }
  throw new Error('Incomplete JPEG image.');
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Unknown ancillary chunks can hold application-specific private data.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs']);
function png(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG image.');
  const pieces = [data.subarray(0, 8)];
  let offset = 8, chunks = 0, picture = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) throw new Error('Invalid PNG chunk.');
    const end = offset + length + 12;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[a-zA-Z]{4}$/.test(type) || (!chunks && (type !== 'IHDR' || length !== 13))) throw new Error('Invalid PNG structure.');
    if (type === 'IDAT') picture = true;
    if (PNG_KEEP.has(type)) pieces.push(data.subarray(offset, end));
    else if (type[0] === type[0].toUpperCase()) throw new Error('Unsupported critical PNG chunk.');
    offset = end;
    chunks++;
    if (type === 'IEND') {
      if (length || !picture) throw new Error('Incomplete PNG image.');
      return Buffer.concat(pieces);
    }
  }
  throw new Error('Incomplete PNG image.');
}

function webp(data) {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) !== data.length - 8)
    throw new Error('Invalid WebP image.');
  const pieces = [];
  const keep = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
  let offset = 12, picture = false;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (!/^[ -~]{4}$/.test(type) || end > data.length) throw new Error('Invalid WebP chunk.');
    if (['VP8 ', 'VP8L', 'ANIM', 'ANMF'].includes(type)) picture = true;
    if (keep.has(type)) {
      if (type === 'VP8X') {
        if (length !== 10) throw new Error('Invalid WebP extended header.');
        const chunk = Buffer.from(data.subarray(offset, end));
        chunk[8] &= ~0x2c; // Clear ICC, EXIF and XMP presence flags.
        pieces.push(chunk);
      } else pieces.push(data.subarray(offset, end));
    }
    offset = end;
  }
  if (!picture || offset !== data.length) throw new Error('Incomplete WebP image.');
  const result = Buffer.concat([data.subarray(0, 12), ...pieces]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function sanitizeImage(data, mime) {
  if (mime === 'image/jpeg') return jpeg(data);
  if (mime === 'image/png') return png(data);
  if (mime === 'image/webp') return webp(data);
  throw new Error('Unsupported image format.');
}

module.exports = { sanitizeImage };
