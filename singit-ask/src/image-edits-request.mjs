import { readImageRequest, imageListAtomic } from './images.mjs';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function readEditRequest(body, model, config = {}) {
  if (body?.n !== undefined && body.n !== 1) fail(422, 'Only n=1 is supported.');
  const images = Array.isArray(body?.image) ? body.image : [body?.image];
  if (!images.length || images.length > 4 || images.length > 1 && body.mask !== undefined) fail(422, 'Send one to four images; masks require one image.');
  for (const image of [...images, ...(body.mask === undefined ? [] : [body.mask])]) {
    const match = typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[2].length % 4 !== 0) fail(422, 'Send PNG, JPEG or WEBP base64 data URIs.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > (config.maxEditImageBytes ?? 8 * 1024 * 1024)) fail(413, 'The decoded image is too large.');
    const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid || bytes.toString('base64') !== match[2]) fail(422, 'Invalid image data.');
  }
  let request;
  try { request = readImageRequest(body, model); } catch (error) { fail(422, error.message); }
  return { ...request, image: body.image, ...(body.mask === undefined ? {} : { mask: body.mask }) };
}
// Edit models are priced per image and requests permit exactly one output image.
export const maxListAtomic = model => imageListAtomic(model, { n: 1 });
export async function catalogueCeiling(catalogue) {
  const models = await catalogue?.editModels?.() ?? new Map();
  return Math.max(0, ...[...models.values()].map(maxListAtomic));
}
export const listAtomic = imageListAtomic;
export const EXAMPLE = { model: 'qwen-image-2-edit', prompt: 'Make the background green', image: 'data:image/png;base64,iVBORw0KGgo=' };
export const INPUT_SCHEMA = { required: ['model', 'prompt', 'image'], properties: {
  model: { type: 'string', description: 'Edit model from GET /v1/images/models.' }, prompt: { type: 'string', description: 'The requested edit.' },
  image: { description: 'PNG, JPEG or WEBP data URI, or up to four data URIs.', oneOf: [{ type: 'string' }, { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } }] },
  mask: { type: 'string', description: 'Mask data URI; only with one image.' }, size: { type: 'string', description: 'Output size supported by the edit model, for example 1024x1024.' }, n: { type: 'integer', const: 1, description: 'Number of output images; only one is supported.' },
} };
export const OUTPUT_SCHEMA = { type: 'object', required: ['data', 'billing'], properties: { data: { type: 'array', items: { type: 'object', properties: { b64_json: { type: 'string' }, url: { type: 'string' } } } }, billing: { type: 'object' } } };
export const OUTPUT_EXAMPLE = { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }], billing: { currency: 'USDC' } };
