// Upstream adapters. Two shapes:
//   • openai  — Ollama and OpenRouter speak /v1/chat/completions natively; forward.
//   • anthropic — Anthropic's /v1/messages differs, so translate OpenAI<->Anthropic
//                 both ways (this is the bit LiteLLM did for us that we now own).
// Non-streaming is exact (real usage -> exact cost); streaming captures usage from
// the terminal chunk and falls back to a char/4 estimate so spend is never lost.

const estTokens = (s) => Math.ceil((s || '').length / 4);
const contentToText = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p.text ?? p.content ?? '')).join('');
  return c == null ? '' : String(c);
};

function oaHeaders(route) {
  const h = { 'content-type': 'application/json' };
  if (route.apiKey) h.Authorization = `Bearer ${route.apiKey}`;
  if (route.provider === 'openrouter') { h['HTTP-Referer'] = 'https://wendl.ai'; h['X-Title'] = 'Wendl'; }
  return h;
}

// ---- OpenAI-compatible (Ollama, OpenRouter) --------------------------------
async function openaiChat(route, body, signal) {
  const r = await fetch(`${route.base}/chat/completions`, {
    method: 'POST', headers: oaHeaders(route), signal,
    body: JSON.stringify({ ...body, model: route.upstreamModel, stream: false }),
  });
  const json = await r.json();
  const u = json.usage || {};
  const usage = { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0 };
  if (!usage.completion_tokens) usage.completion_tokens = estTokens(json.choices?.[0]?.message?.content);
  return { status: r.status, json, usage };
}

async function openaiStream(route, body, res, signal) {
  const upstream = await fetch(`${route.base}/chat/completions`, {
    method: 'POST', headers: oaHeaders(route), signal,
    body: JSON.stringify({ ...body, model: route.upstreamModel, stream: true, stream_options: { include_usage: true } }),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text || JSON.stringify({ error: { message: `upstream ${upstream.status}` } }));
    return { streamed: true, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const dec = new TextDecoder();
  let buf = '', outText = '', usage = null;
  for await (const chunk of upstream.body) {
    res.write(chunk);
    buf += dec.decode(chunk, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const m = line.match(/^data:\s*(.+)$/); if (!m || m[1] === '[DONE]') continue;
      try { const j = JSON.parse(m[1]); if (j.usage) usage = j.usage; outText += j.choices?.[0]?.delta?.content || ''; } catch { /* partial */ }
    }
  }
  res.end();
  return { streamed: true, usage: usage
    ? { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 }
    : { prompt_tokens: estTokens(contentToText(body.messages?.map((x) => x.content).join('\n'))), completion_tokens: estTokens(outText) } };
}

// ---- Anthropic /v1/messages -------------------------------------------------
function toAnthropic(body, upstreamModel) {
  const system = body.messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n');
  const messages = body.messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentToText(m.content) }));
  return {
    model: upstreamModel, messages, max_tokens: body.max_tokens ?? 1024,
    ...(system ? { system } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
  };
}
const mapStop = (r) => (r === 'max_tokens' ? 'length' : r === 'tool_use' ? 'tool_calls' : 'stop');
const anthHeaders = (route) => ({ 'content-type': 'application/json', 'x-api-key': route.apiKey || '', 'anthropic-version': '2023-06-01' });

async function anthropicChat(route, body, signal) {
  const r = await fetch(`${route.base}/v1/messages`, {
    method: 'POST', headers: anthHeaders(route), signal, body: JSON.stringify(toAnthropic(body, route.upstreamModel)),
  });
  const a = await r.json();
  if (!r.ok) return { status: r.status, json: { error: a.error || a }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  const text = (a.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usage = { prompt_tokens: a.usage?.input_tokens || 0, completion_tokens: a.usage?.output_tokens || 0 };
  const json = {
    id: a.id || 'chatcmpl', object: 'chat.completion', model: route.upstreamModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mapStop(a.stop_reason) }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
  return { status: r.status, json, usage };
}

// Anthropic has its own SSE dialect; rather than translate it, get the full answer
// and re-emit it as one OpenAI-style stream. Fine for team-chat latencies.
async function anthropicStream(route, body, res, signal) {
  const { status, json, usage } = await anthropicChat(route, body, signal);
  if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); return { streamed: true, usage }; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const id = json.id, model = route.upstreamModel;
  const frame = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`;
  res.write(frame({ role: 'assistant' }, null));
  res.write(frame({ content: json.choices[0].message.content }, null));
  res.write(frame({}, json.choices[0].finish_reason));
  res.write('data: [DONE]\n\n');
  res.end();
  return { streamed: true, usage };
}

export function chat(route, body, signal) {
  return route.format === 'anthropic' ? anthropicChat(route, body, signal) : openaiChat(route, body, signal);
}
export function chatStream(route, body, res, signal) {
  return route.format === 'anthropic' ? anthropicStream(route, body, res, signal) : openaiStream(route, body, res, signal);
}

// ---- inbound Anthropic /v1/messages (nanoclaw / Claude Agent SDK) -----------
// nanoclaw points ANTHROPIC_BASE_URL at us and speaks Anthropic Messages. When the
// tier resolves to a Claude model we pass through natively (lossless); when it
// resolves to a local/OpenRouter model we translate Anthropic<->OpenAI.
const anthSystemToText = (s) => (!s ? '' : typeof s === 'string' ? s : Array.isArray(s) ? s.map((b) => b.text || '').join('\n') : String(s));
const anthContentToText = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => {
    if (typeof b === 'string') return b;
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('') : '';
    return '';
  }).join('');
};
function anthropicToOpenAI(a) {
  const messages = [];
  const sys = anthSystemToText(a.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of a.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: anthContentToText(m.content) });
  return { messages, max_tokens: a.max_tokens, ...(a.temperature != null ? { temperature: a.temperature } : {}), ...(a.top_p != null ? { top_p: a.top_p } : {}) };
}
const mapFinishToStop = (f) => (f === 'length' ? 'max_tokens' : f === 'tool_calls' ? 'tool_use' : 'end_turn');
function openaiToAnthropicMessage(oai, model) {
  const text = oai.choices?.[0]?.message?.content || '';
  const u = oai.usage || {};
  return {
    id: oai.id || 'msg_gw', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
    stop_reason: mapFinishToStop(oai.choices?.[0]?.finish_reason), stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || estTokens(text) },
  };
}

async function anthropicMessagesPassthrough(route, body, signal) {
  const r = await fetch(`${route.base}/v1/messages`, {
    method: 'POST', headers: anthHeaders(route), signal, body: JSON.stringify({ ...body, model: route.upstreamModel, stream: false }),
  });
  const json = await r.json();
  return { status: r.status, json, usage: { prompt_tokens: json.usage?.input_tokens || 0, completion_tokens: json.usage?.output_tokens || 0 } };
}
async function openaiAsMessages(route, body, signal) {
  const { status, json, usage } = await openaiChat(route, anthropicToOpenAI(body), signal);
  if (status !== 200) return { status, json, usage };
  return { status, json: openaiToAnthropicMessage(json, route.upstreamModel), usage };
}

async function anthropicMessagesStreamPassthrough(route, body, res, signal) {
  const upstream = await fetch(`${route.base}/v1/messages`, {
    method: 'POST', headers: anthHeaders(route), signal, body: JSON.stringify({ ...body, model: route.upstreamModel, stream: true }),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(text || '{}');
    return { streamed: true, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const dec = new TextDecoder(); let buf = '', inTok = 0, outTok = 0;
  for await (const chunk of upstream.body) {
    res.write(chunk);
    buf += dec.decode(chunk, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const m = line.match(/^data:\s*(.+)$/); if (!m) continue;
      try { const j = JSON.parse(m[1]); if (j.type === 'message_start') inTok = j.message?.usage?.input_tokens || 0; if (j.type === 'message_delta') outTok = j.usage?.output_tokens ?? outTok; } catch { /* partial */ }
    }
  }
  res.end();
  return { streamed: true, usage: { prompt_tokens: inTok, completion_tokens: outTok } };
}
async function openaiAsMessagesStream(route, body, res, signal) {
  const { status, json, usage } = await openaiAsMessages(route, body, signal);
  if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); return { streamed: true, usage }; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const text = json.content?.[0]?.text || '';
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: json.id, type: 'message', role: 'assistant', model: route.upstreamModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.prompt_tokens, output_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: json.stop_reason || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.completion_tokens } });
  ev('message_stop', {});
  res.end();
  return { streamed: true, usage };
}

export function messages(route, body, signal) {
  return route.format === 'anthropic' ? anthropicMessagesPassthrough(route, body, signal) : openaiAsMessages(route, body, signal);
}
export function messagesStream(route, body, res, signal) {
  return route.format === 'anthropic' ? anthropicMessagesStreamPassthrough(route, body, res, signal) : openaiAsMessagesStream(route, body, res, signal);
}
