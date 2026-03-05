// src/actions/gather.js
const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const { ensureBestToolForBlock } = require("../utils/tools");

const DEFAULT_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS || "32", 10);
const MAX_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS_MAX || "96", 10);
const EXPAND_SEARCH_STEPS = parseInt(process.env.SEARCH_RADIUS_EXPAND_STEPS || "3", 10); // how many radius expansions to try

const COLLECT_BLOCK_TIMEOUT_MS = parseInt(process.env.COLLECT_BLOCK_TIMEOUT_MS || "20000", 10);
const COLLECT_BATCH_TIMEOUT_MS = parseInt(process.env.COLLECT_BATCH_TIMEOUT_MS || "90000", 10);

function withTimeout(promise, ms, onTimeout) {
  const timeoutMs = Math.max(0, parseInt(ms, 10) || 0);
  if (!timeoutMs) return promise;

  let t;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {}
      reject(new Error(`collect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    t.unref?.();
  });

  return Promise.race([
    promise.finally(() => {
      try {
        clearTimeout(t);
      } catch {}
    }),
    timeoutPromise,
  ]);
}

function cleanupCollect(bot) {
  try {
    bot.stopDigging?.();
  } catch {}
  try {
    bot.pathfinder?.setGoal?.(null);
  } catch {}
  try {
    bot.clearControlStates?.();
  } catch {}
}

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

// --- Core "best effort" mining/collect helpers ---

function findBlocksByNames(bot, names, max = 64, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const ids = names.map((n) => mcData.blocksByName[n]?.id).filter(Boolean);
  if (!ids.length) return [];

  const positions = bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: max,
  });

  return (positions || []).map((p) => new Vec3(p.x, p.y, p.z));
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

      await ensureBestToolForBlock(bot, b);

      await withTimeout(
        bot.collectBlock.collect(b),
        COLLECT_BLOCK_TIMEOUT_MS,
        () => cleanupCollect(bot)
      );

      collected.push(pos);
    } catch (e) {
      const msg = shortErr(e);
      if (isPathfinderPlanningError(msg)) continue;
      continue;
    }
  }

  return collected.length;
}

async function collectPositions(bot, positions, count) {
  const batchSize = 6;
  let collected = 0;

  for (let i = 0; i < positions.length && collected < count; i += batchSize) {
    const batch = positions.slice(i, i + batchSize);
    const need = count - collected;

    const got = await withTimeout(
      bestEffortCollect(bot, batch, need),
      COLLECT_BATCH_TIMEOUT_MS,
      () => cleanupCollect(bot)
    );

    collected += got;
    await yieldEvery(i, 12, 15);
  }

  return collected;
}

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

// --- Existing gather convenience wrappers ---

async function gatherWood(bot, count = 8, radius = 64) {
  return mineTargets(bot, ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log"], count, radius);
}

async function gatherStone(bot, count = 16, radius = 64) {
  return mineTargets(bot, ["stone", "cobblestone"], count, radius);
}

async function gatherCoal(bot, count = 12, radius = 64) {
  return mineTargets(bot, ["coal_ore", "deepslate_coal_ore"], count, radius);
}

async function gatherIron(bot, count = 8, radius = 64) {
  return mineTargets(bot, ["iron_ore", "deepslate_iron_ore"], count, radius);
}

async function gatherFood(bot, count = 6, radius = 64) {
  // Best-effort: berries / animals aren’t blocks; this is placeholder “food-ish” logic.
  // If you have a better hunting/food action elsewhere, use it.
  return mineTargets(bot, ["hay_block", "melon", "pumpkin"], count, radius);
}

async function gatherCrops(bot, count = 8, radius = 64) {
  return mineTargets(bot, ["wheat", "carrots", "potatoes", "beetroots"], count, radius);
}

// --- Farming: harvest + replant (best effort) ---

async function farmHarvestReplant(bot, crops = ["wheat", "carrots", "potatoes"], max = 12, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const wanted = (crops || [])
    .map((c) => String(c || "").toLowerCase())
    .filter((c) => mcData.blocksByName[c]);

  if (!wanted.length) {
    logInfo(bot, `farmHarvestReplant: no valid crops (${(crops || []).join(",")})`);
    return 0;
  }

  const positions = findBlocksByNames(bot, wanted, Math.min(max * 3, 96), radius);
  if (!positions.length) return 0;

  // For simplicity, we just “collect” the crop blocks (mineflayer-collectblock handles approach/dig).
  // True replanting requires seed selection + placing; that logic lives in src/actions/farm.js in your repo.
  const got = await collectPositions(bot, positions, max);
  return got;
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
