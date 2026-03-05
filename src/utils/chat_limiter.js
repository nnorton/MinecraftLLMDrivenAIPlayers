// src/utils/chat_limiter.js
// Rate-limits in-game chat to prevent server kicks like "disconnect.spam".
// Also de-dupes identical messages for a short window.
//
// IMPORTANT: In some mineflayer builds/environments, bot.chat may not be
// available immediately after createBot(). This module lazily installs the
// wrapper when bot.chat becomes available (login/spawn/retry).

function parseIntSafe(v, defVal) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defVal;
}

function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function installChatLimiter(bot, opts = {}) {
  const enabled = opts.enabled ?? parseBool(process.env.CHAT_LIMIT_ENABLED, true);
  if (!enabled) return;

  if (!bot) return;

  // Avoid double-install
  if (bot._chatLimiterInstalled) return;
  bot._chatLimiterInstalled = true;

  const rateMs = clamp(opts.rateMs ?? parseIntSafe(process.env.CHAT_LIMIT_RATE_MS, 3000), 250, 60000);
  const burst = clamp(opts.burst ?? parseIntSafe(process.env.CHAT_LIMIT_BURST, 2), 1, 10);
  const dedupeWindowMs = clamp(
    opts.dedupeWindowMs ?? parseIntSafe(process.env.CHAT_DEDUPE_WINDOW_MS, 15000),
    0,
    5 * 60 * 1000
  );
  const maxLen = clamp(opts.maxLen ?? parseIntSafe(process.env.CHAT_MAX_LEN, 220), 20, 240);

  const debug = String(process.env.DEBUG_CHAT_LIMIT || "").toLowerCase() === "true";

  const state = {
    tokens: burst,
    lastRefillAt: Date.now(),
    lastMsgAt: 0,
    recent: new Map(), // msg -> ts
    installedAt: null,
  };

  function refill(now) {
    const elapsed = now - state.lastRefillAt;
    if (elapsed <= 0) return;
    // Refill 1 token per rateMs
    const add = Math.floor(elapsed / rateMs);
    if (add > 0) {
      state.tokens = Math.min(burst, state.tokens + add);
      state.lastRefillAt += add * rateMs;
    }
  }

  function isDup(msg, now) {
    if (dedupeWindowMs <= 0) return false;
    const last = state.recent.get(msg);
    if (last && now - last < dedupeWindowMs) return true;

    state.recent.set(msg, now);

    // prevent unbounded growth
    if (state.recent.size > 64) {
      const cutoff = now - dedupeWindowMs;
      for (const [k, ts] of state.recent) {
        if (ts < cutoff) state.recent.delete(k);
      }
      if (state.recent.size > 64) state.recent.clear();
    }
    return false;
  }

  function tryPatchChat(where = "unknown") {
    // Some environments don't have bot.chat until later.
    if (typeof bot.chat !== "function") {
      if (debug) console.warn(`[${bot.username || "bot"}] [chat_limit] bot.chat unavailable @${where}`);
      return false;
    }

    // If already patched, no-op
    if (bot._chatLimit && bot.chat && bot.chat._isLimitedChat) return true;

    const originalChat = bot.chat.bind(bot);

    const limitedChat = (msg) => {
      const now = Date.now();
      const text = String(msg || "").replace(/\s+/g, " ").trim();
      if (!text) return;

      const clipped = text.slice(0, maxLen);

      // De-dupe identical messages
      if (isDup(clipped, now)) return;

      refill(now);
      if (state.tokens <= 0) {
        if (debug) console.warn(`[${bot.username}] [chat_limit] drop (rate) msg="${clipped}"`);
        return;
      }

      state.tokens -= 1;
      state.lastMsgAt = now;

      try {
        originalChat(clipped);
      } catch (e) {
        if (debug) console.warn(`[${bot.username}] [chat_limit] send failed: ${e?.message || e}`);
      }
    };

    // Marker for idempotency
    limitedChat._isLimitedChat = true;
    bot.chat = limitedChat;

    bot._chatLimit = {
      rateMs,
      burst,
      dedupeWindowMs,
      maxLen,
      get tokens() {
        refill(Date.now());
        return state.tokens;
      },
    };

    state.installedAt = Date.now();

    try {
      console.log(
        `[${bot.username}] [chat_limit] enabled @${where} rateMs=${rateMs} burst=${burst} dedupeMs=${dedupeWindowMs}`
      );
    } catch {}

    return true;
  }

  // Attempt immediately
  if (tryPatchChat("immediate")) return;

  // Try again on login/spawn (common places where chat becomes available)
  try {
    bot.once("login", () => tryPatchChat("login"));
  } catch {}
  try {
    bot.once("spawn", () => tryPatchChat("spawn"));
  } catch {}

  // Also retry a few times on a timer in case neither event fires before chat exists.
  let attempts = 0;
  const maxAttempts = clamp(parseIntSafe(process.env.CHAT_LIMIT_PATCH_ATTEMPTS, 20), 1, 200);
  const retryMs = clamp(parseIntSafe(process.env.CHAT_LIMIT_PATCH_RETRY_MS, 250), 50, 5000);

  const t = setInterval(() => {
    attempts++;
    const ok = tryPatchChat(`retry#${attempts}`);
    if (ok || attempts >= maxAttempts) {
      clearInterval(t);
      if (!ok && debug) {
        console.warn(`[${bot.username || "bot"}] [chat_limit] failed to patch after ${attempts} attempts`);
      }
    }
  }, retryMs);

  t.unref?.();
}

module.exports = { installChatLimiter };
