# Wendl gateway

A routing + spend + budget data-plane — a **drop-in replacement for the LiteLLM proxy**
for the paths most teams actually use. Same port (`4000`), same `LITELLM_MASTER_KEY`,
same endpoints. No Postgres, no LiteLLM, one `node` process, zero npm dependencies.

Part of [Wendl](https://wendl.ai) — this repo is the self-contained gateway piece,
published separately so you can self-host it without anything else. The full
project (evals, cost×quality backtesting, connectors) lives in the private
[`wendl-ai/wendl`](https://github.com/wendl-ai/wendl) monorepo, of which this repo is a mirror of `gateway/`.

## Why this exists

The gateway prices every call itself from returned token usage — it never depended on
LiteLLM for that. LiteLLM was only ever the live data-plane that (a) routes requests and
(b) records spend/budgets, and it dragged a Postgres container along for that. This
gateway does the same job in ~500 lines so "self-host in a couple of minutes" is
actually true.

```
cp .env.example .env    # fill in LITELLM_MASTER_KEY (+ ANTHROPIC_API_KEY / OPENROUTER_API_KEY)
npm run bootstrap       # seed team + ops virtual keys (no Postgres)
npm start                # run it on :4000
npm test                 # end-to-end smoke test (fake upstream, no real keys)
```

## Endpoints (the LiteLLM surface this covers)

| Method + path              | Purpose                                    |
|----------------------------|---------------------------------------------|
| `POST /v1/chat/completions`| OpenAI-compatible; routes + logs spend      |
| `GET /spend/logs`          | per-call token + cost log                   |
| `GET /spend/keys`          | per-virtual-key spend vs budget             |
| `POST /key/generate`       | mint a budgeted virtual key                 |
| `POST /key/rotate`         | kill a key + mint a new one (same budget)   |
| `GET /v1/models`           | minimal model listing                       |
| `GET /health`              | liveness                                     |

Auth: the **master key** (`LITELLM_MASTER_KEY`) administers everything; a **virtual key**
authorizes chat and is billed against its budget. Admin endpoints require the master key.

## Routing

`routes.json` configures the tiers:

- `tier-local-*`, bare `llama*/qwen*` or any `name:tag` → **Ollama** (local, `$0`)
- `tier-cheap/mid/deep`, `claude-*` → **Anthropic** direct (`/v1/messages`, translated to/from OpenAI)
- `openrouter/<slug>` (or any `owner/slug`) → **OpenRouter** (passthrough)

Cost is computed per call from returned token usage via `pricing.json` (+ the cached
OpenRouter catalog in `openrouter-models.json`, if present), so spend accounting never
trusts an upstream to report a price.

## Storage

No database. `data/` (gitignored) holds an append-only `spend.jsonl` audit log and a
small `keys.json` keystore; per-key spend rolls on a 30-day window. Fine for team-chat
volume; swap for `node:sqlite` behind `lib/store.mjs` if scale ever demands it.

## No Docker

Plain `node` — no Docker, no Postgres, no LiteLLM container. Cloud tiers need only
`ANTHROPIC_API_KEY` (and/or `OPENROUTER_API_KEY`). Local models still need Ollama:
install it natively (`ollama serve` on `:11434`, `ollama pull llama3.1:8b`) or route
cloud-only (skip the `tier-local-*` tiers).

## Networking & exposure

Binds `127.0.0.1` (loopback) by default — a same-box agent reaches it, nothing is
exposed off-box. For a **multi-box** setup (agents on one box, gateway + Ollama on a GPU
box), put the boxes on a private mesh (**Tailscale**) and set `WENDL_GATEWAY_HOST` to the
gateway's Tailscale IP (`100.x.y.z`) — reachable on the tailnet only, tighter than
`0.0.0.0`. **Never bind a public IP:** the only gate is the key.

Keys are bearer credentials. Virtual keys are **budget-capped** (limited blast radius)
and live in `data/keys.json` (gitignored); the **master key is not capped** — protect it.
`npm run bootstrap` prints the virtual keys once (treat like passwords; don't paste into
shared logs/recordings). Rotate a leaked key with `node rotate.mjs team` — it kills the
old key and mints a new one keeping the same budget + spend (so rotating isn't a free
budget reset).

## Scope

- **Inbound shapes**: OpenAI `/v1/chat/completions` **and** Anthropic `/v1/messages`
  (nanoclaw / Claude Agent SDK via `ANTHROPIC_BASE_URL`). On `/v1/messages`, cloud tiers
  (`claude-*`) pass through to Anthropic **natively/lossless**; local + OpenRouter tiers
  are translated Anthropic↔OpenAI. Tool-use blocks ride through on the native cloud path;
  on the translated (local) path only text is carried today.
- **No fallback chains** yet; per-call retries only (`WENDL_GATEWAY_RETRIES`, default 2).
- Providers: Ollama + OpenRouter + Anthropic; everything else routes through OpenRouter.

## License

MIT — see [LICENSE](LICENSE).
