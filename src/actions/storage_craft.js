// src/actions/storage_craft.js
// Craft + place a chest, returning the placed chest block-position ({x,y,z}) on success.

const mcDataLoader = require("minecraft-data");
const { Vec3 } = require("vec3");
const { getBase } = require("./memory");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function invCount(bot, name) {
  const items = bot.inventory?.items?.() || [];
  return items
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + (i.count || 0), 0);
}

function anyInvCountEndsWith(bot, suffix) {
  const items = bot.inventory?.items?.() || [];
  return items
    .filter((i) => i.name.endsWith(suffix))
    .reduce((sum, i) => sum + (i.count || 0), 0);
}

async function craftPlanksFromAnyLog(bot, mcData, minPlanks = 8) {
  const havePlanks = anyInvCountEndsWith(bot, "_planks");
  if (havePlanks >= minPlanks) return true;

  const invItems = bot.inventory?.items?.() || [];
  const log = invItems.find((i) => i.name.endsWith("_log") && i.count > 0);
  if (!log) return false;

  const plankName = log.name.replace("_log", "_planks");
  const plankItem = mcData.itemsByName[plankName];
  if (!plankItem) return false;

  const neededLogs = Math.max(1, Math.ceil((minPlanks - havePlanks) / 4));
  const recipe = bot.recipesFor(plankItem.id, null, 1, null)?.[0];
  if (!recipe) return false;

  try {
    await bot.craft(recipe, neededLogs, null);
    return true;
  } catch {
    return false;
  }
}

async function craftChest(bot, mcData) {
  if (invCount(bot, "chest") >= 1) return true;

  // Need 8 planks. Ensure planks via any *_log.
  const okPlanks = await craftPlanksFromAnyLog(bot, mcData, 8);
  if (!okPlanks) return false;

  const chestItem = mcData.itemsByName.chest;
  if (!chestItem) return false;
  const recipe = bot.recipesFor(chestItem.id, null, 1, null)?.[0];
  if (!recipe) return false;

  try {
    await bot.craft(recipe, 1, null);
    return invCount(bot, "chest") >= 1;
  } catch {
    return false;
  }
}

function pickPlacementOrigin(bot, nearBase) {
  const here = bot.entity?.position;
  if (!here) return null;
  if (!nearBase) return here;

  const base = getBase(bot);
  if (!base) return here;
  return new Vec3(base.x, base.y, base.z);
}

async function craftAndPlaceChest(bot, opts = {}) {
  const nearBase = opts.nearBase !== false; // default true
  const mcData = mcDataLoader(bot.version);

  const ok = await craftChest(bot, mcData);
  if (!ok) return null;

  const chestStack = bot.inventory.items().find((i) => i.name === "chest");
  if (!chestStack) return null;

  // Find a nearby solid block to place on.
  const origin = pickPlacementOrigin(bot, nearBase);
  if (!origin) return null;

  // Try a few offsets around origin.
  const offsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(2, 0, 0),
    new Vec3(-2, 0, 0),
    new Vec3(0, 0, 2),
    new Vec3(0, 0, -2),
  ];

  try {
    await bot.equip(chestStack, "hand");
  } catch {
    return null;
  }

  for (const off of offsets) {
    const placePos = origin.plus(off).floored();
    const below = bot.blockAt(placePos.offset(0, -1, 0));
    const at = bot.blockAt(placePos);
    if (!below) continue;
    if (!at || at.name !== "air") continue;

    try {
      // Walk near the placement target (avoid placing too far away).
      const { goals } = require("mineflayer-pathfinder");
      await bot.pathfinder.goto(new goals.GoalNear(placePos.x, placePos.y, placePos.z, 2));

      await bot.placeBlock(below, new Vec3(0, 1, 0));
      await sleep(250);

      const placedBlock = bot.blockAt(placePos);
      if (placedBlock && placedBlock.name === "chest") {
        return { x: placePos.x, y: placePos.y, z: placePos.z };
      }
    } catch {
      // try next offset
      continue;
    }
  }

  return null;
}

module.exports = {
  craftAndPlaceChest,
};
