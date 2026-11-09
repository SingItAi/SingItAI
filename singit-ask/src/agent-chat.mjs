import { AGENT_LIMITS, IMAGE_CHAR_ALLOWANCE } from './limits.mjs';
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const nameOK = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v);
const idOK = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 64;
export function toolCalls(value) {
  if (!Array.isArray(value) || !value.length || value.length > AGENT_LIMITS.toolCalls) return null;
  if (value.some(c => !idOK(c?.id) || c.type !== 'function' || !nameOK(c.function?.name) || typeof c.function.arguments !== 'string')) return null;
  return value.map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
}
export function normalizeAgent(body, ErrorClass) {
  const fail = (message, code = 'invalid_request') => { throw Object.assign(new ErrorClass(400, message), { code }); };
  if (body.functions != null || body.function_call != null) fail('Legacy functions/function_call are unsupported; use tools.', 'tools_unsupported');
  let tools, toolChoice, parallelToolCalls, chars = 0, images = 0;
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > AGENT_LIMITS.tools) fail('Send at most 64 tools.');
    tools = body.tools.map(t => {
      const f = t?.function;
      if (t?.type !== 'function' || !nameOK(f?.name) || (f.description !== undefined && (typeof f.description !== 'string' || f.description.length > 4000)) || (f.parameters !== undefined && !plain(f.parameters))) fail('Invalid function tool.');
      return { type: 'function', function: { name: f.name, ...(f.description !== undefined ? { description: f.description } : {}), ...(f.parameters !== undefined ? { parameters: f.parameters } : {}) } };
    });
    chars += JSON.stringify(body.tools).length;
  }
  if (body.tool_choice != null) {
    if (!tools?.length) fail('tool_choice requires tools.');
    if (['none', 'auto', 'required'].includes(body.tool_choice)) toolChoice = body.tool_choice;
    else if (['auto', 'none'].includes(body.tool_choice?.type)) toolChoice = body.tool_choice.type;
    else if (body.tool_choice?.type === 'function' && tools.some(t => t.function.name === body.tool_choice.function?.name)) toolChoice = { type: 'function', function: { name: body.tool_choice.function.name } };
    else fail('Invalid tool_choice; the function must be one of tools.');
  }
  if (body.parallel_tool_calls != null) {
    if (!tools?.length || typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls requires tools and must be boolean.');
    parallelToolCalls = body.parallel_tool_calls;
  }
  const content = (value, role) => {
    if (typeof value === 'string') { chars += value.length; return value; }
    if (!Array.isArray(value)) fail('Each message needs text or content blocks.');
    return value.map(b => {
      if (b?.type === 'text' && typeof b.text === 'string') { chars += b.text.length; return { type: 'text', text: b.text }; }
      if (b?.type === 'image_url' && role !== 'tool') {
        const url = b.image_url?.url, detail = b.image_url?.detail;
        let https = false;
        try { https = new URL(url).protocol === 'https:'; } catch {}
        if (typeof url !== 'string' || (!https && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) || (detail !== undefined && !['auto','low','high'].includes(detail))) fail('Invalid image URL or detail.');
        if (++images > AGENT_LIMITS.images) fail('At most 4 images per request.');
        chars += IMAGE_CHAR_ALLOWANCE;
        return { type: 'image_url', image_url: { url, ...(detail !== undefined ? { detail } : {}) } };
      }
      fail('Unsupported content block.');
    });
  };
  const messages = body.messages.map(m => {
    if (!m || !['system','developer','user','assistant','tool'].includes(m.role)) fail('Invalid message role.');
    const calls = m.role === 'assistant' && m.tool_calls != null ? toolCalls(m.tool_calls) : undefined;
    if (calls === null) fail('Invalid assistant tool_calls.');
    if (m.role === 'tool' && !idOK(m.tool_call_id)) fail('Tool messages require tool_call_id.');
    if (calls) chars += calls.reduce((n,c) => n + c.function.name.length + c.function.arguments.length, 0);
    // Surplus uses system messages for developer instructions.
    return { role: m.role === 'developer' ? 'system' : m.role, content: calls && m.content == null ? null : content(m.content, m.role), ...(calls ? { tool_calls: calls } : {}), ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {}) };
  });
  if (chars > AGENT_LIMITS.chars) fail(`Keep the request under ${AGENT_LIMITS.chars} characters-equivalent.`);
  return { messages, chars, ...(tools ? { tools } : {}), ...(toolChoice !== undefined ? { toolChoice } : {}), ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}), flags: { tools: !!tools?.length || messages.some(m => m.tool_calls || m.role === 'tool'), images } };
}
export function unsupportedCapability(info, flags) {
  if (flags?.tools && (Array.isArray(info?.params) || Array.isArray(info?.features)) && !info?.params?.includes('tools') && !(info.features ?? []).some(f => ['tools','tool_use','function_calling'].includes(f))) return 'tools';
  if (flags?.images && Array.isArray(info?.inputs) && !info.inputs.includes('image') && !info.features?.includes('vision')) return 'images';
  return null;
}
export function capabilityError(kind, model, ErrorClass = Error) {
  const message = `${model} does not support ${kind}. Pick another model from GET /v1/models or use singit/auto.`;
  return Object.assign(ErrorClass === Error ? new Error(message) : new ErrorClass(400, message), { status: 400, code: `${kind}_unsupported_for_model` });
}
