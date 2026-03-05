// src/actions/gather.js
const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const { ensureBestToolForBlock } = require("../utils/tools");

const DEFAULT_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS || "32", 10);
const MAX_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS_MAX || "96", 10);
const EXPAND_SEARCH_STEPS = parseInt(process.env.SEARCH_RADIUS_EXPAND_STEPS || "3", 10); // how many radius expansions to try

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

// --- Core "best effort" mining/collecting helpers ---

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

      await ensureBestToolForBlock(bot, b);
      await bot.collectBlock.collect(b);
      collected.push(pos);
    } catch (e) {
      const msg = shortErr(e);
      if (isPathfinderPlanningError(msg)) continue;
      continue;
    }
  }

  return collected.length;
}

function findBlocksByNames(bot, names, max = 32, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const ids = (names || [])
    .map((n) => mcData.blocksByName[String(n || "").toLowerCase()]?.id)
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

// --- Public gather functions ---

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

/**
 * mineTargets(bot, targets, count, radius)
 * Used by step_executor MINE_BLOCKS.
 *
 * targets: array of block names like ["coal_ore","iron_ore","stone"]
 * count: number of blocks to mine total
 * radius: optional max distance
 */
async function mineTargets(bot, targets = ["coal_ore", "iron_ore", "stone"], count = 10, radius = DEFAULT_SEARCH_RADIUS) {
  count = clamp(parseInt(count, 10) || 10, 1, 256);
  const mcData = mcDataLoader(bot.version);

  const desired = (targets || [])
    .map((t) => String(t || "").toLowerCase())
    .filter((t) => mcData.blocksByName[t]);

  if (!desired.length) {
    logInfo(bot, `mineTargets: no valid targets provided (${(targets || []).join(",")})`);
    return 0;
  }

  // Gradually expand radius if needed
  let r = radius ?? DEFAULT_SEARCH_RADIUS;
  r = clamp(parseInt(r, 10) || DEFAULT_SEARCH_RADIUS, 8, MAX_SEARCH_RADIUS);

  for (let step = 0; step < EXPAND_SEARCH_STEPS; step++) {
    const positions = findBlocksByNames(bot, desired, Math.min(count * 3, 96), r);
    if (positions.length) {
      const got = await collectPositions(bot, positions, count);
      if (got > 0) return got;
    }
    r = clamp(r + Math.round((MAX_SEARCH_RADIUS - (radius ?? DEFAULT_SEARCH_RADIUS)) / EXPAND_SEARCH_STEPS), 8, MAX_SEARCH_RADIUS);
  }

  logInfo(bot, `mineTargets: found 0 blocks for [${desired.join(",")}] within r<=${r}`);
  return 0;
}

// --- Farming harvest & replant (used by FARM_HARVEST_REPLANT) ---

function isMatureCrop(block) {
  // Many crops use metadata age 0..7 (wheat/carrots/potatoes/beetroots).
  // Some servers/modpacks may differ; best-effort.
  const md = block?.metadata;
  if (typeof md !== "number") return true;
  return md >= 7;
}

function seedItemForCropName(cropName) {
  const n = String(cropName || "").toLowerCase();
  if (n === "wheat") return "wheat_seeds";
  if (n === "carrots") return "carrot";
  if (n === "potatoes") return "potato";
  if (n === "beetroots" || n === "beetroot") return "beetroot_seeds";
  return null;
}

async function equipIfPresent(bot, itemName) {
  if (!itemName) return false;
  const it = bot.inventory.items().find((x) => x.name === itemName);
  if (!it) return false;
  try {
    await bot.equip(it, "hand");
    return true;
  } catch {
    return false;
  }
}

async function farmHarvestReplant(bot, crops = ["wheat", "carrots", "potatoes"], max = 12, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const wanted = (crops || [])
    .map((c) => String(c || "").toLowerCase())
    .filter((c) => mcData.blocksByName[c]);

  max = clamp(parseInt(max, 10) || 12, 1, 128);

  if (!wanted.length) {
    logInfo(bot, `farmHarvestReplant: no valid crops provided (${(crops || []).join(",")})`);
    return 0;
  }

  const r = clamp(parseInt(radius, 10) || DEFAULT_SEARCH_RADIUS, 8, MAX_SEARCH_RADIUS);
  const positions = findBlocksByNames(bot, wanted, Math.min(max * 4, 128), r);
  if (!positions.length) return 0;

  let harvested = 0;

  for (let i = 0; i < positions.length && harvested < max; i++) {
    await yieldEvery(i, 10, 10);

    const pos = positions[i];
    const block = bot.blockAt(pos);
    if (!block) continue;

    // skip immature crops
    if (!isMatureCrop(block)) continue;

    // Harvest (dig)
    try {
      await ensureBestToolForBlock(bot, block);
    } catch {}

    try {
      await bot.dig(block);
    } catch (e) {
      // ignore and keep going
      continue;
    }

    harvested += 1;

    // Replant best-effort
    const cropName = String(block.name || "").toLowerCase();
    const seedName = seedItemForCropName(cropName);

    const planted = await equipIfPresent(bot, seedName);
    if (!planted) continue;

    try {
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below) continue;

      // Only place on farmland/dirt-ish blocks; best-effort
      // Many servers require farmland specifically.
      const belowName = String(below.name || "");
      if (!belowName.includes("farmland") && !belowName.includes("dirt")) continue;

      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      // ignore placement failures
    }
  }

  return harvested;
}

module.exports = {
  // existing exports
  gatherWood,
  gatherStone,
  gatherCoal,
  gatherIron,
  gatherFood,
  gatherCrops,

  // required by step_executor.js
  mineTargets,
  farmHarvestReplant,
};
