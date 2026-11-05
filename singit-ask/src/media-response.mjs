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
    if (!b || !(b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || b[0] === 255 && b[1] === 216 && b[2] === 255
      || b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')) return false;
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
