#!/usr/bin/env node
// `make rotate-key ALIAS=team` — kill a (leaked) virtual key and mint a fresh one
// for the same alias, keeping its budget + spend. Goes through the RUNNING gateway
// over HTTP on purpose: the server holds the keystore in memory and flushes it, so
// a separate process editing keys.json would be ignored (or clobbered).

const alias = process.argv[2] || process.env.ALIAS;
const port = process.env.WENDL_GATEWAY_PORT || 4000;
const host = process.env.WENDL_GATEWAY_HOST || '127.0.0.1';
const master = process.env.LITELLM_MASTER_KEY;

if (!alias) { console.error('usage: make rotate-key ALIAS=team'); process.exit(1); }
if (!master) { console.error('LITELLM_MASTER_KEY required (admin action).'); process.exit(1); }

try {
  const res = await fetch(`http://${host}:${port}/key/rotate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${master}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key_alias: alias }),
  });
  if (!res.ok) { console.error(`rotate failed: ${res.status} ${await res.text()}`); process.exit(1); }
  const { key } = await res.json();
  console.log(`Rotated '${alias}'. The old key is now dead. New key:\n  ${key}\n`);
  console.log(`Update whatever uses it (e.g. ANTHROPIC_AUTH_TOKEN for that agent) and restart it.`);
} catch (e) {
  console.error(`Could not reach the gateway at http://${host}:${port} (${e.message}). Start it first: make gateway`);
  process.exit(1);
}
