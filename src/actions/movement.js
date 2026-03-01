// src/actions/movement.js
const { goals } = require("mineflayer-pathfinder");

function goto(bot, x, y, z) {
  bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z), false);
  bot._current = { type: "GOTO", startedAt: Date.now(), x, y, z };
}

function follow(bot, playerName) {
  bot._current = { type: "FOLLOW", startedAt: Date.now(), player: playerName };
}

function wander(bot, radius = 10) {
  bot._current = { type: "WANDER", startedAt: Date.now(), radius };
}

function tickMovement(bot) {
  const cur = bot._current;
  if (!cur || !bot.entity) return false;

  if (cur.type === "GOTO") {
    const p = bot.entity.position;
    const dx = p.x - cur.x, dy = p.y - cur.y, dz = p.z - cur.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (Date.now() - cur.startedAt > 120000 || dist < 2.0) {
      bot.pathfinder.setGoal(null);
      bot._current = null;
      bot._planQueue.shift();
    }
    return true;
  }

  if (cur.type === "FOLLOW") {
    const target = bot.players?.[cur.player]?.entity;
    if (!target || Date.now() - cur.startedAt > 120000) {
      bot.pathfinder.setGoal(null);
      bot._current = null;
      bot._planQueue.shift();
      return true;
    }
    const { x, y, z } = target.position;
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2), true);
    return true;
  }

  if (cur.type === "WANDER") {
    if (!bot.pathfinder.isMoving()) {
      const r = cur.radius ?? 10;
      const p = bot.entity.position;
      const dx = Math.floor((Math.random() * (2*r+1)) - r);
      const dz = Math.floor((Math.random() * (2*r+1)) - r);
      bot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(p.x + dx), Math.floor(p.y), Math.floor(p.z + dz)), false);
    }
    if (Date.now() - cur.startedAt > 60000) {
      bot.pathfinder.setGoal(null);
      bot._current = null;
      bot._planQueue.shift();
    }
    return true;
  }

  return false;
}

module.exports = { goto, follow, wander, tickMovement };
