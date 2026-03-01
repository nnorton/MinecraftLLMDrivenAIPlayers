// src/actions/combat.js
const HOSTILES = new Set([
  "zombie","skeleton","creeper","spider","enderman","witch","drowned","husk","stray","pillager"
]);

function nearestHostile(bot, maxDist = 12) {
  let best = null;
  let bestD = Infinity;

  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e.type !== "mob") continue;
    if (!HOSTILES.has(e.name)) continue;

    const d = bot.entity.position.distanceTo(e.position);
    if (d < bestD && d <= maxDist) {
      best = e; bestD = d;
    }
  }
  return best;
}

async function fightMobs(bot, seconds = 25) {
  const start = Date.now();

  bot.chat("On watch.");

  while (Date.now() - start < seconds * 1000) {
    if (bot.health <= 8) {
      bot.chat("Retreating—low health.");
      return;
    }
    const target = nearestHostile(bot, 12);
    if (!target) return;

    // Move close & attack
    bot.lookAt(target.position, true);
    if (bot.entity.position.distanceTo(target.position) > 3) {
      // simple forward movement without heavy pathfinding
      bot.setControlState("forward", true);
      await new Promise(r => setTimeout(r, 400));
      bot.setControlState("forward", false);
    }
    try { bot.attack(target); } catch {}
    await new Promise(r => setTimeout(r, 600));
  }
}

module.exports = { fightMobs };
