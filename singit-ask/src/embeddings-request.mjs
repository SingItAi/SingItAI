const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// E5: exact on a conservative estimate, one token per UTF-8 byte (including per-item overhead).
// No usage refund is promised; the quoted amount is settled only after a valid upstream response.
export const MAX_INPUT_BYTES = 100_000;
export const maxListAtomic = (model, config = {}) => Math.ceil((config.maxEmbeddingBytes ?? MAX_INPUT_BYTES) * model.usdPerMillionTokens);
export async function catalogueCeiling(catalogue, config = {}) {
  const models = await catalogue?.embeddingModels?.() ?? new Map();
  return Math.max(0, ...[...models.values()].map(model => maxListAtomic(model, config)));
}
export function readEmbeddingRequest(body, model, config = {}) {
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
  if (inputs.length > (config.maxEmbeddingInputs ?? 256)) fail(422, 'Too many embedding inputs.');
  if (!inputs.length || inputs.some(s => typeof s !== 'string' || !s.trim())) fail(422, 'Send nonempty input strings.');
  if (inputs.reduce((n, s) => n + Buffer.byteLength(s) + 8, 0) > (config.maxEmbeddingBytes ?? MAX_INPUT_BYTES)) fail(413, 'Embedding input is too large.');
  if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) fail(422, 'encoding_format must be float or base64.');
  return { model: model.id, input: body.input, encoding_format: body.encoding_format ?? 'float' };
}
export function listAtomic(model, request) {
  const tokens = [].concat(request.input).reduce((n, s) => n + Buffer.byteLength(s) + 8, 0);
  return Math.ceil(tokens * model.usdPerMillionTokens);
}
export const EXAMPLE = { model: 'venice-embed-1', input: 'Hello world' };
export const INPUT_SCHEMA = { required: ['model', 'input'], properties: {
  model: { type: 'string', description: 'Embedding model from GET /v1/models.' },
  input: { description: 'A nonempty string or array of nonempty strings.', oneOf: [{ type: 'string' }, { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } }] },
  encoding_format: { type: 'string', enum: ['float', 'base64'], default: 'float', description: 'Return embedding vectors as float arrays or base64 strings.' },
} };
export const OUTPUT_SCHEMA = { type: 'object', required: ['object', 'data', 'model', 'billing'], properties: {
  object: { type: 'string' }, model: { type: 'string' }, data: { type: 'array', items: { type: 'object', properties: {
    embedding: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'string' }] }, index: { type: 'integer' }, object: { type: 'string' },
  } } }, usage: { type: 'object' }, billing: { type: 'object' },
} };
export const OUTPUT_EXAMPLE = { object: 'list', model: 'venice-embed-1', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], billing: { currency: 'USDC' } };
