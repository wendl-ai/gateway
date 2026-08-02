// Model -> upstream resolution. Mirrors litellm/config.yaml's model_list so the
// gateway routes the exact same identifiers the evals, plugin, and config use:
//   tier-local-*                 -> Ollama (local, $0)
//   llama*/qwen* (name:tag)      -> Ollama
//   tier-cheap/mid/deep, claude-*-> Anthropic (direct)
//   openrouter/<slug>            -> OpenRouter (backtest lane / passthrough)
// Each route carries `costModel`: the internal id used to price the call.

import fs from 'fs';
import path from 'path';
import url from 'url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const routes = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'routes.json'), 'utf8'));

const OLLAMA_BASE = process.env.OLLAMA_BASE || routes.providers.ollama.base;
const OPENROUTER_BASE = process.env.OPENROUTER_BASE || routes.providers.openrouter.base;
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE || routes.providers.anthropic.base;

const ollama = (m) => ({ provider: 'ollama', format: 'openai', base: OLLAMA_BASE, apiKey: null, upstreamModel: m, costModel: m });
const anthropic = (m) => ({ provider: 'anthropic', format: 'anthropic', base: ANTHROPIC_BASE, apiKey: process.env.ANTHROPIC_API_KEY || null, upstreamModel: m, costModel: m });
const openrouter = (m) => ({ provider: 'openrouter', format: 'openai', base: OPENROUTER_BASE, apiKey: process.env.OPENROUTER_API_KEY || null, upstreamModel: m, costModel: 'openrouter/' + m });

// tier names are exposed for a minimal /v1/models listing
export const knownModels = [...Object.keys(routes.tiers), ...new Set(Object.values(routes.tiers))];

export function resolveRoute(model) {
  if (!model) return { error: 'no model specified' };
  let m = routes.tiers[model] || model;              // expand tier -> concrete id

  // explicit provider prefixes always win
  if (m.startsWith('openrouter/')) return openrouter(m.slice('openrouter/'.length));
  if (m.startsWith('anthropic/')) return anthropic(m.slice('anthropic/'.length));
  if (m.startsWith('ollama/') || m.startsWith('local/')) return ollama(m.slice(m.indexOf('/') + 1));

  // heuristics that cover every id in configs.json / pricing.json
  if (m.startsWith('claude-')) return anthropic(m);   // direct Anthropic, like config.yaml
  if (m.includes(':')) return ollama(m);              // ollama name:tag (llama3.1:8b)
  if (m.includes('/')) return openrouter(m);          // looks like an OpenRouter slug

  // bare open-weight family name with no tag -> local
  if (/^(llama|qwen|gemma|phi|mistral|deepseek-r|nomic)/i.test(m)) return ollama(m);

  // last resort: pass through to OpenRouter if we can, else surface a clear error
  if (process.env.OPENROUTER_API_KEY) return openrouter(m);
  return { error: `unknown model '${model}' — no matching provider (set OPENROUTER_API_KEY to pass unknown ids through)` };
}
