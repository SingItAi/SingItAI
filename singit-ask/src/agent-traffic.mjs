// Fixed product labels only; never persist client headers or conversation data.
export const SOURCES = ['openai-python', 'openai-node', 'langchain', 'litellm', 'vercel-ai', 'cursor', 'claude-code', 'continue', 'openclaw', 'codex', 'curl', 'browser', 'singit-proxy', 'singit-mcp', 'other'];
const FIELDS = ['calls', 'with_tools', 'with_stream', 'with_images'];
export const emptyTraffic = () => ({ calls: 0, with_tools: 0, with_stream: 0, with_images: 0, by_source: Object.fromEntries(SOURCES.map(s => [s, 0])) });
export function validTraffic(t) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const count = n => Number.isSafeInteger(n) && n >= 0;
  // Missing newly-added source keys are treated as zero so an older persisted file stays valid.
  return object(t) && Object.keys(t).length === 5 && FIELDS.every(k => count(t[k])) && FIELDS.slice(1).every(k => t[k] <= t.calls) && object(t.by_source)
    && Object.values(t.by_source).every(count)
    && SOURCES.every(k => !Object.hasOwn(t.by_source, k) || count(t.by_source[k]))
    && Object.values(t.by_source).reduce((a,b) => a+b,0) === t.calls;
}
export function clientSource(req) {
  const explicit = req.get('x-singit-client');
  if (explicit !== undefined) {
    const token = String(explicit).trim().toLowerCase().split('/')[0];
    return /^[a-z0-9._-]{1,32}$/.test(token) && SOURCES.includes(token) ? token : 'other';
  }
  const ua = (req.get('user-agent') ?? '').toLowerCase();
  if (/^openai\/python(?:\s|$)/.test(ua)) return 'openai-python';
  if (/^openai\/(?:node|js)(?:\s|$)/.test(ua)) return 'openai-node';
  const products = ua.split(/\s+/).map(p => p.split('/')[0]);
  for (const source of SOURCES) if (products.includes(source)) return source;
  if (products.some(p => ['mozilla', 'chrome', 'safari', 'firefox'].includes(p))) return 'browser';
  return 'other';
}
export function recordTraffic(stats, req) {
  const b = req.body ?? {};
  const hasImage = value => Array.isArray(value) ? value.some(hasImage) : value && typeof value === 'object' ? ['image_url', 'image', 'input_image'].includes(value.type) || Object.values(value).some(hasImage) : false;
  const hasTool = value => Array.isArray(value) ? value.some(hasTool) : value && typeof value === 'object' ? value.role === 'tool' || ['tool_use', 'tool_result', 'function_call', 'function_call_output'].includes(value.type) || (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) || Object.values(value).some(hasTool) : false;
  const flags = { with_tools: (Array.isArray(b.tools) && b.tools.length > 0) || hasTool(b.messages ?? b.input), with_stream: b.stream === true, with_images: hasImage(b.messages ?? b.input) };
  for (const target of [stats.state, stats.bucket()]) {
    const t = target.agent_traffic ??= emptyTraffic();
    t.calls++;
    const source = clientSource(req);
    t.by_source[source] = (t.by_source[source] ?? 0) + 1;
    for (const [key, value] of Object.entries(flags)) if (value) t[key]++;
  }
  stats.changed();
}
export function trafficNumbers(stats) {
  const sum = targets => targets.reduce((a, t) => {
    if (!t.agent_traffic) return a;
    for (const k of FIELDS) a[k] += t.agent_traffic[k];
    for (const k of SOURCES) a.by_source[k] += t.agent_traffic.by_source[k] ?? 0;
    return a;
  }, emptyTraffic());
  return { total: sum([stats.state]), last_24h: sum(stats.window(24)), last_7d: sum(stats.window(168)) };
}
