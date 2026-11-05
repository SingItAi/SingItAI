// Build the entire wire body before x402 releases a response. Never write partial answers.
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
export function agentResponses(stats) {
  return (req, res, next) => {
    const json = res.json;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (this.statusCode < 400 && String(this.getHeader("Content-Type")).startsWith("text/event-stream")) this.setHeader("Cache-Control", "no-cache");
      return writeHead.apply(this, args);
    };
    let answered = false;
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
