import { inflateSync } from 'node:zlib';
// Apply the cap before diagnostic clones can tee and drain an error body.
export function boundResponse(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid response limit');
  if (!response.body) return response;
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); return; }
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          controller.error(new Error('Upstream response too large'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// Count actual streamed bytes, including error bodies; Content-Length is not trusted.
export async function readBoundedJson(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid response limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
export function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}
export function validImage(image) {
  if (!image || typeof image !== 'object') return false;
  if (image.b64_json !== undefined) {
    const b = decodeBase64(image.b64_json);
    if (!b || !completeImage(b)) return false;
  }
  if (image.url !== undefined) {
    if (typeof image.url !== 'string') return false;
    try { const url = new URL(image.url); if (url.protocol !== 'https:' || !url.hostname) return false; }
    catch { return false; }
  }
  return image.b64_json !== undefined || image.url !== undefined;
}
export function validEmbedding(value, format) {
  if (format === 'float') return Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);
  const bytes = decodeBase64(value);
  if (!bytes || !bytes.length || bytes.length % 4 !== 0) return false;
  for (let i = 0; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) return false;
  return true;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Require a complete image container, rather than accepting a file signature as an answer.
function completeImage(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let at = 8, header = false, end = false, width, height, depth, color, interlace;
    const data = [];
    while (at + 12 <= b.length) {
      const size = b.readUInt32BE(at), type = b.toString('ascii', at + 4, at + 8);
      if (size > b.length - at - 12) return false;
      if (crc32(b.subarray(at + 4, at + 8 + size)) !== b.readUInt32BE(at + 8 + size)) return false;
      if (!header && type !== 'IHDR') return false;
      if (type === 'IHDR') {
        if (header || size !== 13) return false;
        width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12);
        depth = b[at + 16]; color = b[at + 17]; interlace = b[at + 20];
        if (!width || !height || ![1,2,4,8,16].includes(depth) || ![0,2,3,4,6].includes(color)
          || b[at + 18] || b[at + 19] || interlace > 1) return false;
        header = true;
      }
      if (type === 'IDAT') data.push(b.subarray(at + 8, at + 8 + size));
      at += size + 12;
      if (type === 'IEND') { end = size === 0 && at === b.length; break; }
    }
    if (!header || !end || !data.length) return false;
    try {
      const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 64 * 1024 * 1024 });
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      if (!interlace) {
        const row = Math.ceil(width * channels * depth / 8) + 1;
        if (pixels.length !== row * height) return false;
        for (let i = 0; i < pixels.length; i += row) if (pixels[i] > 4) return false;
      }
      return pixels.length > 0;
    } catch { return false; }
  }
  if (b[0] === 255 && b[1] === 216) {
    let frame = false, scan = false, at = 2;
    while (at < b.length) {
      if (b[at++] !== 255) { if (scan) continue; return false; }
      while (b[at] === 255) at++;
      const marker = b[at++];
      if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9) return frame && scan && at === b.length;
      if (at + 2 > b.length) return false;
      const size = b.readUInt16BE(at);
      if (size < 2 || at + size > b.length) return false;
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (size < 8 || !b.readUInt16BE(at + 3) || !b.readUInt16BE(at + 5)) return false;
        frame = true;
      }
      if (marker === 0xda) { if (!frame || size < 6) return false; scan = true; }
      at += size;
    }
    return false;
  }
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    if (b.readUInt32LE(4) + 8 !== b.length) return false;
    let at = 12, image = false;
    while (at + 8 <= b.length) {
      const type = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4);
      if (size > b.length - at - 8) return false;
      if (type === 'VP8 ') image ||= size > 10 && b.subarray(at + 11, at + 14).equals(Buffer.from([0x9d,0x01,0x2a]));
      if (type === 'VP8L') image ||= size > 5 && b[at + 8] === 0x2f;
      at += 8 + size + (size % 2);
    }
    return image && at === b.length;
  }
  return false;
}
