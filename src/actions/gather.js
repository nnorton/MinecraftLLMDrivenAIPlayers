// src/actions/gather.js
const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");

const DEFAULT_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS || "32", 10);

// collectBlock can sometimes throw pathfinder errors like:
//   "Took to long to decide path to goal!"
// or fail on one unreachable block and abort the whole batch.
// This file wraps collectBlock with smaller batches + skip-on-failure behavior,
// so bots keep making progress instead of abandoning the whole task.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function yieldEvery(i, every = 12, delayMs = 10) {
  if (i % every === 0) await new Promise((r) => setTimeout(r, delayMs));
}

function safeChat(bot, msg) {
  try {
    bot.chat(String(msg || "").slice(0, 220));
  } catch {}
}

function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function isPathfinderPlanningError(msg) {
  const m = String(msg || "");
  return (
    /Took\s+to\s+long\s+to\s+decide\s+path\s+to\s+goal/i.test(m) ||
    /No\s+path/i.test(m) ||
    /Goal\s+is\s+invalid/i.test(m) ||
    /Cannot\s+find\s+path/i.test(m)
  );
}

async function bestEffortEquipForBlock(bot, block) {
  try {
    if (bot.tool && block) await bot.tool.equipForBlock(block);
  } catch {}
}

function findBlocksByNames(bot, names, count, maxDistance = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);

  const ids = names
    .map((n) => String(n).trim())
    .filter((n) => mcData.blocksByName[n])
    .map((n) => mcData.blocksByName[n].id);

  if (!ids.length) return [];

  return bot.findBlocks({
    matching: ids,
    maxDistance,
    count,
  });
}

function byDistanceToBot(bot, blocks) {
  const p = bot.entity?.position;
  if (!p) return blocks;
  return [...blocks].sort((a, b) => {
    const da = a.position.distanceTo(p);
    const db = b.position.distanceTo(p);
    return da - db;
  });
}

/**
 * Robust collect:
 * - split into small batches (default 4)
 * - if a batch fails, drop the farthest block in that batch and retry
 * - on repeated path planning timeouts, return what we have so far
 */
async function collectBlocksRobust(bot, blocks, wantCount, opts = {}) {
  if (!bot.collectBlock || !bot.collectBlock.collect) {
    throw new Error("collectBlock plugin not loaded (mineflayer-collectblock).");
  }
  if (!blocks.length || wantCount <= 0) return 0;

  const batchSize = clamp(parseInt(opts.batchSize ?? 4, 10) || 4, 1, 8);
  const maxBatchFailures = clamp(parseInt(opts.maxBatchFailures ?? 6, 10) || 6, 1, 20);

  let collected = 0;
  let failures = 0;

  // Prioritize nearby blocks first.
  let queue = byDistanceToBot(bot, blocks);

  await bestEffortEquipForBlock(bot, queue[0]);

  while (queue.length && collected < wantCount) {
    const remaining = wantCount - collected;
    const batch = queue.slice(0, Math.min(batchSize, remaining, queue.length));

    try {
      await bot.collectBlock.collect(batch);
      collected += batch.length;
      queue = queue.slice(batch.length);
    } catch (e) {
      failures += 1;
      const msg = shortErr(e);

      // If the pathfinder is timing out planning, don't thrash forever.
      if (isPathfinderPlanningError(msg) && failures >= 3) {
        return collected;
      }

      // Drop the farthest block in the batch and try again.
      const p = bot.entity?.position;
      if (p && batch.length > 1) {
        batch.sort((a, b) => b.position.distanceTo(p) - a.position.distanceTo(p));
      }
      const drop = batch[0];
      queue = queue.filter((b) => b !== drop);

      if (failures >= maxBatchFailures) {
        // Stop early but keep any progress we made.
        return collected;
      }

      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return collected;
}

async function collectPositions(bot, positions, count) {
  const blocks = positions.map((p) => bot.blockAt(p)).filter(Boolean);
  if (!blocks.length) return 0;

  const got = await collectBlocksRobust(bot, blocks, count, {
    batchSize: 4,
    maxBatchFailures: 8,
  });
  return Math.min(got, count);
}

async function gatherWood(bot, count = 8, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 8, 1, 64);
  const mcData = mcDataLoader(bot.version);

  const logNames = [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "dark_oak_log",
    "mangrove_log",
    "cherry_log",
  ].filter((n) => mcData.blocksByName[n]);

  const positions = findBlocksByNames(bot, logNames, Math.min(count * 3, 40), radius);
  if (!positions.length) {
    safeChat(bot, "No logs nearby.");
    return 0;
  }

  return await collectPositions(bot, positions, count);
}

async function mineTargets(
  bot,
  targets = ["coal_ore", "iron_ore", "stone"],
  count = 10,
  radius = DEFAULT_SEARCH_RADIUS
) {
  count = clamp(parseInt(count, 10) || 10, 1, 64);
  const mcData = mcDataLoader(bot.version);

  let valid = Array.isArray(targets) ? targets.map(String) : [];
  valid = valid.map((t) => t.trim()).filter((t) => mcData.blocksByName[t]);
  if (!valid.length && mcData.blocksByName["stone"]) valid = ["stone"];

  const positions = findBlocksByNames(bot, valid, Math.min(count * 3, 48), radius);
  if (!positions.length) {
    safeChat(bot, "No target blocks nearby.");
    return 0;
  }

  return await collectPositions(bot, positions, count);
}

async function farmHarvestReplant(
  bot,
  crops = ["wheat", "carrots", "potatoes"],
  max = 12,
  radius = DEFAULT_SEARCH_RADIUS
) {
  max = clamp(parseInt(max, 10) || 12, 1, 64);
  const mcData = mcDataLoader(bot.version);

  const cropList = Array.isArray(crops) ? crops.map(String) : [];
  const cropBlocks = cropList.map((c) => c.trim()).filter((c) => mcData.blocksByName[c]);
  if (!cropBlocks.length) {
    safeChat(bot, "No valid crops specified.");
    return 0;
  }

  const positions = findBlocksByNames(bot, cropBlocks, Math.min(max * 3, 48), radius);
  if (!positions.length) {
    safeChat(bot, "No crops nearby.");
    return 0;
  }

  const harvested = await collectPositions(bot, positions, max);

  // Replant loop (with yields to avoid timeouts)
  const inv = bot.inventory.items();
  let k = 0;

  for (const pos of positions.slice(0, Math.min(positions.length, max))) {
    const above = bot.blockAt(pos);
    if (!above) continue;

    if (above.name !== "air") continue;

    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || below.name !== "farmland") continue;

    const plantOrder = [];
    for (const crop of cropBlocks) {
      if (crop === "wheat") plantOrder.push("wheat_seeds");
      if (crop === "carrots") plantOrder.push("carrot");
      if (crop === "potatoes") plantOrder.push("potato");
    }

    const item = plantOrder.map((n) => inv.find((i) => i.name === n)).find(Boolean);
    if (!item) continue;

    try {
      await bot.equip(item, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {}

    await yieldEvery(++k, 8, 10);
  }

  if (harvested === 0) safeChat(bot, "Couldn't harvest crops.");
  return harvested;
}

module.exports = {
  gatherWood,
  mineTargets,
  farmHarvestReplant,
};
