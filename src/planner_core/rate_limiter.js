// src/planner_core/rate_limiter.js
//
// Per-bot LLM call rate limiter.
// Goal: ensure we NEVER call OpenAI more frequently than LLM_MIN_INTERVAL_MINUTES,
// even across process restarts and even if multiple planner loops race.

const { loadLLMMeta, saveLLMMeta } = require("../state_store");

function parseIntSafe(v, defVal) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : defVal;
}

function intervalMsFromEnv() {
  // Keep the env name the user expects.
  const minutes = parseIntSafe(process.env.LLM_MIN_INTERVAL_MINUTES, 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return minutes * 60 * 1000;
}

// In-memory cache to avoid disk reads on every tick.
const _cache = new Map(); // username -> { loaded, last_call_at_ms, last_success_at_ms }
const _locks = new Map(); // username -> Promise chain

async function withLock(username, fn) {
  const key = String(username || "bot");
  const prev = _locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  _locks.set(key, prev.then(() => next, () => next));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Best-effort cleanup when queue drains.
    if (_locks.get(key) === next) _locks.delete(key);
  }
}

async function ensureLoaded(username) {
  const key = String(username || "bot");
  const existing = _cache.get(key);
  if (existing?.loaded) return existing;

  const meta = (await loadLLMMeta(key)) || { last_call_at_ms: 0, last_success_at_ms: 0 };
  const record = { loaded: true, ...meta };
  _cache.set(key, record);
  return record;
}

/**
 * Attempt to reserve an LLM call slot for this bot.
 *
 * If allowed, we write last_call_at_ms immediately (reservation) so that
 * concurrent loops/processes don't stampede the API.
 */
async function reserveLLMCall({ username }) {
  const key = String(username || "bot");
  const intervalMs = intervalMsFromEnv();
  if (!intervalMs) {
    return { allowed: true, wait_ms: 0, interval_ms: 0 };
  }

  return withLock(key, async () => {
    const rec = await ensureLoaded(key);
    const now = Date.now();
    const last = Number.isFinite(rec.last_call_at_ms) ? rec.last_call_at_ms : 0;
    const nextAllowed = last ? last + intervalMs : 0;

    if (nextAllowed && now < nextAllowed) {
      return { allowed: false, wait_ms: Math.max(0, nextAllowed - now), interval_ms: intervalMs, last_call_at_ms: last };
    }

    // Reserve the slot now (prevents races).
    rec.last_call_at_ms = now;
    _cache.set(key, rec);
    await saveLLMMeta(key, { last_call_at_ms: rec.last_call_at_ms, last_success_at_ms: rec.last_success_at_ms });
    return { allowed: true, wait_ms: 0, interval_ms: intervalMs, last_call_at_ms: rec.last_call_at_ms };
  });
}

async function markLLMSuccess({ username }) {
  const key = String(username || "bot");
  return withLock(key, async () => {
    const rec = await ensureLoaded(key);
    rec.last_success_at_ms = Date.now();
    _cache.set(key, rec);
    await saveLLMMeta(key, { last_call_at_ms: rec.last_call_at_ms, last_success_at_ms: rec.last_success_at_ms });
  });
}

module.exports = {
  reserveLLMCall,
  markLLMSuccess,
};
