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
    safeChat(bot, "No trees nearby.");
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

  // Try progressively larger radii so "mine stone" doesn't instantly no-op and cause thrash.
  let positions = [];
  const tries = Math.max(1, EXPAND_SEARCH_STEPS);
  const base = clamp(parseInt(radius, 10) || DEFAULT_SEARCH_RADIUS, 8, MAX_SEARCH_RADIUS);

  for (let i = 0; i < tries; i++) {
    const r = clamp(
      base + i * Math.floor((MAX_SEARCH_RADIUS - base) / Math.max(1, tries - 1)),
      8,
      MAX_SEARCH_RADIUS
    );
    positions = findBlocksByNames(bot, valid, Math.min(count * 4, 80), r);
    if (positions.length) break;
    await yieldEvery(i, 1, 20);
  }

  if (!positions.length) {
    // Signal failure so caller can inject exploration steps and retry.
    throw new Error(`No target blocks nearby (targets=${valid.join(",")}, radius<=${MAX_SEARCH_RADIUS})`);
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

    const plantOptions = [
      { block: "wheat", item: "wheat_seeds" },
      { block: "carrots", item: "carrot" },
      { block: "potatoes", item: "potato" },
    ];

    const opt = plantOptions.find((o) => cropBlocks.includes(o.block));
    if (!opt) continue;

    const seed = inv.find((it) => it.name === opt.item);
    if (!seed) continue;

    try {
      await bot.equip(seed, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      await yieldEvery(++k, 6, 25);
    } catch {
      continue;
    }
  }

  return harvested;
}

module.exports = {
  gatherWood,
  mineTargets,
  farmHarvestReplant,
};
