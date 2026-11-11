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

export function openaiSseToResponsesSse(text) {
  const completion = { choices: [{ message: { content: "", tool_calls: [] } }] };
  const tools = new Map();
  let hasChoice = false;
  for (const { data } of parseSseData(text)) {
    if (!data) continue;
    if (data.error) return responsesErrorSse(data.error.message || "Upstream request failed.");
    for (const key of ["id", "model", "created", "usage", "billing"]) if (data[key] != null) completion[key] = data[key];
    if (data.choices?.length) hasChoice = true;
    const delta = data.choices?.[0]?.delta;
    if (!delta) continue;
    completion.choices[0].message.content += delta.content ?? "";
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const accumulated = tools.get(index) ?? { type: "function", function: { name: "", arguments: "" } };
      if (call.id) accumulated.id = call.id;
      accumulated.function.name += call.function?.name ?? "";
      accumulated.function.arguments += call.function?.arguments ?? "";
      tools.set(index, accumulated);
    }
  }
  if (!hasChoice) return responsesErrorSse("Upstream returned an unreadable stream.");
  completion.choices[0].message.tool_calls = [...tools.values()];
  return responseToSse(chatCompletionToResponse(completion));
}
