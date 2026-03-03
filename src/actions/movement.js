// src/actions/movement.js
const { goals } = require("mineflayer-pathfinder");

function _debug(bot, msg) {
  const on = String(process.env.DEBUG_BOT || "").toLowerCase() === "true";
  if (!on) return;
  try {
    console.log(`[${bot.username}] [movement] ${msg}`);
  } catch {}
}

function _setWanderGoal(bot, radius) {
  if (!bot?.entity?.position) return false;

  const r = Math.max(2, parseInt(radius, 10) || 10);
  const p = bot.entity.position;

  // Pick a nearby surface-ish coordinate. We keep y as current y to avoid
  // expensive "find surface" logic; pathfinder will adjust if needed.
  const dx = Math.floor(Math.random() * (2 * r + 1) - r);
  const dz = Math.floor(Math.random() * (2 * r + 1) - r);

  const gx = Math.floor(p.x + dx);
  const gy = Math.floor(p.y);
  const gz = Math.floor(p.z + dz);

  try {
    bot.pathfinder.setGoal(new goals.GoalNear(gx, gy, gz, 1), false);
    _debug(bot, `wander goal -> near (${gx}, ${gy}, ${gz}) r=${r}`);
    return true;
  } catch (e) {
    _debug(bot, `wander goal failed: ${e?.message || e}`);
    return false;
  }
}

function goto(bot, x, y, z) {
  bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z), false);
  bot._current = { type: "GOTO", startedAt: Date.now(), x, y, z };
  _debug(bot, `goto -> (${x}, ${y}, ${z})`);
}

function follow(bot, playerName) {
  bot._current = { type: "FOLLOW", startedAt: Date.now(), player: playerName };
  _debug(bot, `follow -> ${playerName}`);
}

function wander(bot, radius = 10, maxMs = 60000) {
  bot._current = { type: "WANDER", startedAt: Date.now(), radius, maxMs };

  // IMPORTANT: set an initial goal immediately so the bot starts moving
  // even if tickMovement isn't firing reliably.
  _setWanderGoal(bot, radius);
}

function tickMovement(bot) {
  const cur = bot._current;
  if (!cur || !bot.entity) return false;

  if (cur.type === "GOTO") {
    const p = bot.entity.position;
    const dx = p.x - cur.x,
      dy = p.y - cur.y,
      dz = p.z - cur.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Either reached goal or gave up after timeout.
    if (Date.now() - cur.startedAt > 120000 || dist < 2.0) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      bot._current = null;
      bot._planQueue.shift();
      _debug(bot, `goto done (dist=${dist.toFixed(2)})`);
    }
    return true;
  }

  if (cur.type === "FOLLOW") {
    const target = bot.players?.[cur.player]?.entity;
    if (!target || Date.now() - cur.startedAt > 120000) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      bot._current = null;
      bot._planQueue.shift();
      _debug(bot, `follow done (target missing or timeout)`);
      return true;
    }

    const { x, y, z } = target.position;
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2), true);
    } catch {}
    return true;
  }

  if (cur.type === "WANDER") {
    // If not moving, pick a new goal
    let moving = false;
    try {
      moving = !!bot.pathfinder.isMoving();
    } catch {
      moving = false;
    }

    if (!moving) {
      _setWanderGoal(bot, cur.radius ?? 10);
    }

    const maxMs = typeof cur.maxMs === "number" ? cur.maxMs : 60000;
    if (Date.now() - cur.startedAt > maxMs) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      bot._current = null;
      bot._planQueue.shift();
      _debug(bot, `wander done (timeout ${maxMs}ms)`);
    }
    return true;
  }

  return false;
}

module.exports = { goto, follow, wander, tickMovement };
