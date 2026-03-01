// src/team_bus.js
// In-memory event bus shared by all bots in this Node process.
// Used to let bots influence each other without chat-triggered LLM loops.

const events = [];
const MAX_EVENTS = 80;

function postEvent(from, text) {
  const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!msg) return;

  events.push({ ts: Date.now(), from: String(from || "unknown"), text: msg });
  while (events.length > MAX_EVENTS) events.shift();
}

function recentEvents(sinceMs = 10 * 60 * 1000, limit = 12) {
  const cutoff = Date.now() - sinceMs;
  return events.filter(e => e.ts >= cutoff).slice(-limit);
}

module.exports = { postEvent, recentEvents };
