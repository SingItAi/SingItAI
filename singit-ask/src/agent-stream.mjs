import { ServerResponse } from 'node:http';
import { sseEvents, frameOf } from './sse-read.mjs';
// stream:false never writes a byte before settlement. stream:true relays the model's tokens as they arrive (LiveSSE
// below) and holds back only the terminal events, which carry the billing, until the payment has settled.
export function validateStream(body, ErrorClass) {
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ErrorClass(400, 'stream must be boolean.');
  if (body.stream_options !== undefined && (body.stream !== true || !body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) throw new ErrorClass(400, 'stream_options requires stream:true and only include_usage:boolean.');
}
export function bufferedSSE(path, answer, includeUsage = false) {
  const events = [];
  const emit = (data, event) => events.push(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  if (path === '/v1/messages') {
    emit({ type: 'message_start', message: { ...answer, content: [], stop_reason: null, billing: undefined } }, 'message_start');
    for (const [index, block] of (answer.content ?? []).entries()) {
      emit({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } }, 'content_block_start');
      emit({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } }, 'content_block_delta');
      emit({ type: 'content_block_stop', index }, 'content_block_stop');
    }
    emit({ type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence ?? null }, usage: answer.usage, billing: answer.billing }, 'message_delta');
    emit({ type: 'message_stop' }, 'message_stop');
  } else if (path === '/v1/responses') {
    let sequence_number = 0;
    const event = (type, fields) => emit({ type, sequence_number: sequence_number++, ...fields }, type);
    event('response.created', { response: { ...answer, status: 'in_progress', output: [], billing: undefined } });
    for (const [output_index, item] of (answer.output ?? []).entries()) {
      event('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
      if (item.type === 'function_call') {
        event('response.function_call_arguments.delta', { output_index, item_id: item.id, delta: item.arguments });
        event('response.function_call_arguments.done', { output_index, item_id: item.id, arguments: item.arguments });
      } else for (const [content_index, part] of (item.content ?? []).entries()) {
        event('response.content_part.added', { output_index, content_index, item_id: item.id, part: { ...part, text: '' } });
        event('response.output_text.delta', { output_index, content_index, item_id: item.id, delta: part.text, logprobs: [] });
        event('response.output_text.done', { output_index, content_index, item_id: item.id, text: part.text, logprobs: [] });
        event('response.content_part.done', { output_index, content_index, item_id: item.id, part });
      }
      event('response.output_item.done', { output_index, item });
    }
    event('response.completed', { response: answer });
  } else {
    const base = { id: answer.id, object: 'chat.completion.chunk', created: answer.created, model: answer.model };
    const choice = answer.choices[0], message = choice.message;
    const delta = { role: 'assistant', ...(message.content != null ? { content: message.content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
    emit({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], billing: answer.billing });
    if (includeUsage) emit({ ...base, choices: [], usage: answer.usage });
    emit('[DONE]');
  }
  return events.join('');
}

// ---- live streaming ------------------------------------------------------------------------------------------
// @x402/express 2.28 replaces res.writeHead/write/end/flushHeaders with buffers that are replayed only after
// processSettlement, so a handler that calls res.write() releases nothing until the whole answer exists. Live streaming
// writes through ServerResponse.prototype instead, which the buffers do not wrap, and then hands the middleware the
// same single res.end() it always gets: it settles once (or cancels when the status is >= 400) and replays that end(),
// which here releases the terminal events. No payment step is added or skipped; only when bytes leave changes.
const proto = ServerResponse.prototype;

export class StreamBreak extends Error {
  constructor(code, status = 0) { super(`upstream stream ${code}`); this.name = 'StreamBreak'; this.code = code; this.status = status; }
}

// One model call's view of the client stream. Everything it emits is held until `commit` (the first data event the
// client can use); a call that is abandoned (cut for a fallback, timed out) can no longer write.
export class LiveAttempt {
  constructor(live) { this.live = live; this.controller = new AbortController(); this.signal = this.controller.signal; this.abandoned = false; this.pending = []; this.sentRole = false; live.attempts.add(this); }
  get committed() { return this.live.owner === this; }
  reset() { this.pending = []; this.sentRole = false; }
  emit(text, { commit = false } = {}) {
    const live = this.live;
    if (this.abandoned || (live.owner && live.owner !== this)) throw new StreamBreak('abandoned');
    if (!this.committed) {
      if (!commit) { this.pending.push(text); return; }
      live.owner = this; live.dataSent = true; live.open();
    }
    for (const held of this.pending) live.raw(held);
    this.pending = [];
    live.raw(text);
  }
  abandon() { if (this.abandoned) return; this.abandoned = true; this.controller.abort(); }
}

export class LiveSSE {
  constructor(req, res, { keepaliveMs = 15_000, writeHead = res.writeHead } = {}) {
    Object.assign(this, { req, res, keepaliveMs, writeHeadChain: writeHead, started: false, dataSent: false, owner: null, final: '', closed: false,
      attempts: new Set(), timer: null, lastWrite: 0, keepalives: 0, onCommit: null, onServed: null, includeUsage: req.body?.stream_options?.include_usage === true });
    res.on('finish', () => this.stop());
    res.on('close', () => { this.stop(); if (!res.writableFinished) for (const attempt of this.attempts) attempt.abandon(); });
  }
  attempt() { return new LiveAttempt(this); }
  // Headers leave at the first data event, or at the first keepalive on a slow model; until then a failure is still JSON.
  open() {
    if (this.started) return;
    const res = this.res;
    this.started = true;
    this.onCommit?.();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.statusCode = 200;
    this.writeHeadChain.call(res, 200);
    this.shimHeaders();
    proto.flushHeaders.call(res);
    this.lastWrite = Date.now();
  }
  // After the head is out the middleware still sets PAYMENT-RESPONSE, Cache-Control and the settlement override;
  // those can no longer reach the wire, so they are kept (and visible to getHeaders) instead of throwing.
  shimHeaders() {
    const res = this.res, late = new Map();
    const { setHeader, removeHeader, getHeader, getHeaders } = res;
    const lower = name => String(name).toLowerCase();
    res.setHeader = (name, value) => { try { return setHeader.call(res, name, value); } catch (error) { if (!res.headersSent) throw error; late.set(lower(name), value); return res; } };
    res.removeHeader = name => { late.delete(lower(name)); try { return removeHeader.call(res, name); } catch (error) { if (!res.headersSent) throw error; } };
    res.getHeader = name => late.has(lower(name)) ? late.get(lower(name)) : getHeader.call(res, name);
    res.getHeaders = () => ({ ...getHeaders.call(res), ...Object.fromEntries(late) });
  }
  raw(text) {
    const res = this.res;
    if (res.destroyed || res.writableEnded) return;
    this.lastWrite = Date.now();
    proto.write.call(res, text);
  }
  arm() {
    if (this.timer || !(this.keepaliveMs > 0)) return;
    this.lastWrite = Date.now();
    this.timer = setInterval(() => {
      // A JSON answer or refusal that went out on its own ends the wait.
      if (this.closed || this.res.writableEnded || (this.res.headersSent && !this.started)) return this.stop();
      if (Date.now() - this.lastWrite < this.keepaliveMs / 2) return;
      this.open();
      this.raw(': keepalive\n\n');
      this.keepalives++;
    }, this.keepaliveMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  // Called with the real end() once the middleware replays it: after settlement, or after a cancellation.
  close(end) {
    if (this.closed) return;
    this.closed = true; this.stop();
    const res = this.res;
    if (res.statusCode < 400 && this.final) { this.onServed?.(); end.call(res, this.final); }
    else end.call(res);
  }
  // The stream cannot be finished: no terminal events, and a status the middleware reads as "do not charge".
  // With a `body` (the native format routes), a 200 stream that only sent keepalives gets one `event: error` frame carrying it, so the
  // client is not left with an empty success (after data the stream just ends: tests/agent-stream.test.mjs); chat passes none and keeps ending silently.
  abort(status = 503, body = null) {
    this.stop();
    for (const attempt of this.attempts) attempt.abandon();
    if (!this.res.writableEnded) {
      this.res.statusCode = status;
      if (body && this.started && !this.dataSent) this.raw(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      this.res.end();
    }
  }
}

const scrubUsage = usage => {
  if (!usage || typeof usage !== 'object') return usage;
  const { cost, is_byok, cost_details, buyer_cost_micro, ...rest } = usage;
  return rest;
};
const scrubEnvelope = obj => {
  if (!obj || typeof obj !== 'object') return obj;
  const { provider, cost, ...rest } = obj;
  return { ...rest, ...(rest.usage ? { usage: scrubUsage(rest.usage) } : {}) };
};
const nonEmpty = v => typeof v === 'string' && v.length > 0;
const errorOf = (ev, fallback = 'stream_error') => new StreamBreak(typeof ev?.error?.code === 'string' ? ev.error.code : typeof ev?.error?.type === 'string' ? ev.error.type : fallback);

// Chat Completions chunks: content and tool_call deltas go out as they arrive; the finish chunk, the usage chunk and
// [DONE] are held for the terminal events. Resolves to a chat.completion-shaped answer; `error` when the model sent
// an error event before anything was released.
export async function consumeChatStream(response, attempt) {
  attempt.reset();
  let content = '', finish = null, usage = null, done = false;
  const calls = new Map();
  for await (const { data } of sseEvents(response.body)) {
    if (data === '[DONE]') { done = true; break; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk?.error) { if (attempt.committed) throw errorOf(chunk); return { error: chunk.error }; }
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (nonEmpty(delta.content)) content += delta.content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(call.index) ? call.index : calls.size;
      const have = calls.get(index) ?? { id: undefined, type: 'function', function: { name: '', arguments: '' } };
      if (call.id) have.id = call.id;
      if (call.function?.name) have.function.name += call.function.name;
      if (typeof call.function?.arguments === 'string') have.function.arguments += call.function.arguments;
      calls.set(index, have);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    const out = {};
    if (nonEmpty(delta.content)) out.content = delta.content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) out.tool_calls = delta.tool_calls;
    if (Object.keys(out).length) {
      attempt.emit(frameOf({ ...attempt.base(), choices: [{ index: 0, delta: { ...(attempt.sentRole ? {} : { role: 'assistant' }), ...out }, finish_reason: null }] }), { commit: true });
      attempt.sentRole = true;
    }
  }
  if (!finish) throw new StreamBreak(done ? 'no_finish' : 'truncated');
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return { choices: [{ message: { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: finish }], usage };
}

// Anthropic Messages events. message_delta (usage, stop reason, billing) and message_stop are held for the end.
export async function consumeMessagesStream(response, attempt) {
  attempt.reset();
  let message = null, usage = {}, stop_reason = null, stop_sequence = null, text = false, tool = false, done = false;
  const content = [];
  for await (const { event, data } of sseEvents(response.body)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    const type = ev?.type ?? event;
    if (type === 'error') { if (attempt.committed) throw errorOf(ev); return { type: 'error', error: ev.error ?? {} }; }
    if (type === 'message_stop') { done = true; break; }
    if (type === 'message_delta') {
      usage = { ...usage, ...ev.usage };
      stop_reason = ev.delta?.stop_reason ?? stop_reason; stop_sequence = ev.delta?.stop_sequence ?? stop_sequence;
      continue;
    }
    let commit = false;
    if (type === 'message_start') { message = ev.message ?? {}; usage = { ...message.usage }; ev = { ...ev, message: scrubEnvelope({ ...message, billing: undefined }) }; }
    else if (type === 'content_block_start') {
      const block = ev.content_block ?? {};
      content[ev.index] = { type: block.type };
      if (block.type === 'tool_use') { tool = true; commit = true; }
      if (block.type === 'text' && nonEmpty(block.text)) { text = true; commit = true; }
    } else if (type === 'content_block_delta') {
      const delta = ev.delta ?? {};
      if ((delta.type === 'text_delta' && nonEmpty(delta.text)) || delta.type === 'input_json_delta') { commit = true; if (delta.type === 'text_delta') text = true; }
    } else if (type !== 'content_block_stop' && type !== 'ping') continue;
    attempt.emit(frameOf(ev, type), { commit });
  }
  if (!done) throw new StreamBreak('truncated');
  const blocks = [...(text ? [{ type: 'text', text: '…' }] : []), ...(tool ? [{ type: 'tool_use' }] : []), ...content.filter(b => b && !['text', 'tool_use'].includes(b.type))];
  return { ...message, content: blocks, stop_reason, stop_sequence, usage };
}

// OpenAI Responses events. The final response.completed / response.incomplete carries usage and the whole response:
// held for the end.
export async function consumeResponsesStream(response, attempt) {
  attempt.reset();
  let final = null, finalType = null, sequence = 0;
  for await (const { event, data } of sseEvents(response.body)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    const type = ev?.type ?? event;
    if (type === 'error' || type === 'response.failed') { if (attempt.committed) throw errorOf(ev.response ?? ev); return type === 'error' ? { error: ev.error ?? ev } : { ...ev.response, status: 'failed', error: ev.response?.error ?? { code: 'failed' } }; }
    if (type === 'response.completed' || type === 'response.incomplete') { final = ev.response ?? {}; finalType = type; sequence = ev.sequence_number ?? 0; break; }
    const commit = (type === 'response.output_text.delta' && nonEmpty(ev.delta)) || type === 'response.function_call_arguments.delta'
      || (type === 'response.output_item.added' && ev.item?.type === 'function_call');
    attempt.emit(frameOf({ ...ev, ...(ev.response ? { response: scrubEnvelope({ ...ev.response, billing: undefined }) } : {}) }, type), { commit });
  }
  if (!final) throw new StreamBreak('truncated');
  return Object.defineProperties(final, { terminalType: { value: finalType }, sequence_number: { value: sequence } });
}

// The events the client gets last, after settlement. Billing rides on them exactly as the buffered answer put it.
export function terminalSSE(path, { answer, billing, base, includeUsage = false }) {
  if (path === '/v1/messages') {
    return frameOf({ type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence ?? null }, usage: scrubUsage(answer.usage), billing }, 'message_delta')
      + frameOf({ type: 'message_stop' }, 'message_stop');
  }
  if (path === '/v1/responses') {
    const type = answer.terminalType ?? 'response.completed';
    return frameOf({ type, sequence_number: answer.sequence_number ?? 0, response: { ...scrubEnvelope(answer), billing } }, type);
  }
  const choice = answer.choices[0];
  return frameOf({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], billing })
    + (includeUsage ? frameOf({ ...base, choices: [], usage: answer.usage }) : '') + frameOf('[DONE]');
}

export function agentResponses(stats) {
  return (req, res, next) => {
    const json = res.json;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (this.statusCode < 400 && String(this.getHeader("Content-Type")).startsWith("text/event-stream")) this.setHeader("Cache-Control", "no-cache");
      return writeHead.apply(this, args);
    };
    let answered = false;
    res.locals.markAnswered = () => { answered = true; };
    // The payment middleware captures end() when it verifies; this wrapper is in place before that, so the replay
    // it makes after settlement lands here and can release the held terminal events (see LiveSSE).
    const end = res.end;
    res.end = function (...args) { const live = res.locals?.live; return live?.started ? live.close(end.bind(this)) : end.apply(this, args); };
    res.json = function (body) {
      if (this.statusCode < 400 && req.method === 'POST' && (body?.object === 'chat.completion' || (req.path === '/v1/messages' && body?.type === 'message') || (req.path === '/v1/responses' && body?.object === 'response'))) {
        answered = true;
        if (req.body?.stream === true) {
          const wire = bufferedSSE(req.path, body, req.body.stream_options?.include_usage);
          return this.set('Content-Type', 'text/event-stream; charset=utf-8').set('Cache-Control', 'no-cache').send(wire);
        }
      }
      return json.call(this, body);
    };
    res.on('finish', () => { if (answered && res.statusCode < 400) stats.recordAgent(req); });
    next();
  };
}

// After the body is parsed: a request that asks for stream:true gets a LiveSSE the paid handlers can use.
export function liveStreams({ keepaliveMs } = {}) {
  return (req, res, next) => {
    if (req.method === 'POST' && req.body?.stream === true) {
      const live = res.locals.live = new LiveSSE(req, res, { keepaliveMs, writeHead: res.writeHead });
      live.onServed = () => res.locals.markAnswered?.();
    }
    next();
  };
}
