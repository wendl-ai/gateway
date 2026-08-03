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
//   POST /key/generate          mint a budgeted virtual key  (OpenClaw)
//   GET  /v1/models             minimal model listing
//   GET  /health                liveness
//
//   node gateway/server.mjs        # or: make gateway   (after: make bootstrap-lite)

import http from 'http';
import { resolveRoute, knownModels } from './lib/router.mjs';
import { chat, chatStream, messages, messagesStream } from './lib/providers.mjs';
import { costOf } from './lib/pricing.mjs';
import * as store from './lib/store.mjs';

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
        finalizeSpend(route, usage, a.key, 200, Date.now() - t0);
        return; // response already written/ended by the streamer
      }
      const { status, json, usage } = await one(route, body, undefined, beta);
      finalizeSpend(route, usage, a.key, status, Date.now() - t0);
      return send(res, status, json);
    } catch (e) {
      lastErr = e; attempt++;
      if (attempt > RETRIES) break;
    }
  }
  finalizeSpend(route, { prompt_tokens: 0, completion_tokens: 0 }, a.key, 502, Date.now() - t0, 'error');
  return err(res, 502, `upstream call failed after ${RETRIES + 1} attempts: ${lastErr?.message || lastErr}`, 'api_error');
}

function finalizeSpend(route, usage, key, status, latencyMs, statusLabel) {
  const inTok = usage?.prompt_tokens || 0, outTok = usage?.completion_tokens || 0;
  const spend = costOf(route.costModel, inTok, outTok);
  store.record({
    key, key_alias: key ? (store.getKey(key)?.key_alias || null) : 'master',
    model: route.costModel, provider: route.provider,
    prompt_tokens: inTok, completion_tokens: outTok,
    spend: spend || 0, priced: spend != null,
    status: statusLabel || (status >= 400 ? 'error' : 'ok'), latency_ms: Math.round(latencyMs),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
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
