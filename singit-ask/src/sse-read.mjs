// Server-sent events off a fetch body, one frame at a time: { event, data } with the data lines joined, comments skipped.
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = frame => {
    let event, data = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length || event ? { event, data: data.join("\n") } : null;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    for (let end; (end = buffer.indexOf("\n\n")) >= 0;) {
      const frame = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (frame) yield frame;
    }
  }
  buffer += decoder.decode().replace(/\r\n?/g, "\n");
  const tail = buffer.trim() ? parse(buffer) : null;
  if (tail) yield tail;
}
export const isEventStream = response => /^text\/event-stream/i.test(response?.headers?.get?.("content-type") ?? "");
export const frameOf = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
