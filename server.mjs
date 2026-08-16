#!/usr/bin/env node
// Wendl gateway — our own routing + spend + budget data-plane, a drop-in for the
// LiteLLM proxy. Same port (4000), same master key (LITELLM_MASTER_KEY), same
// endpoints the plugin and evals already call, so swapping it in needs zero client
// changes — but with no Postgres and a single `node` process.
//
// Endpoints (LiteLLM-compatible surface we actually use):
//   POST /v1/chat/completions   OpenAI-compatible; routes local/cloud, logs spend
//   POST /v1/messages           Anthropic-compatible (nanoclaw / Claude Agent SDK)
//   GET  /spend/logs            per-call token+cost log      (plugin /stats)
//   GET  /spend/keys            per-virtual-key spend/budget (plugin /limits)
//   GET  /spend/activity        per-space rollup for a window (spaces recap)
//   GET  /spend/brake           what the repeat brake is blocking right now
//   POST /key/generate          mint a budgeted virtual key  (OpenClaw)
//   GET  /v1/models             minimal model listing
//   GET  /health                liveness
//
//   node gateway/server.mjs        # or: make gateway   (after: make bootstrap-lite)

import http from 'http';
import crypto from 'crypto';
import { resolveRoute, knownModels } from './lib/router.mjs';
import { chat, chatStream, messages, messagesStream } from './lib/providers.mjs';
import { costOf } from './lib/pricing.mjs';
import * as store from './lib/store.mjs';
import * as brake from './lib/brake.mjs';

const PORT = Number(process.env.WENDL_GATEWAY_PORT || 4000);
// Loopback by default — same-box agents reach it, nothing is exposed off-box.
// For a multi-box setup, set WENDL_GATEWAY_HOST to your Tailscale IP (100.x.y.z)
// so it's reachable on the tailnet only (tighter than 0.0.0.0).
const HOST = process.env.WENDL_GATEWAY_HOST || '127.0.0.1';
const MASTER_KEY = process.env.LITELLM_MASTER_KEY || '';
const RETRIES = Number(process.env.WENDL_GATEWAY_RETRIES ?? 2);

const send = (res, status, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
};
const err = (res, status, message, type = 'invalid_request_error') => send(res, status, { error: { message, type } });
// Anthropic SDK/nanoclaw send the key as x-api-key or Authorization: Bearer (via
// ANTHROPIC_AUTH_TOKEN); OpenAI clients use Bearer. Accept either.
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || (req.headers['x-api-key'] || '').trim();
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 25e6) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// --- attribution -------------------------------------------------------------
// Spend answers "who paid" (the virtual key). A caller that wants to report on a
// container of work — a channel, a project, a space — needs "for what", so a client
// can tag each call with where it came from. Headers, not body fields: out-of-band
// means the upstream payload is untouched and the same tags work for both the OpenAI
// and Anthropic shapes. Every field is optional — an untagged call logs exactly as
// it did before, with no attribution keys at all.
const TAG = /[\x00-\x1f\x7f]/g;
const tag = (req, name) => String(req.headers[name] || '').replace(TAG, '').trim().slice(0, 64) || null;
const attribution = (req) => ({
  space: tag(req, 'x-wendl-space'),   // the container this belongs to (#project-x)
  thread: tag(req, 'x-wendl-thread'), // finer grain within it, if the client has one
  actor: tag(req, 'x-wendl-actor'),   // the human who triggered it
  agent: tag(req, 'x-wendl-agent'),   // which agent ran
});

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ');
  return '';
};

// A hash of the last user message, so a report can say "9 of 14 runs were the same
// question" — the single most useful line in an agent cost breakdown. Deliberately
// a HASH: the spend log stays free of prompt content, which is a property worth
// keeping (it's the difference between a meter and a transcript store).
function promptSig(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...msgs].reverse().find((m) => m?.role === 'user');
  const text = textOf(last?.content).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// master key authorizes everything; a virtual key authorizes only chat (and is billed)
function auth(req, { adminOnly } = {}) {
  const tok = bearer(req);
  if (MASTER_KEY && tok === MASTER_KEY) return { ok: true, master: true, key: null };
  if (!adminOnly && store.isKnownKey(tok)) return { ok: true, master: false, key: tok };
  return { ok: false };
}

// Shared driver for both inbound shapes — OpenAI /v1/chat/completions ('chat') and
// Anthropic /v1/messages ('messages'). Same auth, budget, retry, and spend logging;
// only the request/response translation differs (in the provider layer).
async function handleInference(req, res, kind) {
  const a = auth(req);
  if (!a.ok) return err(res, 401, 'missing or invalid API key', 'authentication_error');

  let body; try { body = await readBody(req); } catch { return err(res, 400, 'invalid JSON body'); }
  const route = resolveRoute(body.model);
  if (route.error) return err(res, 400, route.error);
  if ((route.provider === 'anthropic' || route.provider === 'openrouter') && !route.apiKey) {
    return err(res, 502, `no API key configured for ${route.provider} (set ${route.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'})`, 'api_error');
  }
  if (a.key && store.overBudget(a.key)) {
    const rec = store.getKey(a.key);
    return err(res, 429, `budget exceeded for key '${rec.key_alias || a.key.slice(0, 12)}' ($${rec.spend.toFixed(4)} / $${rec.max_budget})`, 'budget_exceeded');
  }

  const meta = { ...attribution(req), prompt_sig: promptSig(body) };

  // The second brake (see lib/brake.mjs). The budget cap above stops spending;
  // this stops looping, which the cap only catches later and more bluntly.
  //
  // Scope is the SPACE when the caller tags one — that's the swarm case, many
  // agents converging on one question — and otherwise the virtual key, which is
  // the single-agent loop. Untagged master-key traffic is deliberately exempt:
  // that's evals and setup, where running one prompt N times across N models is
  // the entire point and a repeat cap would break the backtest.
  const gate = brake.check(meta.space || a.key, meta.prompt_sig);
  if (!gate.ok) {
    // One log row per trip, not one per refusal — a client that ignores the 429
    // and keeps hammering must not convert a token runaway into a disk runaway.
    if (gate.firstTrip) finalizeSpend(route, null, a.key, 429, 0, meta, 'declined');
    return err(res, 429, brake.declineMessage(gate), 'repeat_limit');
  }

  const one = kind === 'messages' ? messages : chat;
  const streamer = kind === 'messages' ? messagesStream : chatStream;
  // Forward the client's own anthropic-beta opt-in on the native passthrough
  // path — otherwise a beta-gated body field (e.g. the Agent SDK's
  // context_management) reaches Anthropic with no opt-in and gets rejected.
  const beta = req.headers['anthropic-beta'];
  const t0 = Date.now();
  let attempt = 0, lastErr;
  while (attempt <= RETRIES) {
    try {
      if (body.stream === true) {
        const { usage } = await streamer(route, body, res, undefined, beta);
        finalizeSpend(route, usage, a.key, 200, Date.now() - t0, meta);
        return; // response already written/ended by the streamer
      }
      const { status, json, usage } = await one(route, body, undefined, beta);
      finalizeSpend(route, usage, a.key, status, Date.now() - t0, meta);
      return send(res, status, json);
    } catch (e) {
      lastErr = e; attempt++;
      if (attempt > RETRIES) break;
    }
  }
  finalizeSpend(route, { prompt_tokens: 0, completion_tokens: 0 }, a.key, 502, Date.now() - t0, meta, 'error');
  return err(res, 502, `upstream call failed after ${RETRIES + 1} attempts: ${lastErr?.message || lastErr}`, 'api_error');
}

function finalizeSpend(route, usage, key, status, latencyMs, meta = {}, statusLabel) {
  const inTok = usage?.prompt_tokens || 0, outTok = usage?.completion_tokens || 0;
  const spend = costOf(route.costModel, inTok, outTok);
  // Drop empty attribution rather than writing nulls — keeps untagged rows byte-identical
  // to what the log held before, so old data and new data read the same.
  const tags = Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
  store.record({
    key, key_alias: key ? (store.getKey(key)?.key_alias || null) : 'master',
    model: route.costModel, provider: route.provider,
    prompt_tokens: inTok, completion_tokens: outTok,
    spend: spend || 0, priced: spend != null,
    status: statusLabel || (status >= 400 ? 'error' : 'ok'), latency_ms: Math.round(latencyMs),
    ...tags,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const { pathname } = u;
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok', service: 'wendl-gateway' });

    if (req.method === 'POST' && pathname === '/v1/chat/completions') return handleInference(req, res, 'chat');
    if (req.method === 'POST' && pathname === '/v1/messages') return handleInference(req, res, 'messages');

    if (req.method === 'GET' && pathname === '/v1/models') {
      if (!auth(req).ok) return err(res, 401, 'missing or invalid API key', 'authentication_error');
      return send(res, 200, { object: 'list', data: [...new Set(knownModels)].map((id) => ({ id, object: 'model', owned_by: 'wendl' })) });
    }
    if (req.method === 'GET' && pathname === '/spend/logs') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      return send(res, 200, store.readLogs());
    }
    if (req.method === 'GET' && pathname === '/spend/keys') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      return send(res, 200, store.listKeys());
    }
    // What a space/channel spent in a window, and how much of it was the same
    // question twice. Admin-only, matching its /spend/* siblings.
    if (req.method === 'GET' && pathname === '/spend/activity') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      const q = u.searchParams;
      const num = (name) => (q.get(name) ? Number(q.get(name)) : undefined);
      return send(res, 200, store.readActivity({
        space: q.get('space') || undefined,
        thread: q.get('thread') || undefined,
        since: num('since') || 0,
        until: num('until'),
      }));
    }
    // What the repeat brake is holding down right now. The spend log records one
    // row per trip, so it can't answer "is something looping at this moment" —
    // this can, and that's the question you have during an incident.
    if (req.method === 'GET' && pathname === '/spend/brake') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      return send(res, 200, brake.live());
    }
    if (req.method === 'POST' && pathname === '/key/generate') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      const b = await readBody(req).catch(() => ({}));
      return send(res, 200, { key: store.generateKey({ key_alias: b.key_alias, max_budget: b.max_budget }) });
    }
    if (req.method === 'POST' && pathname === '/key/rotate') {
      if (!auth(req, { adminOnly: true }).ok) return err(res, 401, 'admin key required', 'authentication_error');
      const b = await readBody(req).catch(() => ({}));
      const key = store.rotateKey(b.key_alias); // kills the old key, keeps alias+budget+spend
      if (!key) return err(res, 404, `no virtual key with alias '${b.key_alias}'`);
      return send(res, 200, { key, key_alias: b.key_alias });
    }
    return err(res, 404, `no route for ${req.method} ${pathname}`);
  } catch (e) {
    return err(res, 500, e?.message || 'internal error', 'api_error');
  }
});

// exported for the smoke test; only auto-listens when run directly
export function start(port = PORT, host = HOST) { return new Promise((resolve) => server.listen(port, host, () => resolve(server))); }
export { server };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!MASTER_KEY) { console.error('LITELLM_MASTER_KEY is required (the gateway reuses the same env as the LiteLLM setup).'); process.exit(1); }
  const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  start().then(() => {
    console.log(`Wendl gateway on ${HOST}:${PORT}  (data: ${store.DATA_DIR})`);
    console.log('  drop-in for LiteLLM — plugin & evals need no config change (same port + LITELLM_MASTER_KEY)');
    if (loopback) console.log('  bound to loopback only. For another box, set WENDL_GATEWAY_HOST to your Tailscale IP (100.x.y.z).');
    else console.log(`  ⚠ bound to ${HOST} — reachable off-box. Keep this interface private (Tailscale/LAN), never a public IP.`);
  });
}
