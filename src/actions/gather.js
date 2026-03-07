// src/actions/gather.js
const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");
const { ensureBestToolForBlock } = require("../utils/tools");

const DEFAULT_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS || "32", 10);
const MAX_SEARCH_RADIUS = parseInt(process.env.SEARCH_RADIUS_MAX || "96", 10);
const EXPAND_SEARCH_STEPS = parseInt(process.env.SEARCH_RADIUS_EXPAND_STEPS || "3", 10);

const COLLECT_BLOCK_TIMEOUT_MS = parseInt(process.env.COLLECT_BLOCK_TIMEOUT_MS || "12000", 10);
const COLLECT_BATCH_TIMEOUT_MS = parseInt(process.env.COLLECT_BATCH_TIMEOUT_MS || "90000", 10);
const MOVE_TO_BLOCK_TIMEOUT_MS = parseInt(process.env.MOVE_TO_BLOCK_TIMEOUT_MS || "10000", 10);
const LOOK_STUCK_TIMEOUT_MS = parseInt(process.env.LOOK_STUCK_TIMEOUT_MS || "3500", 10);
const DIG_RETRY_LIMIT = parseInt(process.env.DIG_RETRY_LIMIT || "2", 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  if (i % every === 0) await sleep(delayMs);
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

function distanceToBlock(bot, block) {
  if (!bot?.entity?.position || !block?.position) return Infinity;
  return bot.entity.position.distanceTo(block.position);
}

function hasAdjacentAir(bot, pos) {
  const offsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0),
  ];
  for (const off of offsets) {
    const b = bot.blockAt(pos.plus(off));
    if (!b || b.name === "air" || b.boundingBox === "empty") return true;
  }
  return false;
}

function isLikelyLogName(name = "") {
  return /(_log|_stem|hyphae)$/i.test(String(name || ""));
}

function isStillTargetBlock(block, desiredNames) {
  if (!block) return false;
  return desiredNames.includes(String(block.name || "").toLowerCase());
}

function scoreTarget(bot, block, desiredNames) {
  if (!block || !isStillTargetBlock(block, desiredNames)) return Number.POSITIVE_INFINITY;
  let score = distanceToBlock(bot, block);

  if (!hasAdjacentAir(bot, block.position)) score += 8;
  if (isLikelyLogName(block.name)) {
    const above = bot.blockAt(block.position.offset(0, 1, 0));
    if (above && above.name === block.name) score += 2;
  }

  return score;
}

function findBlocksByNames(bot, names, max = 64, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const desiredNames = names.map((n) => String(n || "").toLowerCase());
  const ids = desiredNames.map((n) => mcData.blocksByName[n]?.id).filter(Boolean);
  if (!ids.length) return [];

  const positions = bot.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: max,
  });

  const blocks = (positions || [])
    .map((p) => bot.blockAt(new Vec3(p.x, p.y, p.z)))
    .filter(Boolean)
    .sort((a, b) => scoreTarget(bot, a, desiredNames) - scoreTarget(bot, b, desiredNames));

  const seen = new Set();
  return blocks.filter((b) => {
    const key = `${b.position.x},${b.position.y},${b.position.z}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function waitUntilNearBlock(bot, block, timeoutMs = MOVE_TO_BLOCK_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastPosKey = null;
  let stableSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const fresh = bot.blockAt(block.position);
    if (!fresh || fresh.name === "air") return fresh;

    const dist = distanceToBlock(bot, fresh);
    if (dist <= 4.6) return fresh;

    const pos = bot?.entity?.position;
    const posKey = pos ? `${Math.round(pos.x * 10)},${Math.round(pos.y * 10)},${Math.round(pos.z * 10)}` : "none";
    if (posKey !== lastPosKey) {
      lastPosKey = posKey;
      stableSince = Date.now();
    }

    const goalName = bot?.pathfinder?.goal?.constructor?.name || "";
    const moving = (() => {
      try {
        return !!bot.pathfinder?.isMoving?.();
      } catch {
        return false;
      }
    })();

    if (goalName === "GoalLookAtBlock" && !moving && Date.now() - stableSince >= LOOK_STUCK_TIMEOUT_MS) {
      throw new Error(`stuck_looking_at_block:${fresh.name}`);
    }

    await sleep(150);
  }

  throw new Error(`move_to_block_timeout:${block.name}`);
}

async function manualCollectBlock(bot, originalBlock) {
  let block = bot.blockAt(originalBlock.position);
  if (!block || block.name === "air") return 0;

  await ensureBestToolForBlock(bot, block);

  bot.pathfinder?.setGoal?.(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1), false);
  block = await waitUntilNearBlock(bot, block, MOVE_TO_BLOCK_TIMEOUT_MS);
  if (!block || block.name === "air") return 1;

  await ensureBestToolForBlock(bot, block);

  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  } catch {}

  const beforeName = block.name;

  await withTimeout(
    bot.dig(block, true),
    COLLECT_BLOCK_TIMEOUT_MS,
    () => cleanupCollect(bot)
  );

  await sleep(250);
  const after = bot.blockAt(block.position);
  return !after || after.name === "air" || after.name !== beforeName ? 1 : 0;
}

async function collectOneBlock(bot, block, desiredNames) {
  const fresh = bot.blockAt(block.position);
  if (!fresh || fresh.name === "air") return 0;
  if (!isStillTargetBlock(fresh, desiredNames)) return 0;

  for (let attempt = 1; attempt <= DIG_RETRY_LIMIT; attempt++) {
    try {
      const got = await manualCollectBlock(bot, fresh);
      if (got > 0) return got;
    } catch (e) {
      const msg = shortErr(e);
      cleanupCollect(bot);

      if (msg.includes("stuck_looking_at_block") || msg.includes("move_to_block_timeout")) {
        try {
          bot.pathfinder?.setGoal?.(null);
        } catch {}
        if (attempt < DIG_RETRY_LIMIT) {
          await sleep(250);
          continue;
        }
      }

      if (isPathfinderPlanningError(msg) && attempt < DIG_RETRY_LIMIT) {
        await sleep(250);
        continue;
      }

      if (attempt >= DIG_RETRY_LIMIT) {
        logInfo(bot, `skip target ${fresh.name} @ ${fresh.position.x},${fresh.position.y},${fresh.position.z} reason=${msg}`);
      }
    }
  }

  return 0;
}

async function collectPositions(bot, blocks, count, desiredNames) {
  let collected = 0;

  for (let i = 0; i < blocks.length && collected < count; i++) {
    await yieldEvery(i, 10, 15);

    const got = await withTimeout(
      collectOneBlock(bot, blocks[i], desiredNames),
      COLLECT_BLOCK_TIMEOUT_MS + MOVE_TO_BLOCK_TIMEOUT_MS + 1000,
      () => cleanupCollect(bot)
    ).catch((e) => {
      const msg = shortErr(e);
      if (!isPathfinderPlanningError(msg)) {
        logInfo(bot, `collectPositions timeout/fail reason=${msg}`);
      }
      return 0;
    });

    collected += got;
  }

  cleanupCollect(bot);
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

  let r = radius ?? DEFAULT_SEARCH_RADIUS;
  r = clamp(parseInt(r, 10) || DEFAULT_SEARCH_RADIUS, 8, MAX_SEARCH_RADIUS);

  const expandBy = Math.max(8, Math.round((MAX_SEARCH_RADIUS - r) / Math.max(1, EXPAND_SEARCH_STEPS)));

  for (let step = 0; step < EXPAND_SEARCH_STEPS; step++) {
    const blocks = findBlocksByNames(bot, desired, Math.min(count * 4, 96), r);
    if (blocks.length) {
      const got = await withTimeout(
        collectPositions(bot, blocks, count, desired),
        COLLECT_BATCH_TIMEOUT_MS,
        () => cleanupCollect(bot)
      ).catch((e) => {
        logInfo(bot, `mineTargets batch fail targets=[${desired.join(",")}] reason=${shortErr(e)}`);
        return 0;
      });

      if (got > 0) return got;
    }
    r = clamp(r + expandBy, 8, MAX_SEARCH_RADIUS);
  }

  logInfo(bot, `mineTargets: found 0 collectible blocks for [${desired.join(",")}] within r<=${r}`);
  return 0;
}

async function gatherWood(bot, count = 8, radius = 64) {
  return mineTargets(
    bot,
    ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"],
    count,
    radius
  );
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
  return mineTargets(bot, ["hay_block", "melon", "pumpkin"], count, radius);
}

async function gatherCrops(bot, count = 8, radius = 64) {
  return mineTargets(bot, ["wheat", "carrots", "potatoes", "beetroots"], count, radius);
}

async function farmHarvestReplant(bot, crops = ["wheat", "carrots", "potatoes"], max = 12, radius = DEFAULT_SEARCH_RADIUS) {
  const mcData = mcDataLoader(bot.version);
  const wanted = (crops || [])
    .map((c) => String(c || "").toLowerCase())
    .filter((c) => mcData.blocksByName[c]);

  if (!wanted.length) {
    logInfo(bot, `farmHarvestReplant: no valid crops (${(crops || []).join(",")})`);
    return 0;
  }

  const blocks = findBlocksByNames(bot, wanted, Math.min(max * 3, 96), radius);
  if (!blocks.length) return 0;

  return collectPositions(bot, blocks, max, wanted);
}

module.exports = {
  gatherWood,
  gatherStone,
  gatherCoal,
  gatherIron,
  gatherFood,
  gatherCrops,
  mineTargets,
  farmHarvestReplant,
};
