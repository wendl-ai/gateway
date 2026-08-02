#!/usr/bin/env node
// `make bootstrap-lite` — stand up the no-Postgres gateway by seeding the same
// team + ops budgeted virtual keys the LiteLLM setup mints (scripts/setup-keys.sh),
// idempotently, then print a copy-paste block to point nanoclaw at it. Budgets come
// from TEAM_MONTHLY_BUDGET / OPS_MONTHLY_BUDGET (env).

import fs from 'fs';
import path from 'path';
import url from 'url';
import { ensureKey, DATA_DIR } from './lib/store.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// Same code runs inside the wendl.ai monorepo (repo-root Makefile one level up)
// and in the standalone wendl-ai/gateway release (no Makefile) — point at
// whichever commands actually work in this checkout.
const STANDALONE = !fs.existsSync(path.join(HERE, '..', 'Makefile'));
const runGateway = STANDALONE ? 'npm start' : 'make gateway';
const rotateKey = (alias) => STANDALONE ? `node rotate.mjs ${alias}` : `make rotate-key ALIAS=${alias}`;
const keysPath = STANDALONE ? 'data/keys.json' : 'gateway/data/keys.json';

const teamBudget = Number(process.env.TEAM_MONTHLY_BUDGET || 50);
const opsBudget = Number(process.env.OPS_MONTHLY_BUDGET || 5);
const port = process.env.WENDL_GATEWAY_PORT || 4000;
const base = `http://localhost:${port}`;

const team = ensureKey('team', teamBudget);
const ops = ensureKey('ops', opsBudget);

const p = (s) => console.log(s);
p('Wendl gateway ready — no Postgres, no LiteLLM. Seeded virtual keys:');
p(`  team ($${teamBudget}/30d):  ${team}`);
p(`  ops  ($${opsBudget}/30d):  ${ops}`);
p(`  store: ${DATA_DIR}`);
p('  ⚠ treat these like passwords — budget-capped, but anyone who can reach the gateway can spend to the cap.');
p(`    They also live in ${keysPath} (gitignored). Leaked one? \`${rotateKey('team')}\` kills it.`);

if (!process.env.LITELLM_MASTER_KEY) {
  p(`\n⚠  Set LITELLM_MASTER_KEY in .env before \`${runGateway}\` (any long random string).`);
}
p('\nStart the gateway (no Docker):');
p(`  ${runGateway}                         # serves :${port}`);

p('\nPoint nanoclaw at it — drop-in, Anthropic Messages format. Team agent:');
p(`  ANTHROPIC_BASE_URL=${base}`);
p(`  ANTHROPIC_AUTH_TOKEN=${team}`);
p('  ANTHROPIC_MODEL=tier-mid');
p('\n  # ops / cron agent (cheaper + local-first):');
p(`  ANTHROPIC_AUTH_TOKEN=${ops}`);
p('  ANTHROPIC_MODEL=tier-local-small');

p('\nProviders: cloud tiers need ANTHROPIC_API_KEY (and/or OPENROUTER_API_KEY) in .env.');
p('Local tiers (tier-local-*) need native Ollama on :11434 — or just use the cloud tiers.');
