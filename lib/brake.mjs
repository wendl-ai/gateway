// The repeat brake — a live circuit breaker on redundant work.
//
// A budget cap is a brake on MONEY. It notices after the money is gone, and when
// it trips it stops the whole space. This is a brake on STRUCTURE: it notices the
// same question being asked over and over inside one space, and stops only the
// loop. The two are complementary and both are cheap, so the gateway runs both.
//
// The failure mode it exists for is documented, not hypothetical. Anthropic's
// Frontier Red Team ("Patterns and Problems in Emerging Multiagent Systems")
// found agent swarms converge hard: 18 of 30 agents independently created the
// same git branch name, and a swarm managing a job queue "flooded the system with
// high-frequency (30 times per second) polling daemons" — 2.4 million job requests
// to get 117 accepted. A dollar cap does eventually stop that, slowly, and takes
// the whole space down with it. A repeat cap stops it in seconds and takes down
// only the question that was looping.
//
// WHAT IT CAN AND CANNOT SEE. Grouping is on a hash of the prompt, so this catches
// convergent ASKING. It does not catch convergent DOING — thirty agents writing
// the same branch name from thirty differently-worded prompts are thirty distinct
// calls from in here. Worth stating plainly rather than letting the two blur.
//
// State is in memory and per-process: a window is at most WENDL_REPEAT_WINDOW_MS
// old, so a restart loses nothing that would still be enforceable a minute later.
// That's also why it isn't in store.mjs — this is a live control, not a record.

// Off by default. This refuses calls that would otherwise be served and billed,
// so switching it on is a deliberate act, not something a `git pull` does to a
// running system.
const LIMIT = Number(process.env.WENDL_REPEAT_LIMIT || 0);
const WINDOW_MS = Number(process.env.WENDL_REPEAT_WINDOW_MS || 60_000);

// Bound on distinct (scope, question) pairs held at once. A sweep only runs when
// the map grows past this, so the common path stays a single Map lookup.
const MAX_ENTRIES = 5000;

/** `${scope}\0${sig}` -> { scope, sig, since, count, suppressed, tripped } */
const entries = new Map();

export const config = () => ({ enabled: LIMIT > 0, limit: LIMIT, window_ms: WINDOW_MS });

function sweep(now) {
  for (const [id, e] of entries) if (now - e.since >= WINDOW_MS) entries.delete(id);
}

/**
 * Count this call against its (scope, question) window and decide whether to run it.
 *
 * Returns `{ ok: true }` when the brake is off, the call can't be grouped (no
 * scope or no prompt signature), or the window still has room. Otherwise
 * `{ ok: false, ... }` with everything a decline message needs.
 *
 * `firstTrip` is true exactly once per window per (scope, question): the caller
 * uses it to write ONE decline row to the spend log instead of one per attempt.
 * A client that ignores a 429 and keeps hammering at 30Hz must not be able to
 * turn a runaway token bill into a runaway disk bill.
 */
export function check(scope, sig, now = Date.now()) {
  if (!(LIMIT > 0) || !scope || !sig) return { ok: true };

  // NUL separator: attribution() strips control characters and virtual keys are
  // [a-z0-9-] only, so no scope value can forge a collision with another scope.
  const id = `${scope}\u0000${sig}`;
  let e = entries.get(id);
  if (!e || now - e.since >= WINDOW_MS) {
    if (entries.size >= MAX_ENTRIES) sweep(now);
    e = { scope, sig, since: now, count: 0, suppressed: 0, tripped: false };
    entries.set(id, e);
  }

  e.count++;
  if (e.count <= LIMIT) return { ok: true };

  const firstTrip = !e.tripped;
  if (firstTrip) e.tripped = true;
  else e.suppressed++;

  return {
    ok: false,
    firstTrip,
    scope,
    // How many identical calls actually REACHED a model. Not `count - 1`: once the
    // window is over the limit every further attempt is refused, so runs stop at the
    // limit while attempts keep climbing. Reporting attempts as runs would overstate
    // what the caller was billed for, in the one message whose job is to be trusted.
    ran: Math.min(e.count - 1, LIMIT),
    limit: LIMIT,
    windowMs: WINDOW_MS,
    suppressed: e.suppressed,
    resetInMs: Math.max(0, WINDOW_MS - (now - e.since)),
  };
}

/** Human-readable decline, for a 429 body an agent (or a person in the channel) reads. */
export function declineMessage(b) {
  const secs = Math.round(b.windowMs / 1000);
  const clears = Math.ceil(b.resetInMs / 1000);
  return `repeat limit: this exact question already ran ${b.ran}× in '${b.scope}' within ${secs}s `
    + `(limit ${b.limit}). That's a loop, not progress — this call was declined, not billed. `
    + `Clears in ${clears}s. Vary the prompt, or raise/disable the cap with WENDL_REPEAT_LIMIT.`;
}

/**
 * What is being blocked right now — the question an operator has mid-incident,
 * which the spend log can't answer because it deliberately records one row per
 * trip rather than one per refusal.
 */
export function live(now = Date.now()) {
  const tripped = [];
  for (const e of entries.values()) {
    if (!e.tripped || now - e.since >= WINDOW_MS) continue;
    tripped.push({
      scope: e.scope,
      prompt_sig: e.sig,
      attempts: e.count,
      declined: e.suppressed + 1,
      resets_in_ms: Math.max(0, WINDOW_MS - (now - e.since)),
    });
  }
  tripped.sort((a, b) => b.attempts - a.attempts);
  return { ...config(), tripped };
}

/** Test seam — drop all windows. */
export function reset() { entries.clear(); }
