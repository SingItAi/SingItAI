// Ask is always asked for a JSON answer (the SDK reads the invoice from it), so a client that sent
// stream:true gets the finished answer replayed as Anthropic Messages SSE. Same event sequence as
// singit-ask's buffered SSE for /v1/messages.
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function blockEvents(index, block) {
  let start, delta;
  if (block.type === "tool_use") {
    start = { ...block, input: {} };
    delta = [{ type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) }];
  } else if (block.type === "thinking") {
    start = { ...block, thinking: "", ...(block.signature !== undefined ? { signature: "" } : {}) };
    delta = [{ type: "thinking_delta", thinking: block.thinking ?? "" },
      ...(block.signature !== undefined ? [{ type: "signature_delta", signature: block.signature }] : [])];
  } else if (block.type === "text") {
    start = { ...block, text: "" };
    delta = [{ type: "text_delta", text: block.text ?? "" }];
  } else {
    // A block with no delta form (for example redacted_thinking) is sent whole.
    start = block;
    delta = [];
  }
  return event("content_block_start", { type: "content_block_start", index, content_block: start })
    + delta.map(d => event("content_block_delta", { type: "content_block_delta", index, delta: d })).join("")
    + event("content_block_stop", { type: "content_block_stop", index });
}

/** A complete `type: "message"` answer as an Anthropic Messages event stream. */
export function messageToSSE(answer) {
  const content = Array.isArray(answer.content) ? answer.content : [];
  return event("message_start", { type: "message_start", message: { ...answer, content: [], stop_reason: null, stop_sequence: null, billing: undefined } })
    + content.map((block, index) => blockEvents(index, block)).join("")
    + event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: answer.stop_reason ?? "end_turn", stop_sequence: answer.stop_sequence ?? null },
      usage: answer.usage, billing: answer.billing,
    })
    + event("message_stop", { type: "message_stop" });
}
