// src/utils/diag.js
// Lightweight diagnostic helpers for debugging disconnects / dropouts.

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "<unstringifiable>";
    }
  }
}

function shortOneLine(s, max = 380) {
  const str = String(s ?? "");
  const one = str.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 3) + "...";
}

function summarizeQueue(queue, maxItems = 6) {
  if (!Array.isArray(queue) || queue.length === 0) return "[]";
  const types = queue
    .slice(0, maxItems)
    .map((s) => String(s?.type || "?").toUpperCase());
  const more = queue.length > maxItems ? `+${queue.length - maxItems}` : "";
  return `[${types.join(",")}]${more}`;
}

function getGoalSummary(bot) {
  try {
    const g = bot?.pathfinder?.goal;
    if (!g) return null;
    const name = g.constructor?.name || "Goal";
    const out = { name };
    for (const k of ["x", "y", "z", "range", "radius"]) {
      if (g[k] !== undefined) out[k] = g[k];
    }
    return out;
  } catch {
    return null;
  }
}

function getBotSnapshot(bot) {
  const now = Date.now();
  const pos = bot?.entity?.position;
  const cur = bot?._current?.type ? String(bot._current.type).toUpperCase() : "NONE";
  const curAgeMs = bot?._currentStartedAt ? now - bot._currentStartedAt : null;

  const diag = bot?._diag || {};
  const lastPacketMs = diag.lastPacketAt ? now - diag.lastPacketAt : null;
  const lastMoveMs = diag.lastMoveAt ? now - diag.lastMoveAt : null;
  const sinceSpawnMs = diag.spawnedAt ? now - diag.spawnedAt : null;

  const mu = process.memoryUsage();
  const rssMB = Math.round(mu.rss / 1024 / 1024);
  const heapMB = Math.round(mu.heapUsed / 1024 / 1024);

  return {
    cur,
    curAgeMs,
    q: Array.isArray(bot?._planQueue) ? bot._planQueue.length : 0,
    queue: summarizeQueue(bot?._planQueue),
    planning: !!bot?._planning,
    executing: !!bot?._executing,
    moving: (() => {
      try {
        return !!bot?.pathfinder?.isMoving?.();
      } catch {
        return false;
      }
    })(),
    goal: getGoalSummary(bot),
    pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    hp: typeof bot?.health === "number" ? bot.health : null,
    food: typeof bot?.food === "number" ? bot.food : null,
    held: bot?.heldItem?.name ? `${bot.heldItem.name}x${bot.heldItem.count ?? ""}` : "none",
    lastPacketMs,
    lastMoveMs,
    sinceSpawnMs,
    rssMB,
    heapMB,
    eventLoopDelayMsP95: diag.eventLoopDelayMsP95 ?? null,
  };
}

module.exports = {
  safeJson,
  shortOneLine,
  summarizeQueue,
  getBotSnapshot,
};
