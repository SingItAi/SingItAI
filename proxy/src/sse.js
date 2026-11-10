// OpenAI chat-completion SSE and Anthropic Messages SSE helpers.
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

/** Translate a complete OpenAI chat SSE body into Anthropic Messages SSE. */
export function openaiSseToAnthropicSse(text) {
  const items = parseSseData(text);
  let out = "";
  const emit = (payload, event) => { out += frame(payload, event); };
  let started = false;
  let textIndex = null;
  const tools = new Map();
  let nextIndex = 0;
  let model;
  let id;
  let stop_reason = "end_turn";
  let usage;
  for (const item of items) {
    if (item.done || !item.data || typeof item.data !== "object") continue;
    const chunk = item.data;
    if (chunk.object && chunk.object !== "chat.completion.chunk") continue;
    id = chunk.id ?? id;
    model = chunk.model ?? model;
    if (chunk.usage) {
      usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
    }
    if (!started) {
      started = true;
      emit({
        type: "message_start",
        message: {
          id: id || "msg_proxy", type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }, "message_start");
    }
    const choice = chunk.choices?.[0] ?? {};
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (textIndex == null) {
        textIndex = nextIndex++;
        emit({ type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }, "content_block_start");
      }
      emit({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } }, "content_block_delta");
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const oi = call.index ?? 0;
        if (!tools.has(oi)) {
          const idx = nextIndex++;
          tools.set(oi, idx);
          emit({
            type: "content_block_start", index: idx,
            content_block: { type: "tool_use", id: call.id, name: call.function?.name, input: {} },
          }, "content_block_start");
        }
        if (call.function?.arguments) {
          emit({
            type: "content_block_delta", index: tools.get(oi),
            delta: { type: "input_json_delta", partial_json: call.function.arguments },
          }, "content_block_delta");
        }
      }
    }
    if (choice.finish_reason) stop_reason = finishReason(choice.finish_reason);
  }
  if (!started) {
    emit({
      type: "message_start",
      message: {
        id: "msg_proxy", type: "message", role: "assistant",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }, "message_start");
  }
  if (textIndex != null) emit({ type: "content_block_stop", index: textIndex }, "content_block_stop");
  for (const idx of tools.values()) emit({ type: "content_block_stop", index: idx }, "content_block_stop");
  const tail = { type: "message_delta", delta: { stop_reason, stop_sequence: null } };
  if (usage) tail.usage = usage;
  emit(tail, "message_delta");
  emit({ type: "message_stop" }, "message_stop");
  return out;
}
