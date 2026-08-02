// Spend + virtual-key storage without a database. This is the whole reason the
// gateway can be "$0, no Postgres, one process": a customer's team-chat volume is
// tiny, so an append-only JSONL spend log + a small JSON keystore is plenty, and
// both are human-inspectable. Swap for node:sqlite behind this interface if scale
// ever demands it — nothing above depends on the storage shape.

import fs from 'fs';
import path from 'path';
import url from 'url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WENDL_GATEWAY_DATA || path.join(HERE, '..', 'data');
const SPEND_LOG = path.join(DATA_DIR, 'spend.jsonl');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const BUDGET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30d, matches config.yaml budget_duration

fs.mkdirSync(DATA_DIR, { recursive: true });

let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { keys = {}; }
const flushKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));

const now = () => Date.now();
const rand = (n) => { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };

// roll the per-key budget window forward if it has elapsed (spend resets to 0)
function rollWindow(rec) {
  if (!rec.budget_reset_at) rec.budget_reset_at = now() + BUDGET_WINDOW_MS;
  if (now() >= rec.budget_reset_at) { rec.spend = 0; rec.budget_reset_at = now() + BUDGET_WINDOW_MS; }
  return rec;
}

export function generateKey({ key_alias, max_budget } = {}) {
  const key = 'sk-wendl-' + rand(32);
  keys[key] = { key_alias: key_alias || null, max_budget: Number(max_budget) || 0, spend: 0, budget_reset_at: now() + BUDGET_WINDOW_MS, created: new Date().toISOString() };
  flushKeys();
  return key;
}

// Idempotent seed used by `make bootstrap-lite` — create a budgeted alias once.
export function ensureKey(key_alias, max_budget) {
  const existing = Object.entries(keys).find(([, r]) => r.key_alias === key_alias);
  if (existing) return existing[0];
  return generateKey({ key_alias, max_budget });
}

// Kill a (possibly leaked) key and mint a fresh one for the same alias, preserving
// its budget, current spend, and window — so rotating isn't a free budget reset and
// the old key stops working immediately. Returns the new key, or null if no such alias.
export function rotateKey(key_alias) {
  const entry = Object.entries(keys).find(([, r]) => r.key_alias === key_alias);
  if (!entry) return null;
  const [oldKey, rec] = entry;
  delete keys[oldKey];
  const key = 'sk-wendl-' + rand(32);
  keys[key] = { ...rec, created: new Date().toISOString() };
  flushKeys();
  return key;
}

export const getKey = (key) => (keys[key] ? rollWindow(keys[key]) : null);
export const isKnownKey = (key) => !!keys[key];

// true when a virtual key has a budget and has reached it
export function overBudget(key) {
  const rec = getKey(key);
  return !!(rec && rec.max_budget > 0 && rec.spend >= rec.max_budget);
}

// record one call: append to the audit log AND advance the key's running spend
export function record(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(SPEND_LOG, JSON.stringify(line) + '\n');
  const rec = entry.key && keys[entry.key] ? rollWindow(keys[entry.key]) : null;
  if (rec && entry.spend) { rec.spend += entry.spend; flushKeys(); }
}

// LiteLLM-shaped /spend/logs — most recent `limit` rows
export function readLogs(limit = 5000) {
  let raw = '';
  try { raw = fs.readFileSync(SPEND_LOG, 'utf8'); } catch { return []; }
  const rows = raw.split('\n').filter(Boolean);
  return rows.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// LiteLLM-shaped /spend/keys — one row per virtual key
export function listKeys() {
  return Object.entries(keys).map(([key, r]) => {
    rollWindow(r);
    return { key: key.slice(0, 12) + '…', key_alias: r.key_alias, spend: r.spend, max_budget: r.max_budget };
  });
}

export { DATA_DIR };
