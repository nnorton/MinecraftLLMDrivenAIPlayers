// src/actions/craft.js
// Crafting + smelting helpers.
// IMPORTANT: Do NOT chat from inside these actions.
// Return structured results so the caller can decide what to say / cooldown.

const mcDataLoader = require("minecraft-data");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function invCount(bot, name) {
  const items = bot.inventory?.items?.() || [];
  return items
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + (i.count || 0), 0);
}

function invHas(bot, name, count = 1) {
  return invCount(bot, name) >= count;
}

function anyInvCountContains(bot, substr) {
  const items = bot.inventory?.items?.() || [];
  return items
    .filter((i) => i.name.includes(substr))
    .reduce((sum, i) => sum + (i.count || 0), 0);
}

function findNearbyBlock(bot, blockName, maxDistance = 6) {
  try {
    return bot.findBlock({
      matching: (b) => b && b.name === blockName,
      maxDistance,
      count: 1,
    });
  } catch {
    return null;
  }
}

async function gotoNear(bot, position, radius = 2) {
  if (!bot.pathfinder) return;
  const { goals } = require("mineflayer-pathfinder");
  const goal = new goals.GoalNear(position.x, position.y, position.z, radius);
  bot.pathfinder.setGoal(goal);
  // wait a bit for movement
  await sleep(1200);
}

async function craftItem(bot, mcData, itemName, count = 1, craftingTableBlock = null) {
  const item = mcData.itemsByName[itemName];
  if (!item) {
    return { ok: false, crafted: [], missing: [itemName], reason: `unknown_item:${itemName}` };
  }

  const recipes = bot.recipesFor(item.id, null, count, craftingTableBlock);
  if (!recipes || recipes.length === 0) {
    return { ok: false, crafted: [], missing: [itemName], reason: `no_recipe:${itemName}` };
  }

  // Try first recipe
  try {
    await bot.craft(recipes[0], count, craftingTableBlock);
    return { ok: true, crafted: [{ item: itemName, count }], missing: [], reason: "crafted" };
  } catch (e) {
    return { ok: false, crafted: [], missing: [itemName], reason: `craft_failed:${e?.message || e}` };
  }
}

async function ensurePlanks(bot, mcData, minPlanks = 8) {
  const havePlanks = anyInvCountContains(bot, "_planks");
  if (havePlanks >= minPlanks) return { ok: true, crafted: [], missing: [], reason: "planks_ok" };

  // Convert any *_log into planks (4 per log)
  const invItems = bot.inventory?.items?.() || [];
  const log = invItems.find((i) => i.name.endsWith("_log") && i.count > 0);
  if (!log) {
    return { ok: false, crafted: [], missing: ["*_log"], reason: "no_logs" };
  }

  // Craft planks from that log type
  const plankName = log.name.replace("_log", "_planks");
  const needed = Math.max(1, Math.ceil((minPlanks - havePlanks) / 4));

  const res = await craftItem(bot, mcData, plankName, needed, null);
  return res.ok
    ? { ok: true, crafted: res.crafted, missing: [], reason: "crafted_planks" }
    : { ok: false, crafted: [], missing: [plankName], reason: res.reason };
}

async function ensureSticks(bot, mcData, minSticks = 8) {
  const haveSticks = invCount(bot, "stick");
  if (haveSticks >= minSticks) return { ok: true, crafted: [], missing: [], reason: "sticks_ok" };

  // Need planks first
  const planksRes = await ensurePlanks(bot, mcData, 4);
  if (!planksRes.ok) return planksRes;

  const neededCrafts = Math.max(1, Math.ceil((minSticks - haveSticks) / 4)); // 4 sticks per craft
  const res = await craftItem(bot, mcData, "stick", neededCrafts, null);
  return res.ok
    ? { ok: true, crafted: res.crafted, missing: [], reason: "crafted_sticks" }
    : { ok: false, crafted: [], missing: ["stick"], reason: res.reason };
}

async function ensureCraftingTable(bot, mcData) {
  // If there is a nearby table, use it
  const tableBlock = findNearbyBlock(bot, "crafting_table", 6);
  if (tableBlock) return { ok: true, table: tableBlock, crafted: [], missing: [], reason: "table_found" };

  // If we have one in inventory, place it
  if (!invHas(bot, "crafting_table", 1)) {
    // Need planks to craft it
    const planksRes = await ensurePlanks(bot, mcData, 4);
    if (!planksRes.ok) {
      return { ok: false, table: null, crafted: planksRes.crafted || [], missing: planksRes.missing || ["_planks"], reason: planksRes.reason };
    }
    const res = await craftItem(bot, mcData, "crafting_table", 1, null);
    if (!res.ok) return { ok: false, table: null, crafted: [], missing: ["crafting_table"], reason: res.reason };
  }

  // Place crafting table on a nearby solid block
  const reference = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!reference) {
    return { ok: false, table: null, crafted: [], missing: ["solid_block"], reason: "no_ground_block" };
  }

  try {
    await bot.equip(mcData.itemsByName.crafting_table.id, "hand");
  } catch {
    // fallback: search by name
    const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
    if (!tableItem) return { ok: false, table: null, crafted: [], missing: ["crafting_table"], reason: "no_table_item" };
    await bot.equip(tableItem, "hand");
  }

  // Try placing adjacent
  const targets = [
    reference.position.offset(1, 0, 0),
    reference.position.offset(-1, 0, 0),
    reference.position.offset(0, 0, 1),
    reference.position.offset(0, 0, -1),
  ];

  for (const pos of targets) {
    const placeAgainst = bot.blockAt(pos);
    if (!placeAgainst) continue;
    // place the table on top of placeAgainst
    try {
      await gotoNear(bot, placeAgainst.position, 2);
      await bot.placeBlock(placeAgainst, { x: 0, y: 1, z: 0 });
      await sleep(300);
      const newTable = findNearbyBlock(bot, "crafting_table", 4);
      if (newTable) return { ok: true, table: newTable, crafted: [], missing: [], reason: "table_placed" };
    } catch {
      // try next position
    }
  }

  return { ok: false, table: null, crafted: [], missing: ["place_crafting_table"], reason: "place_failed" };
}

/**
 * Craft useful tools. Priority:
 * - pickaxe (wood -> stone if possible)
 * - axe
 * - shovel
 * Never chats. Returns {ok, crafted, missing, reason}.
 */
async function craftTools(bot) {
  const mcData = mcDataLoader(bot.version);
  const crafted = [];
  const missing = [];

  // If we already have a pickaxe, still consider crafting an axe/shovel later
  const hasPick =
    invHas(bot, "diamond_pickaxe") ||
    invHas(bot, "iron_pickaxe") ||
    invHas(bot, "stone_pickaxe") ||
    invHas(bot, "wooden_pickaxe");

  // Ensure basic materials
  const planksRes = await ensurePlanks(bot, mcData, 8);
  if (!planksRes.ok) return { ok: false, crafted, missing: planksRes.missing || ["*_log"], reason: planksRes.reason };
  crafted.push(...(planksRes.crafted || []));

  const sticksRes = await ensureSticks(bot, mcData, 8);
  if (!sticksRes.ok) return { ok: false, crafted, missing: sticksRes.missing || ["stick"], reason: sticksRes.reason };
  crafted.push(...(sticksRes.crafted || []));

  // Ensure a crafting table (for tools)
  const tableRes = await ensureCraftingTable(bot, mcData);
  if (!tableRes.ok) return { ok: false, crafted, missing: tableRes.missing || ["crafting_table"], reason: tableRes.reason };

  const tableBlock = tableRes.table;

  // Choose best tier we can craft
  const canStone = invHas(bot, "cobblestone", 3);
  const canIron = invHas(bot, "iron_ingot", 3); // if you already have ingots

  // Helper: craft tool if missing
  async function craftIfMissing(toolName) {
    if (invHas(bot, toolName, 1)) return { ok: true, crafted: [] };
    const res = await craftItem(bot, mcData, toolName, 1, tableBlock);
    if (res.ok) crafted.push(...res.crafted);
    else missing.push(...res.missing);
    return res;
  }

  // Pickaxe
  if (!hasPick) {
    if (canIron) {
      await craftIfMissing("iron_pickaxe");
    } else if (canStone) {
      await craftIfMissing("stone_pickaxe");
    } else {
      await craftIfMissing("wooden_pickaxe");
    }
  }

  // Axe (optional, helpful for wood)
  if (!invHas(bot, "iron_axe") && !invHas(bot, "stone_axe") && !invHas(bot, "wooden_axe")) {
    if (invHas(bot, "iron_ingot", 3)) {
      await craftIfMissing("iron_axe");
    } else if (invHas(bot, "cobblestone", 3)) {
      await craftIfMissing("stone_axe");
    } else {
      await craftIfMissing("wooden_axe");
    }
  }

  // Shovel (optional)
  if (!invHas(bot, "iron_shovel") && !invHas(bot, "stone_shovel") && !invHas(bot, "wooden_shovel")) {
    if (invHas(bot, "iron_ingot", 1)) {
      await craftIfMissing("iron_shovel");
    } else if (invHas(bot, "cobblestone", 1)) {
      await craftIfMissing("stone_shovel");
    } else {
      await craftIfMissing("wooden_shovel");
    }
  }

  if (crafted.length === 0 && missing.length > 0) {
    return { ok: false, crafted, missing: Array.from(new Set(missing)), reason: "could_not_craft_tools" };
  }

  return { ok: true, crafted, missing: Array.from(new Set(missing)), reason: crafted.length ? "crafted_tools" : "tools_already_present" };
}

/**
 * Smelt ore if possible. Will:
 * - use nearby furnace if present
 * - otherwise craft+place furnace if possible
 * - smelt iron ore using coal/charcoal if available
 *
 * Note: Smelting automation varies by server/protocol/mods; this is best-effort.
 */
async function smeltOre(bot) {
  const mcData = mcDataLoader(bot.version);
  const crafted = [];
  const missing = [];

  const oreName = invHas(bot, "raw_iron") ? "raw_iron" : (invHas(bot, "iron_ore") ? "iron_ore" : null);
  if (!oreName) return { ok: false, crafted, missing: ["iron_ore/raw_iron"], reason: "no_iron_ore" };

  const fuelName = invHas(bot, "coal") ? "coal" : (invHas(bot, "charcoal") ? "charcoal" : null);
  if (!fuelName) return { ok: false, crafted, missing: ["coal/charcoal"], reason: "no_fuel" };

  let furnaceBlock = findNearbyBlock(bot, "furnace", 6);

  if (!furnaceBlock) {
    // Try to craft a furnace if possible (8 cobblestone)
    if (!invHas(bot, "furnace", 1)) {
      if (!invHas(bot, "cobblestone", 8)) {
        return { ok: false, crafted, missing: ["furnace", "cobblestonex8"], reason: "no_furnace_and_no_cobble" };
      }
      const res = await craftItem(bot, mcData, "furnace", 1, null);
      if (!res.ok) return { ok: false, crafted, missing: ["furnace"], reason: res.reason };
      crafted.push(...res.crafted);
    }

    // Place furnace
    const ground = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!ground) return { ok: false, crafted, missing: ["solid_block"], reason: "no_ground_block" };

    try {
      await bot.equip(mcData.itemsByName.furnace.id, "hand");
    } catch {
      const furnaceItem = bot.inventory.items().find((i) => i.name === "furnace");
      if (!furnaceItem) return { ok: false, crafted, missing: ["furnace"], reason: "no_furnace_item" };
      await bot.equip(furnaceItem, "hand");
    }

    try {
      await gotoNear(bot, ground.position, 2);
      await bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
      await sleep(300);
      furnaceBlock = findNearbyBlock(bot, "furnace", 4);
    } catch (e) {
      return { ok: false, crafted, missing: ["place_furnace"], reason: `place_failed:${e?.message || e}` };
    }
  }

  if (!furnaceBlock) {
    return { ok: false, crafted, missing: ["furnace"], reason: "furnace_not_found_or_place_failed" };
  }

  // Open furnace UI and insert items
  // NOTE: Works on typical Mineflayer-supported servers. If your server differs, you may need adapter logic.
  try {
    await gotoNear(bot, furnaceBlock.position, 2);
    const furnace = await bot.openFurnace(furnaceBlock);

    // Put input and fuel
    const oreItem = bot.inventory.items().find((i) => i.name === oreName);
    const fuelItem = bot.inventory.items().find((i) => i.name === fuelName);

    if (!oreItem) return { ok: false, crafted, missing: [oreName], reason: "ore_missing_at_open" };
    if (!fuelItem) return { ok: false, crafted, missing: [fuelName], reason: "fuel_missing_at_open" };

    await furnace.putInput(oreItem.type, null, Math.min(oreItem.count, 16));
    await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 16));

    // Let it start; we won't wait for completion to avoid long blocking
    await sleep(300);
    furnace.close();

    return { ok: true, crafted, missing: [], reason: `smelt_started:${oreName}` };
  } catch (e) {
    return { ok: false, crafted, missing: ["openFurnace"], reason: `smelt_failed:${e?.message || e}` };
  }
}

module.exports = { craftTools, smeltOre };
