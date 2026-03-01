// src/team_bus.js
// In-memory event bus shared by all bots in this Node process.
// Used to let bots influence each other without chat-triggered LLM loops.
// Now supports structured events + kinds + small data payloads.

const events = [];
const MAX_EVENTS = 120;

function _clampText(text, max = 220) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function _safeJson(data, maxChars = 400) {
  if (data == null) return null;
  try {
    const s = JSON.stringify(data);
    if (s.length <= maxChars) return data;
    // If too big, store a trimmed string version
    return { _trimmed: true, json: s.slice(0, maxChars) + "…" };
  } catch {
    return { _unserializable: true };
  }
}

/**
 * postEvent(from, text, kind="chat", data=null)
 * kind examples:
 * - "team" (general team status)
 * - "action_ok" | "action_fail"
 * - "info" | "warn"
 */
function postEvent(from, text, kind = "chat", data = null) {
  const msg = _clampText(text);
  if (!msg) return;

  events.push({
    ts: Date.now(),
    from: String(from || "unknown"),
    kind: String(kind || "chat"),
    text: msg,
    data: _safeJson(data),
  });

  while (events.length > MAX_EVENTS) events.shift();
}

/**
 * recentEvents(sinceMs=10m, limit=12, opts)
 * opts:
 * - kinds: string[] (include only these kinds)
 * - from: string | string[] (include only these senders)
 */
function recentEvents(sinceMs = 10 * 60 * 1000, limit = 12, opts = {}) {
  const cutoff = Date.now() - sinceMs;
  const kinds = opts.kinds ? new Set([].concat(opts.kinds)) : null;
  const froms = opts.from ? new Set([].concat(opts.from).map(String)) : null;

  const out = [];
  for (const e of events) {
    if (e.ts < cutoff) continue;
    if (kinds && !kinds.has(e.kind)) continue;
    if (froms && !froms.has(e.from)) continue;
    out.push(e);
  }
  return out.slice(-limit);
}

/**
 * Convenience: recent failures for a specific bot.
 */
function recentFailuresFor(botName, sinceMs = 15 * 60 * 1000, limit = 5) {
  return recentEvents(sinceMs, limit, {
    kinds: ["action_fail"],
    from: String(botName || ""),
  });
}

module.exports = {
  postEvent,
  recentEvents,
  recentFailuresFor,
};
