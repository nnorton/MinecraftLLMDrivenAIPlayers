// src/actions/farm.js
// Simple farming action for Mineflayer bots.

const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const gather = require("./gather");

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function yieldEvery(i, every = 12, delayMs = 10) {
  if (i % every === 0) await sleep(delayMs);
}

function invCount(bot, name) {
  const items = bot.inventory?.items?.() || [];
  return items.filter((i) => i.name === name).reduce((s, i) => s + (i.count || 0), 0);
}

function hasAny(bot, names) {
  return names.some((n) => invCount(bot, n) > 0);
}

function pickSeedItem(bot) {
  const inv = bot.inventory?.items?.() || [];
  const prefer = ["wheat_seeds", "carrot", "potato", "beetroot_seeds"];
  for (const name of prefer) {
    const it = inv.find((i) => i.name === name && i.count > 0);
    if (it) return it;
  }
  return null;
}

function seedToCropBlock(seedName) {
  if (seedName === "wheat_seeds") return "wheat";
  if (seedName === "carrot") return "carrots";
  if (seedName === "potato") return "potatoes";
  if (seedName === "beetroot_seeds") return "beetroots";
  return null;
}

function findAnyNearbyCrop(bot, cropBlocks, radius) {
  const mcData = mcDataLoader(bot.version);
  const ids = cropBlocks
    .map((n) => mcData.blocksByName[n]?.id)
    .filter((id) => Number.isFinite(id));
  if (!ids.length) return null;

  try {
    const pos = bot.findBlock({
      matching: ids,
      maxDistance: radius,
      count: 1,
    });
    return pos || null;
  } catch {
    return null;
  }
}

async function ensureHoe(bot) {
  const inv = bot.inventory?.items?.() || [];
  const hoe = inv.find((i) => i.name.endsWith("_hoe"));
  if (hoe) return hoe;

  // Try to craft a wooden/stone hoe as best-effort.
  const mcData = mcDataLoader(bot.version);
  const craftingTable = bot.findBlock({
    matching: (b) => b && b.name === "crafting_table",
    maxDistance: 6,
    count: 1,
  });

  const want = ["stone_hoe", "wooden_hoe"].find((n) => mcData.itemsByName[n]);
  if (!want) return null;

  const it = mcData.itemsByName[want];
  const recipes = bot.recipesFor(it.id, null, 1, craftingTable || null);
  if (!recipes?.length) return null;

  try {
    await bot.craft(recipes[0], 1, craftingTable || null);
  } catch {
    return null;
  }

  const inv2 = bot.inventory?.items?.() || [];
  return inv2.find((i) => i.name.endsWith("_hoe")) || null;
}

async function tryTill(bot, hoeItem, groundBlock) {
  if (!hoeItem || !groundBlock) return false;
  try {
    await bot.equip(hoeItem, "hand");
    await bot.activateBlock(groundBlock);
    await sleep(50);
    return true;
  } catch {
    return false;
  }
}

async function tryPlant(bot, seedItem, farmlandBlock) {
  if (!seedItem || !farmlandBlock) return false;
  try {
    await bot.equip(seedItem, "hand");
    await bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0));
    await sleep(40);
    return true;
  } catch {
    return false;
  }
}

async function tryPlaceWater(bot, groundBlock) {
  const inv = bot.inventory?.items?.() || [];
  const water = inv.find((i) => i.name === "water_bucket");
  if (!water) return false;

  try {
    const current = bot.blockAt(groundBlock.position);
    if (current && current.name !== "air" && current.name !== "water") {
      await bot.dig(current);
      await sleep(80);
    }

    const below = bot.blockAt(groundBlock.position.offset(0, -1, 0));
    if (!below) return false;

    await bot.equip(water, "hand");
    await bot.activateBlock(below);
    await sleep(120);
    return true;
  } catch {
    return false;
  }
}

function findCandidateGround(bot, radius = 6) {
  const mcData = mcDataLoader(bot.version);
  const groundNames = ["grass_block", "dirt", "coarse_dirt", "rooted_dirt"].filter(
    (n) => mcData.blocksByName[n]
  );
  const ids = groundNames.map((n) => mcData.blocksByName[n].id);
  if (!ids.length) return null;

  try {
    return (
      bot.findBlock({
        matching: (b) => {
          if (!b) return false;
          if (!ids.includes(b.type)) return false;
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          return !!above && above.name === "air";
        },
        maxDistance: radius,
        count: 1,
      }) || null
    );
  } catch {
    return null;
  }
}

async function createAndPlantPlot(bot, { size = 5, radius = 6 } = {}) {
  size = clamp(parseInt(size, 10) || 5, 3, 9);
  if (size % 2 === 0) size += 1;

  const centerGround = findCandidateGround(bot, radius);
  if (!centerGround) return { ok: false, planted: 0, tilled: 0, reason: "no_ground" };

  const seedItem = pickSeedItem(bot);
  const hoeItem = await ensureHoe(bot);

  if (!hoeItem) return { ok: false, planted: 0, tilled: 0, reason: "no_hoe" };

  const half = Math.floor(size / 2);
  const base = centerGround.position;

  const wantsWater = hasAny(bot, ["water_bucket"]);
  if (wantsWater) {
    const center = bot.blockAt(base);
    if (center) await tryPlaceWater(bot, center);
  }

  let tilled = 0;
  let planted = 0;
  let idx = 0;

  for (let dx = -half; dx <= half; dx++) {
    for (let dz = -half; dz <= half; dz++) {
      await yieldEvery(++idx, 10, 12);

      const p = base.offset(dx, 0, dz);
      if (wantsWater && dx === 0 && dz === 0) continue;

      const ground = bot.blockAt(p);
      if (!ground) continue;

      const above = bot.blockAt(p.offset(0, 1, 0));
      if (!above || above.name !== "air") continue;

      if (ground.name !== "farmland") {
        const okTill = await tryTill(bot, hoeItem, ground);
        if (!okTill) continue;
        tilled += 1;
        await sleep(40);
      }

      const soil = bot.blockAt(p);
      if (!soil || soil.name !== "farmland") continue;

      if (seedItem) {
        const okPlant = await tryPlant(bot, seedItem, soil);
        if (okPlant) planted += 1;
      }
    }
  }

  if (planted > 0 || tilled > 0) {
    return { ok: true, planted, tilled, crop: seedToCropBlock(seedItem?.name) };
  }

  // Nothing happened: avoid returning ok=true and causing FARM tight-loops.
  if (!seedItem) return { ok: false, planted: 0, tilled, reason: "no_seeds" };
  return { ok: false, planted, tilled, reason: "no_progress" };
}

async function simpleFarm(bot, step = {}) {
  const radius = clamp(parseInt(step.radius, 10) || 16, 6, 64);
  const max = clamp(parseInt(step.max, 10) || 12, 1, 64);
  const size = clamp(parseInt(step.size, 10) || 5, 3, 9);

  const crops = Array.isArray(step.crops) && step.crops.length ? step.crops : ["wheat", "carrots", "potatoes"];
  const cropBlocks = crops.map(String).map((s) => s.trim());

  const found = findAnyNearbyCrop(bot, cropBlocks, radius);
  if (found) {
    await gather.farmHarvestReplant(bot, cropBlocks, max, radius);
    return { ok: true, mode: "harvest" };
  }

  const res = await createAndPlantPlot(bot, { size, radius: Math.min(10, radius) });
  if (res?.ok) return { ok: true, mode: "create", ...res };

  return { ok: false, mode: "create", reason: res?.reason || "create_failed", ...res };
}

module.exports = { simpleFarm };
