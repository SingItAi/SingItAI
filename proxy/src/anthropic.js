// Translate Anthropic Messages bodies to OpenAI chat completions (and back).
export function mapModel(model, modelMap = {}) {
  if (model == null) return model;
  const raw = String(model).trim();
  if (!raw) return raw;
  return modelMap[raw] ?? modelMap[raw.toLowerCase()] ?? raw;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function systemToText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map(block => (typeof block === "string" ? block : block?.text ?? "")).join("\n");
  return "";
}

function imageToOpenAi(block) {
  const source = block.source ?? {};
  if (source.type === "base64" && source.data) {
    return { type: "image_url", image_url: { url: `data:${source.media_type || "image/png"};base64,${source.data}` } };
  }
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(block) {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(part => part?.text ?? "").join("");
  if (block.content == null) return "";
  return JSON.stringify(block.content);
}

function convertUserContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const out = [];
  const results = blocks.filter(block => block?.type === "tool_result");
  const rest = blocks.filter(block => block?.type !== "tool_result");
  for (const block of results) {
    out.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
  }
  const parts = [];
  for (const block of rest) {
    if (block?.type === "text") parts.push({ type: "text", text: block.text ?? "" });
    else if (block?.type === "image") {
      const image = imageToOpenAi(block);
      if (image) parts.push(image);
    }
  }
  if (parts.length === 1 && parts[0].type === "text") out.push({ role: "user", content: parts[0].text });
  else if (parts.length) out.push({ role: "user", content: parts });
  return out;
}

function convertAssistantContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.filter(block => block?.type === "text").map(block => block.text ?? "").join("");
  const tools = blocks.filter(block => block?.type === "tool_use");
  const message = { role: "assistant", content: text || (tools.length ? null : "") };
  if (tools.length) {
    message.tool_calls = tools.map(block => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  }
  return [message];
}

export function convertAnthropicMessage(message) {
  if (!message || typeof message !== "object") throw badRequest("Each message must be an object.");
  const role = message.role;
  const content = message.content;
  if (typeof content === "string") return [{ role: role === "tool" ? "tool" : role, content }];
  if (!Array.isArray(content)) return [{ role, content: content == null ? "" : String(content) }];
  if (role === "user") {
    const converted = convertUserContent(content);
    return converted.length ? converted : [{ role: "user", content: "" }];
  }
  if (role === "assistant") return convertAssistantContent(content);
  return [{ role, content: content.map(block => block?.text ?? "").join("") }];
}

function convertToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice === "auto" || choice?.type === "auto") return "auto";
  if (choice === "any" || choice?.type === "any") return "required";
  if (choice === "none" || choice?.type === "none") return "none";
  if (choice?.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

export function anthropicToChatCompletions(body, { modelMap = {} } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Send a JSON body.");
  const model = mapModel(body.model, modelMap);
  if (!model) throw badRequest("model is required.");
  if (!Array.isArray(body.messages)) throw badRequest("messages must be an array.");
  const messages = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of body.messages) messages.push(...convertAnthropicMessage(message));
  if (!messages.length) throw badRequest("messages must not be empty.");
  const out = { model, messages };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.stream === true) out.stream = true;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description != null ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

export function chatCompletionToMessage(completion) {
  const choice = completion?.choices?.[0];
  const message = choice?.message ?? {};
  const content = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); }
    catch { input = {}; }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: message.content ?? "" });
  const finish = choice?.finish_reason;
  const stop_reason = finish === "tool_calls" ? "tool_use"
    : finish === "length" ? "max_tokens"
    : "end_turn";
  const result = {
    id: completion.id || "msg_proxy",
    type: "message",
    role: "assistant",
    model: completion.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
  if (completion.billing) result.billing = completion.billing;
  return result;
}

export function estimateTokenCount(body = {}) {
  const parts = [];
  if (body.model) parts.push(String(body.model));
  if (body.system) parts.push(systemToText(body.system));
  for (const message of body.messages ?? []) {
    if (typeof message?.content === "string") parts.push(message.content);
    else if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (typeof block?.text === "string") parts.push(block.text);
        if (block?.input) parts.push(JSON.stringify(block.input));
        if (typeof block?.content === "string") parts.push(block.content);
        if (block?.name) parts.push(block.name);
      }
    }
  }
  for (const tool of body.tools ?? []) {
    if (tool?.name) parts.push(tool.name);
    if (tool?.description) parts.push(tool.description);
    if (tool?.input_schema) parts.push(JSON.stringify(tool.input_schema));
  }
  const chars = parts.join(" ").length;
  return { input_tokens: Math.max(1, Math.ceil(chars / 4)) };
}
