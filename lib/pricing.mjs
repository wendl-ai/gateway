// Cost from tokens — the gateway prices every call itself, the same way the eval
// harness does, so spend accounting never depends on an upstream returning a price.
// Source of truth is pricing.json (internal id -> $/M in,out); unknown models fall
// back to the cached OpenRouter catalog (openrouter-models.json). In the monorepo
// these are owned by evals/ (../../evals/...); a standalone publish (see
// scripts/publish-gateway.sh) vendors fresh copies next to this file instead — try
// the local copy first so the same code runs both places.

import fs from 'fs';
import path from 'path';
import url from 'url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.join(HERE, '..');
const EVALS = path.join(HERE, '..', '..', 'evals');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readFirst = (paths) => {
  for (const p of paths) { try { return readJSON(p); } catch { /* try next */ } }
  return null;
};

const pricing = readFirst([
  path.join(GATEWAY_ROOT, 'pricing.json'),
  path.join(EVALS, 'pricing.json'),
]) || {}; // priced $0 / unpriced if neither is present

// Optional OpenRouter catalog cache (raw {data:[...]}) for openrouter/<slug> candidates.
const lastSeg = (s) => String(s).split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
const catBySlug = {}; const catByLast = {};
{
  const raw = readFirst([
    path.join(GATEWAY_ROOT, 'openrouter-models.json'),
    path.join(EVALS, 'out', 'openrouter-models.json'),
  ]);
  for (const m of (raw && (raw.data || raw.models)) || []) {
    const slug = m.id || m.slug; if (!slug) continue;
    const inPerM = Number(m.pricing?.prompt) * 1e6;
    const outPerM = Number(m.pricing?.completion) * 1e6;
    if (Number.isFinite(inPerM) && Number.isFinite(outPerM)) {
      const rec = { in: inPerM, out: outPerM };
      catBySlug[slug] = rec; catByLast[lastSeg(slug)] = rec;
    }
  }
} // no catalog cache found in either location -> empty (run `make refresh-pricing` in the monorepo to populate)

// costModel is the internal id the router chose for pricing (e.g. claude-opus-4-8,
// llama3.1:8b, or openrouter/<slug>).
export function priceOf(costModel) {
  if (!costModel) return null;
  if (pricing[costModel]) return pricing[costModel];
  if (costModel.startsWith('openrouter/')) {
    const slug = costModel.slice('openrouter/'.length);
    return catBySlug[slug] || catByLast[lastSeg(slug)] || null;
  }
  return catByLast[lastSeg(costModel)] || null;
}

export function costOf(costModel, inTok, outTok) {
  const p = priceOf(costModel);
  if (!p) return null;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
