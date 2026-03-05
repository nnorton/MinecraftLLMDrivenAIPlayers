// src/actions/gather.js
const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const { ensureBestToolForBlock } = require("../utils/tools");

const DEFAULT_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS || "32", 10);
const MAX_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS_MAX || "96", 10);
const EXPAND_SEARCH_STEPS = parseInt(process.env.SEARCH_RADIUS_EXPAND_STEPS || "3", 10); // how many radius expansions to try

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

function logInfo(bot, msg) {
  try {
    console.log(`[${bot.username}] [gather] ${String(msg || "").slice(0, 220)}`);
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

async function bestEffortCollect(bot, blockPositions, count) {
  if (!blockPositions?.length) return 0;
  const toCollect = blockPositions.slice(0, Math.min(blockPositions.length, count));
  const collected = [];

  for (let i = 0; i < toCollect.length; i++) {
    const pos = toCollect[i];
    await yieldEvery(i, 10, 10);

    try {
      const b = bot.blockAt(pos);
      if (!b) continue;

      // Ensure we have the right tool equipped (pickaxe/axe/shovel/etc.)
      // before attempting to break the block. Without this, bots often mine/chop
      // with whatever random item is in-hand (e.g., dirt).
      await ensureBestToolForBlock(bot, b);

      // collectBlock expects Vec3s
      await bot.collectBlock.collect(b);
      collected.push(pos);
    } catch (e) {
      const msg = shortErr(e);
      if (isPathfinderPlanningError(msg)) {
        // Skip this target; keep going
        continue;
      }
      // Other errors also skip, but keep making progress
      continue;
    }
  }

  return collected.length;
}

function findBlocksByNames(bot, names, max = 32, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const ids = names
    .map((n) => mcData.blocksByName[n]?.id)
    .filter((id) => Number.isFinite(id));

  if (!ids.length) return [];

  const found = bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: max,
  });

  return found.map((p) => new Vec3(p.x, p.y, p.z));
}

async function collectPositions(bot, positions, count) {
  // Batch smaller to avoid aborting on one unreachable block
  const batchSize = 6;
  let collected = 0;

  for (let i = 0; i < positions.length && collected < count; i += batchSize) {
    const batch = positions.slice(i, i + batchSize);
    const need = count - collected;
    const got = await bestEffortCollect(bot, batch, need);
    collected += got;
    await yieldEvery(i, 12, 15);
  }

  return collected;
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

  const positions = findBlocksByNames(bot, logNames, Math.min(count * 3, 48), radius);
  if (!positions.length) {
    logInfo(bot, "No trees nearby.");
    return 0;
  }

  return await collectPositions(bot, positions, count);
}

async function gatherStone(bot, count = 16, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 16, 1, 128);
  const names = ["stone", "cobblestone", "deepslate", "cobbled_deepslate"];
  const positions = findBlocksByNames(bot, names, Math.min(count * 3, 64), radius);
  if (!positions.length) return 0;
  return await collectPositions(bot, positions, count);
}

async function gatherCoal(bot, count = 8, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 8, 1, 64);
  const names = ["coal_ore", "deepslate_coal_ore"];
  const positions = findBlocksByNames(bot, names, Math.min(count * 3, 32), radius);
  if (!positions.length) return 0;
  return await collectPositions(bot, positions, count);
}

async function gatherIron(bot, count = 8, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 8, 1, 64);
  const names = ["iron_ore", "deepslate_iron_ore", "raw_iron_block"];
  const positions = findBlocksByNames(bot, names, Math.min(count * 3, 32), radius);
  if (!positions.length) return 0;
  return await collectPositions(bot, positions, count);
}

async function gatherFood(bot, count = 6, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 6, 1, 64);

  // Simple: break nearby hay bales / wheat if present (depends on environment)
  const names = ["hay_block", "wheat"];
  const positions = findBlocksByNames(bot, names, Math.min(count * 2, 24), radius);
  if (!positions.length) return 0;
  return await collectPositions(bot, positions, count);
}

async function gatherCrops(bot, cropNames = ["wheat", "potatoes", "carrots"], count = 12, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 12, 1, 128);
  const mcData = mcDataLoader(bot.version);

  const valid = (cropNames || [])
    .map((n) => String(n || "").toLowerCase())
    .filter((n) => mcData.blocksByName[n]);

  if (!valid.length) {
    logInfo(bot, "No valid crops specified.");
    return 0;
  }

  let r = radius;
  for (let step = 0; step < EXPAND_SEARCH_STEPS; step++) {
    const positions = findBlocksByNames(bot, valid, Math.min(count * 3, 72), r);
    if (positions.length) return await collectPositions(bot, positions, count);
    r = clamp(r + Math.round((MAX_SEARCH_RADIUS - radius) / EXPAND_SEARCH_STEPS), radius, MAX_SEARCH_RADIUS);
  }

  logInfo(bot, "No crops nearby.");
  return 0;
}

module.exports = {
  gatherWood,
  gatherStone,
  gatherCoal,
  gatherIron,
  gatherFood,
  gatherCrops,
};
