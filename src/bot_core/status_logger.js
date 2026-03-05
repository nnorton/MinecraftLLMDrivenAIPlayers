// src/bot_core/status_logger.js
//
// Periodic + on-change status logging for debugging "idle bots" in PM2 logs.

const { normalizeType, posObj } = require("./utils");

function safeGetGoal(bot) {
  try {
    const g = bot?.pathfinder?.goal;
    if (!g) return null;

    // Many goal objects have x/y/z or near() targets; keep this best-effort.
    const out = {};
    for (const k of ["x", "y", "z", "range", "radius"]) {
      if (g[k] !== undefined) out[k] = g[k];
    }
    if (Object.keys(out).length) return out;

    // Fallback: stringify class name
    return { type: g.constructor?.name || "Goal" };
  } catch {
    return null;
  }
}

function safeIsMoving(bot) {
  try {
    return !!bot?.pathfinder?.isMoving?.();
  } catch {
    return false;
  }
}

function formatHeldItem(bot) {
  try {
    const it = bot?.heldItem;
    if (!it) return "none";
    const name = it.name || "unknown";
    const count = typeof it.count === "number" ? it.count : null;
    return count !== null ? `${name}x${count}` : name;
  } catch {
    return "unknown";
  }
}

function computeStatus(bot, config) {
  const now = Date.now();

  const curType = normalizeType(bot?._current?.type);
  const nextType = normalizeType(bot?._planQueue?.[0]?.type);
  const queueLen = Array.isArray(bot?._planQueue) ? bot._planQueue.length : 0;

  const moving = safeIsMoving(bot);
  const pos = posObj(bot);

  const humanAgoMs = bot?._lastHumanAt ? now - bot._lastHumanAt : null;
  const autoAgoMs = bot?._lastAutonomyAt ? now - bot._lastAutonomyAt : null;

  const stepStartedAt =
    bot?._currentStartedAt ||
    bot?._current?.startedAt ||
    bot?._current?.started_at ||
    null;

  const stepAgeMs = stepStartedAt ? now - stepStartedAt : null;

  const goal = config.STATUS_LOG_INCLUDE_GOAL ? safeGetGoal(bot) : null;

  // A compact, single-line status is easiest to scan in PM2 logs.
  const parts = [];
  parts.push(`planning=${bot?._planning ? 1 : 0}`);
  parts.push(`executing=${bot?._executing ? 1 : 0}`);
  parts.push(`moving=${moving ? 1 : 0}`);
  parts.push(`cur=${curType || "NONE"}`);
  if (stepAgeMs !== null) parts.push(`curMs=${Math.max(0, Math.floor(stepAgeMs))}`);
  parts.push(`next=${nextType || "NONE"}`);
  parts.push(`q=${queueLen}`);

  if (pos) parts.push(`pos=${pos.x},${pos.y},${pos.z}`);

  // These fields exist on mineflayer bots.
  if (typeof bot?.health === "number") parts.push(`hp=${bot.health}`);
  if (typeof bot?.food === "number") parts.push(`food=${bot.food}`);

  parts.push(`held=${formatHeldItem(bot)}`);

  if (humanAgoMs !== null) parts.push(`humanAgoS=${Math.floor(humanAgoMs / 1000)}`);
  if (autoAgoMs !== null) parts.push(`autoAgoS=${Math.floor(autoAgoMs / 1000)}`);

  if (goal) parts.push(`goal=${JSON.stringify(goal)}`);

  return {
    key: `${bot?._planning ? 1 : 0}|${bot?._executing ? 1 : 0}|${moving ? 1 : 0}|${curType}|${nextType}|${queueLen}`,
    line: parts.join(" "),
    curType,
    nextType,
    queueLen,
    moving,
  };
}

function startStatusLogger({ bot, config }) {
  const intervalMs = Math.max(2500, parseInt(config.STATUS_LOG_INTERVAL_MS || 15000, 10) || 15000);
  const onChange = !!config.STATUS_LOG_ON_CHANGE;

  let lastKey = null;
  let timer = null;

  function emit(reason) {
    if (!bot) return;
    const st = computeStatus(bot, config);
    if (onChange && reason === "tick" && lastKey === st.key) return;
    lastKey = st.key;

    try {
      console.log(`[${bot.username}] [status] ${st.line}`);
    } catch {}
  }

  // Emit immediately so we see status early after spawn.
  emit("start");

  timer = setInterval(() => emit("tick"), intervalMs);
  if (typeof timer?.unref === "function") timer.unref();

  return {
    stop: () => {
      try {
        if (timer) clearInterval(timer);
      } catch {}
      timer = null;
    },
    emit,
  };
}

module.exports = { startStatusLogger };
