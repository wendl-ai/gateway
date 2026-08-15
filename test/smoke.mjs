// End-to-end smoke test for the gateway, no real providers/keys needed: a fake
// upstream serves both the OpenAI (/v1/chat/completions) and Anthropic (/v1/messages)
// shapes, streaming and not, and we drive the gateway against it — verifying routing,
// OpenAI<->Anthropic translation, spend logging, budget enforcement, and streaming.
//
//   node gateway/test/smoke.mjs

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const UP = 4998, GW = 4999;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wendl-gw-'));

// env must be set BEFORE importing the gateway (its modules read env at load)
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.WENDL_GATEWAY_PORT = String(GW);
process.env.WENDL_GATEWAY_DATA = DATA;
process.env.WENDL_GATEWAY_RETRIES = '1';
process.env.OLLAMA_BASE = `http://127.0.0.1:${UP}/v1`;
process.env.OPENROUTER_BASE = `http://127.0.0.1:${UP}/v1`;
process.env.ANTHROPIC_BASE = `http://127.0.0.1:${UP}`;
process.env.ANTHROPIC_API_KEY = 'test-anth';
process.env.OPENROUTER_API_KEY = 'test-or';

let passed = 0;
const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1); } passed++; console.log('✓ ' + msg); };

// ---- fake upstream ----------------------------------------------------------
const readJSON = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
const upstream = http.createServer(async (req, res) => {
  const body = await readJSON(req);
  if (req.url.startsWith('/v1/messages')) { // Anthropic shape
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":200,"output_tokens":0}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic reply"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'anthropic reply' }], usage: { input_tokens: 200, output_tokens: 50 } }));
  }
  // OpenAI shape
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"local "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"stream"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n');
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'cmpl_1', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'local reply' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 } }));
});

const gw = (p, opts = {}) => fetch(`http://127.0.0.1:${GW}${p}`, opts);
const AUTH = { Authorization: 'Bearer test-master' };
const chatBody = (model, extra = {}) => ({ method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) });

async function main() {
  await new Promise((r) => upstream.listen(UP, r));
  const { start } = await import('../server.mjs');
  await start(GW);

  // 1. health
  assert((await (await gw('/health')).json()).status === 'ok', 'GET /health -> ok');

  // 2. local route (Ollama, openai passthrough), priced $0
  const r1 = await (await gw('/v1/chat/completions', chatBody('llama3.1:8b'))).json();
  assert(r1.choices?.[0]?.message?.content === 'local reply', 'local model routes to Ollama upstream');

  // 3. tier + Anthropic translation: tier-deep -> claude-opus-4-8 -> /v1/messages
  const r2 = await (await gw('/v1/chat/completions', chatBody('tier-deep'))).json();
  assert(r2.choices?.[0]?.message?.content === 'anthropic reply', 'tier-deep translates OpenAI<->Anthropic');
  assert(r2.usage.prompt_tokens === 200 && r2.usage.completion_tokens === 50, 'Anthropic usage mapped to OpenAI usage');

  // 4. spend log recorded both calls with provider + cost
  const logs = await (await gw('/spend/logs', { headers: AUTH })).json();
  const opus = logs.find((l) => l.model === 'claude-opus-4-8');
  assert(opus && opus.provider === 'anthropic', 'spend log tags provider');
  assert(Math.abs(opus.spend - 0.00225) < 1e-9, `opus call priced from tokens ($${opus?.spend})`); // 200*5/1e6 + 50*25/1e6

  // 5. virtual key + budget enforcement
  const { key } = await (await gw('/key/generate', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ key_alias: 'team', max_budget: 0.001 }) })).json();
  assert(key?.startsWith('sk-wendl-'), 'POST /key/generate mints a virtual key');
  const vAuth = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const first = await gw('/v1/chat/completions', { method: 'POST', headers: vAuth, body: JSON.stringify({ model: 'tier-deep', messages: [{ role: 'user', content: 'hi' }] }) });
  assert(first.status === 200, 'first call under a fresh budget succeeds');       // spend 0 -> allowed, then +0.00225
  const second = await gw('/v1/chat/completions', { method: 'POST', headers: vAuth, body: JSON.stringify({ model: 'tier-deep', messages: [{ role: 'user', content: 'hi' }] }) });
  assert(second.status === 429, 'second call is blocked once budget is exceeded'); // 0.00225 >= 0.001

  // 6. /spend/keys reflects the virtual key
  const keys = await (await gw('/spend/keys', { headers: AUTH })).json();
  const team = keys.find((k) => k.key_alias === 'team');
  assert(team && team.max_budget === 0.001 && team.spend >= 0.00225, '/spend/keys shows team spend vs budget');

  // 7. streaming — openai passthrough tees usage from the terminal chunk
  const s1 = await gw('/v1/chat/completions', chatBody('llama3.1:8b', { stream: true }));
  const t1 = await s1.text();
  assert(t1.includes('local ') && t1.includes('stream') && t1.includes('[DONE]'), 'openai stream passes through');

  // 8. streaming — anthropic synthesized into an OpenAI stream
  const s2 = await gw('/v1/chat/completions', chatBody('tier-deep', { stream: true }));
  const t2 = await s2.text();
  assert(t2.includes('anthropic reply') && t2.includes('[DONE]'), 'anthropic stream synthesized as OpenAI SSE');

  // ---- inbound Anthropic /v1/messages (nanoclaw path) ----
  const msg = (model, extra = {}, headers = AUTH) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }) });

  // 9. cloud tier passes through natively (Anthropic -> Anthropic, lossless)
  const m1 = await (await gw('/v1/messages', msg('tier-deep'))).json();
  assert(m1.type === 'message' && m1.content?.[0]?.text === 'anthropic reply', '/v1/messages cloud tier passes through natively');
  assert(m1.usage.input_tokens === 200 && m1.usage.output_tokens === 50, '/v1/messages preserves Anthropic usage');

  // 10. local tier translated from an OpenAI upstream (system + block content)
  const m2 = await (await gw('/v1/messages', msg('llama3.1:8b', { system: 'be brief', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))).json();
  assert(m2.type === 'message' && m2.content?.[0]?.text === 'local reply', '/v1/messages local tier translated OpenAI->Anthropic');

  // 11. nanoclaw-style x-api-key auth
  assert((await gw('/v1/messages', msg('tier-deep', {}, { 'x-api-key': 'test-master' }))).status === 200, '/v1/messages accepts x-api-key auth');

  // 12. streaming — native Anthropic passthrough (usage teed from message_delta)
  const mst1 = await (await gw('/v1/messages', msg('tier-deep', { stream: true }))).text();
  assert(mst1.includes('message_start') && mst1.includes('anthropic reply') && mst1.includes('message_stop'), '/v1/messages streams (native passthrough)');

  // 13. streaming — synthesized Anthropic SSE from an OpenAI upstream
  const mst2 = await (await gw('/v1/messages', msg('llama3.1:8b', { stream: true }))).text();
  assert(mst2.includes('content_block_delta') && mst2.includes('local reply') && mst2.includes('message_stop'), '/v1/messages synthesizes Anthropic SSE for local tier');

  // 14. rotate: kills the old key, mints a new one, preserves budget + spend
  const before = (await (await gw('/spend/keys', { headers: AUTH })).json()).find((k) => k.key_alias === 'team');
  const rot = await (await gw('/key/rotate', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ key_alias: 'team' }) })).json();
  assert(rot.key?.startsWith('sk-wendl-') && rot.key !== key, 'rotate mints a new key for the alias');
  const oldUse = await gw('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] }) });
  assert(oldUse.status === 401, 'rotated-away old key is rejected');
  const after = (await (await gw('/spend/keys', { headers: AUTH })).json()).find((k) => k.key_alias === 'team');
  assert(after && after.max_budget === before.max_budget && after.spend === before.spend, 'rotate preserves budget + spend');
  assert((await (await gw('/key/rotate', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ key_alias: 'nope' }) })).status) === 404, 'rotate on unknown alias -> 404');

  // 15. auth: no key rejected
  assert((await gw('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401, 'missing key -> 401');

  // ---- attribution + /spend/activity (the spaces recap input) ----
  // Tag calls with a space/agent the way a harness would, then roll them up.
  const tagged = (space, text, agent = 'researcher') => ({
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-wendl-space': space, 'x-wendl-agent': agent, 'x-wendl-actor': 'dan' },
    body: JSON.stringify({ model: 'llama3.1:8b', messages: [{ role: 'user', content: text }] }),
  });
  const t0 = Date.now();
  await gw('/v1/chat/completions', tagged('project-x', 'what is the schema'));
  await gw('/v1/chat/completions', tagged('project-x', 'What is   the schema')); // same question, different whitespace/case
  await gw('/v1/chat/completions', tagged('project-x', 'something else entirely'));
  await gw('/v1/chat/completions', tagged('other-space', 'unrelated'));

  // 16. the log carries attribution, and untagged rows are unchanged
  const logs2 = await (await gw('/spend/logs', { headers: AUTH })).json();
  const px = logs2.filter((l) => l.space === 'project-x');
  assert(px.length === 3, 'tagged calls carry x-wendl-space into the spend log');
  assert(px.every((l) => l.agent === 'researcher' && l.actor === 'dan'), 'agent + actor tags are recorded');
  assert(px.every((l) => l.prompt_sig && !JSON.stringify(l).includes('schema')), 'prompt is stored as a hash — no prompt text lands in the spend log');
  assert(logs2.some((l) => !('space' in l)), 'untagged calls still log with no attribution keys at all');

  // 17. rollup for one space
  const act = await (await gw('/spend/activity?space=project-x', { headers: AUTH })).json();
  assert(act.runs === 3, `/spend/activity scopes to the space (${act.runs} runs)`);
  assert(act.agents.some((a) => a.agent === 'researcher' && a.runs === 3), 'rollup buckets by agent');
  assert(act.tokens.in === 300 && act.tokens.out === 60, 'rollup sums tokens');

  // 18. repeat detection — the most useful line in an agent cost breakdown
  assert(act.repeats.inGroups === 2 && act.repeats.redundant === 1, 'normalized-identical prompts are detected as a repeat');
  assert((await (await gw('/spend/activity?space=other-space', { headers: AUTH })).json()).runs === 1, 'a different space sees only its own calls');

  // 19. time window + auth
  assert((await (await gw(`/spend/activity?space=project-x&since=${t0 - 1}`, { headers: AUTH })).json()).runs === 3, 'since= includes calls after the watermark');
  assert((await (await gw(`/spend/activity?space=project-x&since=${Date.now() + 60000}`, { headers: AUTH })).json()).runs === 0, 'a future watermark yields an empty window');
  assert((await gw('/spend/activity', { headers: { Authorization: `Bearer ${rot.key}` } })).status === 401, '/spend/activity is admin-only');

  // 20. the rollup is self-describing — a consumer needs no other call
  assert(act.space === 'project-x' && act.cost === 0 && act.errors === 0, 'rollup echoes its own scope and totals');
  const all = await (await gw('/spend/activity', { headers: AUTH })).json();
  assert(all.space === null && all.runs > act.runs, 'no space filter rolls up everything');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  upstream.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
