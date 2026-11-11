// OpenAI chat-completion, Anthropic Messages and Responses SSE helpers.
import { chatCompletionToResponse } from "./responses.js";
function frame(data, event) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`;
}

/** Turn a settled chat.completion JSON invoice into OpenAI SSE + [DONE]. */
export function completionToOpenAiSse(answer, includeUsage = false) {
  const base = {
    id: answer.id, object: "chat.completion.chunk",
    created: answer.created ?? 0, model: answer.model,
  };
  const choice = answer.choices?.[0] ?? { message: { role: "assistant", content: "" }, finish_reason: "stop" };
  const message = choice.message ?? { role: "assistant", content: "" };
  const delta = { role: "assistant" };
  if (message.content != null) delta.content = message.content;
  if (message.tool_calls) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
  }
  let out = frame({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  const tail = { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] };
  if (answer.billing) tail.billing = answer.billing;
  out += frame(tail);
  if (includeUsage && answer.usage) out += frame({ ...base, choices: [], usage: answer.usage });
  out += frame("[DONE]");
  return out;
}

/** Turn a settled Anthropic message JSON into message_start … message_stop SSE. */
export function messageToAnthropicSse(answer) {
  const { billing: _billing, content, stop_reason: _sr, ...rest } = answer;
  let out = frame({ type: "message_start", message: { ...rest, content: [], stop_reason: null } }, "message_start");
  for (const [index, block] of (answer.content ?? []).entries()) {
    out += frame({
      type: "content_block_start", index,
      content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: block.type || "text", text: "" },
    }, "content_block_start");
    out += frame({
      type: "content_block_delta", index,
      delta: block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) }
        : { type: "text_delta", text: block.text ?? "" },
    }, "content_block_delta");
    out += frame({ type: "content_block_stop", index }, "content_block_stop");
  }
  const delta = { type: "message_delta", delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence ?? null } };
  if (answer.usage) delta.usage = answer.usage;
  if (answer.billing) delta.billing = answer.billing;
  out += frame(delta, "message_delta");
  out += frame({ type: "message_stop" }, "message_stop");
  return out;
}

export function looksLikeSse(text) {
  return /(?:^|\n)(?:data:|event:)/.test(String(text));
}

export function ensureOpenAiDone(text) {
  const raw = String(text);
  if (/(?:^|\n)data:\s*\[DONE\]/.test(raw)) return raw.endsWith("\n") ? raw : `${raw}\n`;
  const pad = raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return `${raw}${pad}data: [DONE]\n\n`;
}

export function parseSseData(text) {
  const items = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const dataLines = [];
    let event;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = dataLines.join("\n");
    if (!data) continue;
    if (data === "[DONE]") items.push({ event, done: true });
    else {
      try { items.push({ event, data: JSON.parse(data) }); }
      catch { items.push({ event, raw: data }); }
    }
  }
  return items;
}

function finishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

/**
 * OpenAI chat chunks to Anthropic Messages events, one chunk at a time: push() returns the SSE text for that chunk
 * and end() the closing events, so a live stream is translated as it arrives. message_delta (stop reason, usage,
 * billing) and message_stop wait for end(), because the usage and billing chunks come last.
 */
export class OpenAiToAnthropic {
  #started = false; #nextIndex = 0; #current = null; #tools = new Map();
  #id; #model; #stop = "end_turn"; #usage; #billing; ended = false;
  #closeCurrent() {
    if (!this.#current) return "";
    const out = frame({ type: "content_block_stop", index: this.#current.index }, "content_block_stop");
    this.#current = null;
    return out;
  }
  #start() {
    if (this.#started) return "";
    this.#started = true;
    return frame({
      type: "message_start",
      message: {
        id: this.#id || "msg_proxy", type: "message", role: "assistant", model: this.#model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    }, "message_start");
  }
  push(chunk) {
    if (this.ended || !chunk || typeof chunk !== "object") return "";
    if (chunk.error) {
      this.ended = true;
      return frame({ type: "error", error: { type: "api_error", message: chunk.error.message || "Upstream request failed." } }, "error");
    }
    if (chunk.object && chunk.object !== "chat.completion.chunk") return "";
    this.#id = chunk.id ?? this.#id;
    this.#model = chunk.model ?? this.#model;
    if (chunk.usage) this.#usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
    if (chunk.billing) this.#billing = chunk.billing;
    let out = this.#start();
    const choice = chunk.choices?.[0] ?? {};
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (this.#current?.kind !== "text") {
        out += this.#closeCurrent();
        this.#current = { kind: "text", index: this.#nextIndex++ };
        out += frame({ type: "content_block_start", index: this.#current.index, content_block: { type: "text", text: "" } }, "content_block_start");
      }
      out += frame({ type: "content_block_delta", index: this.#current.index, delta: { type: "text_delta", text: delta.content } }, "content_block_delta");
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const oi = call.index ?? 0;
        if (!this.#tools.has(oi)) {
          out += this.#closeCurrent();
          this.#current = { kind: "tool", oi, index: this.#nextIndex++ };
          this.#tools.set(oi, this.#current.index);
          out += frame({
            type: "content_block_start", index: this.#current.index,
            content_block: { type: "tool_use", id: call.id, name: call.function?.name, input: {} },
          }, "content_block_start");
        }
        if (call.function?.arguments) {
          out += frame({
            type: "content_block_delta", index: this.#tools.get(oi),
            delta: { type: "input_json_delta", partial_json: call.function.arguments },
          }, "content_block_delta");
        }
      }
    }
    if (choice.finish_reason) this.#stop = finishReason(choice.finish_reason);
    return out;
  }
  end() {
    if (this.ended) return "";
    this.ended = true;
    let out = this.#start() + this.#closeCurrent();
    const tail = { type: "message_delta", delta: { stop_reason: this.#stop, stop_sequence: null } };
    if (this.#usage) tail.usage = this.#usage;
    if (this.#billing) tail.billing = this.#billing;
    return out + frame(tail, "message_delta") + frame({ type: "message_stop" }, "message_stop");
  }
}

/** Translate a complete OpenAI chat SSE body into Anthropic Messages SSE. */
export function openaiSseToAnthropicSse(text) {
  const translator = new OpenAiToAnthropic();
  let out = "";
  for (const item of parseSseData(text)) if (!item.done && item.data) out += translator.push(item.data);
  return out + translator.end();
}

/** Responses SSE is buffered, with an active item before each delta. */
export function responseToSse(response) {
  let sequence = 0;
  const emit = (type, data) => frame({ type, sequence_number: sequence++, ...data }, type);
  let out = emit("response.created", { response: { ...response, status: "in_progress", output: [], usage: null } });
  for (const [output_index, item] of response.output.entries()) {
    out += emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
    if (item.type === "message") {
      for (const [content_index, part] of item.content.entries()) {
        out += emit("response.content_part.added", { output_index, item_id: item.id, content_index, part: { ...part, text: "" } });
        out += emit("response.output_text.delta", { output_index, item_id: item.id, content_index, delta: part.text });
        out += emit("response.output_text.done", { output_index, item_id: item.id, content_index, text: part.text });
        out += emit("response.content_part.done", { output_index, item_id: item.id, content_index, part });
      }
    } else out += emit("response.function_call_arguments.delta", { output_index, item_id: item.id, delta: item.arguments });
    out += emit("response.output_item.done", { output_index, item });
  }
  return out + emit("response.completed", { response });
}

export function responsesErrorSse(message) {
  return frame({ type: "response.failed", sequence_number: 0, response: { id: "resp_proxy_error", object: "response", status: "failed", error: { code: "upstream_error", message } } }, "response.failed");
}

/**
 * OpenAI chat chunks to Responses events as they arrive: output items open on the first delta that needs them, text
 * and argument deltas are relayed immediately, and the closing events plus response.completed (usage, billing) come
 * from end(), once the whole answer is known.
 */
export class OpenAiToResponses {
  #sequence = 0; #started = false; #meta = {}; #text = ""; #message = null; #calls = new Map(); #order = [];
  #usage; #billing; ended = false;
  #emit(type, data) { return frame({ type, sequence_number: this.#sequence++, ...data }, type); }
  get #id() { return this.#meta.id || "resp_proxy"; }
  #completion() {
    const tool_calls = [...this.#calls.values()].map(call => ({ id: call.call_id, function: { name: call.name, arguments: call.arguments } }));
    return { ...this.#meta, choices: [{ message: { content: this.#text, tool_calls } }],
      ...(this.#usage ? { usage: this.#usage } : {}), ...(this.#billing ? { billing: this.#billing } : {}) };
  }
  #openMessage() {
    if (this.#message) return "";
    this.#message = { output_index: this.#order.length };
    this.#order.push("message");
    const item = { id: `${this.#id}_message`, type: "message", status: "in_progress", role: "assistant", content: [] };
    return this.#emit("response.output_item.added", { output_index: this.#message.output_index, item })
      + this.#emit("response.content_part.added", { output_index: this.#message.output_index, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  }
  push(chunk) {
    if (this.ended || !chunk || typeof chunk !== "object") return "";
    if (chunk.error) { this.ended = true; return responsesErrorSse(chunk.error.message || "Upstream request failed."); }
    for (const key of ["id", "model", "created"]) if (chunk[key] != null) this.#meta[key] = chunk[key];
    if (chunk.usage) this.#usage = chunk.usage;
    if (chunk.billing) this.#billing = chunk.billing;
    let out = "";
    if (!this.#started) {
      this.#started = true;
      out += this.#emit("response.created", { response: { id: this.#id, object: "response", created_at: this.#meta.created ?? 0, status: "in_progress", model: this.#meta.model, output: [], usage: null } });
    }
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      out += this.#openMessage();
      this.#text += delta.content;
      out += this.#emit("response.output_text.delta", { output_index: this.#message.output_index, item_id: `${this.#id}_message`, content_index: 0, delta: delta.content });
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      let have = this.#calls.get(index);
      if (!have) {
        have = { n: this.#calls.size, output_index: this.#order.length, call_id: call.id, name: call.function?.name ?? "", arguments: "" };
        this.#calls.set(index, have);
        this.#order.push("call");
        out += this.#emit("response.output_item.added", { output_index: have.output_index,
          item: { id: `${this.#id}_call_${have.n}`, type: "function_call", status: "in_progress", call_id: have.call_id, name: have.name, arguments: "" } });
      } else {
        if (call.id && !have.call_id) have.call_id = call.id;
        if (call.function?.name) have.name += call.function.name;
      }
      const piece = call.function?.arguments;
      if (piece) {
        have.arguments += piece;
        out += this.#emit("response.function_call_arguments.delta", { output_index: have.output_index, item_id: `${this.#id}_call_${have.n}`, delta: piece });
      }
    }
    return out;
  }
  end() {
    if (this.ended) return "";
    this.ended = true;
    if (!this.#started) return responsesErrorSse("Upstream returned an unreadable stream.");
    let out = "";
    if (!this.#message && !this.#calls.size) out += this.#openMessage();
    const response = chatCompletionToResponse(this.#completion());
    for (const [output_index, item] of response.output.entries()) {
      if (item.type === "message") {
        const part = item.content[0];
        out += this.#emit("response.output_text.done", { output_index, item_id: item.id, content_index: 0, text: part.text });
        out += this.#emit("response.content_part.done", { output_index, item_id: item.id, content_index: 0, part });
      } else out += this.#emit("response.function_call_arguments.done", { output_index, item_id: item.id, arguments: item.arguments });
      out += this.#emit("response.output_item.done", { output_index, item });
    }
    return out + this.#emit("response.completed", { response });
  }
}

export function openaiSseToResponsesSse(text) {
  const translator = new OpenAiToResponses();
  let out = "";
  for (const item of parseSseData(text)) {
    if (item.done || !item.data) continue;
    out += translator.push(item.data);
    if (translator.ended) return out;
  }
  return out + translator.end();
}

/** Frames of a live SSE body as they complete. `comment` frames (keepalives) are reported so they can be relayed. */
export async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = block => {
    const data = [];
    let event, comment = false;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) comment = true;
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return comment ? { comment: true } : null;
    const raw = data.join("\n");
    if (raw === "[DONE]") return { event, done: true };
    try { return { event, data: JSON.parse(raw) }; } catch { return { event, raw }; }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    for (let end; (end = buffer.indexOf("\n\n")) >= 0;) {
      const item = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (item) yield item;
    }
  }
  buffer += decoder.decode().replace(/\r\n?/g, "\n");
  const tail = buffer.trim() ? parse(buffer) : null;
  if (tail) yield tail;
}
