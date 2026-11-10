// Stateless Responses <-> Chat Completions translation. No network or wallet I/O.
import { mapModel } from "./anthropic.js";
const bad = message => Object.assign(new Error(message), { status: 400 });
const text = value => typeof value === "string" ? value : Array.isArray(value)
  ? value.map(part => typeof part === "string" ? part : ["input_text", "output_text", "text"].includes(part?.type) ? part.text ?? "" : "").join("") : "";

export function responsesToChatCompletions(body, { modelMap = {}, catalog } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Send a JSON body.");
  if (typeof body.model !== "string" || !body.model.trim()) throw bad("model is required.");
  if (!Array.isArray(body.input) && typeof body.input !== "string") throw bad("input must be a string or array.");
  let model = mapModel(body.model, modelMap);
  if (catalog && ["auto", "singit/auto"].includes(model)) {
    model = catalog.default || (Array.isArray(catalog.data) ? catalog.data : []).find(item => typeof item?.id === "string" && !/music|sound|embed|image|video|speech|transcri/i.test(item.id))?.id || model;
  }
  const messages = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== "string") throw bad("instructions must be a string.");
    messages.push({ role: "system", content: body.instructions });
  }
  for (const item of typeof body.input === "string" ? [body.input] : body.input) {
    if (typeof item === "string") messages.push({ role: "user", content: item });
    else if (!item || typeof item !== "object") throw bad("Each input must be a string or object.");
    else if (item.type === "function_call") {
      if (!(item.call_id || item.id) || !item.name || typeof item.arguments !== "string") throw bad("Invalid function_call.");
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments } }] });
    } else if (item.type === "function_call_output") {
      if (!item.call_id || typeof item.output !== "string") throw bad("Invalid function_call_output.");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    } else if (item.type === "message" || (!item.type && item.role)) {
      if (!["developer", "system", "user", "assistant"].includes(item.role) || (typeof item.content !== "string" && !Array.isArray(item.content))) throw bad("Invalid message.");
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: text(item.content) });
    }
  }
  if (!messages.length) throw bad("input must contain chat messages.");
  const out = { model, messages };
  for (const key of ["stream", "temperature", "top_p", "stop", "parallel_tool_calls"]) if (body[key] != null) out[key] = body[key];
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) throw bad("tools must be an array.");
    // Codex sends hosted tools (web_search, apply_patch, …) alongside functions.
    // Skip non-function tools instead of rejecting the whole turn.
    const tools = [];
    for (const tool of body.tools) {
      const fn = tool?.type === "function" || tool?.type == null ? (tool.function ?? tool) : null;
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      tools.push({ type: "function", function: { name: fn.name, ...(fn.description != null ? { description: fn.description } : {}), parameters: fn.parameters ?? { type: "object", properties: {} }, ...(fn.strict != null ? { strict: fn.strict } : {}) } });
    }
    if (tools.length) out.tools = tools;
  }
  if (body.tool_choice != null) out.tool_choice = body.tool_choice?.type === "function" && body.tool_choice.name
    ? { type: "function", function: { name: body.tool_choice.name } } : body.tool_choice;
  return out;
}

export function chatCompletionToResponse(completion) {
  const id = completion.id || "resp_proxy";
  const message = completion.choices?.[0]?.message ?? {};
  const output = [];
  if (message.content || !message.tool_calls?.length) output.push({ id: `${id}_message`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.content ?? "", annotations: [] }] });
  for (const [index, call] of (message.tool_calls ?? []).entries()) output.push({ id: `${id}_call_${index}`, type: "function_call", status: "completed", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? "" });
  const input = completion.usage?.prompt_tokens ?? 0;
  const generated = completion.usage?.completion_tokens ?? 0;
  return { id, object: "response", created_at: completion.created ?? 0, status: "completed", model: completion.model, output, usage: { input_tokens: input, output_tokens: generated, total_tokens: completion.usage?.total_tokens ?? input + generated }, ...(completion.billing ? { billing: completion.billing } : {}) };
}
