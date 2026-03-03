// src/utils/tools.js
// Utility helpers for equipping the best available tool before interacting with blocks.
// This prevents bots from mining/chopping with whatever random item is in-hand (e.g., dirt).

const mcDataLoader = require("minecraft-data");

const TIER_RANK = {
  netherite: 6,
  diamond: 5,
  iron: 4,
  stone: 3,
  golden: 2,
  gold: 2, // some servers/mods
  wooden: 1,
  wood: 1,
};

function tierRank(itemName = "") {
  const n = String(itemName);
  for (const [tier, rank] of Object.entries(TIER_RANK)) {
    if (n.startsWith(tier + "_")) return rank;
  }
  return 0;
}

function isToolName(name = "") {
  return /(pickaxe|axe|shovel|hoe|shears)$/i.test(String(name));
}

function inventoryMap(bot) {
  const items = bot.inventory?.items?.() || [];
  const map = new Map();
  for (const it of items) map.set(it.name, it);
  return map;
}

function bestByTier(items) {
  let best = null;
  let bestRank = -1;
  for (const it of items) {
    const r = tierRank(it.name);
    if (r > bestRank) {
      bestRank = r;
      best = it;
    }
  }
  // If all ties/unknown, just pick first
  return best || items[0] || null;
}

function preferredToolTypeForBlockName(blockName = "") {
  const n = String(blockName);
  if (/_log$|_wood$|stem$|hyphae$|_planks$/.test(n)) return "axe";
  if (/stone|ore|deepslate|netherrack|basalt|andesite|diorite|granite|end_stone|blackstone/.test(n))
    return "pickaxe";
  if (/dirt|grass|sand|gravel|clay|podzol|mycelium|soul_sand|soul_soil/.test(n)) return "shovel";
  if (/leaves|wart_block|hay_block/.test(n)) return "hoe";
  return null;
}

async function equipIfNeeded(bot, item) {
  if (!item) return false;
  const held = bot.heldItem?.name;
  if (held === item.name) return true;
  try {
    await bot.equip(item, "hand");
    return true;
  } catch {
    return false;
  }
}

/**
 * Equip the best available tool for the given block.
 * - Uses minecraft-data harvestTools when present (most accurate).
 * - Falls back to name-based heuristics otherwise.
 * - Uses mineflayer-tool plugin if available, but does not require it.
 *
 * @returns {Promise<boolean>} true if we equipped something (or already correct), else false.
 */
async function ensureBestToolForBlock(bot, block) {
  if (!bot || !block) return false;

  // 1) Fast-path: if mineflayer-tool is present, try it first.
  // It generally chooses a valid tool from inventory for the block.
  try {
    if (bot.tool && typeof bot.tool.equipForBlock === "function") {
      // equipForBlock may throw if no tool exists; ignore.
      await bot.tool.equipForBlock(block);
      return true;
    }
  } catch {
    // fall through to our own logic
  }

  const mcData = mcDataLoader(bot.version);
  const inv = inventoryMap(bot);

  // 2) Use harvestTools from minecraft-data when available.
  const bData = mcData.blocks?.[block.type];
  const harvestTools = bData?.harvestTools;

  if (harvestTools && typeof harvestTools === "object") {
    const toolNames = Object.keys(harvestTools)
      .filter((id) => harvestTools[id])
      .map((id) => mcData.items?.[Number(id)]?.name)
      .filter(Boolean);

    const available = toolNames.map((n) => inv.get(n)).filter(Boolean);
    if (available.length) {
      const best = bestByTier(available);
      return await equipIfNeeded(bot, best);
    }
  }

  // 3) Fallback heuristic: pick a tool type based on block name.
  const prefType = preferredToolTypeForBlockName(block.name);
  if (!prefType) return false;

  const available = [];
  for (const it of inv.values()) {
    if (!isToolName(it.name)) continue;

    if (it.name.endsWith("_" + prefType) || (prefType === "axe" && it.name.endsWith("_axe"))) {
      available.push(it);
    }

    // shears are special (not tiered)
    if (prefType === "shears" && it.name === "shears") available.push(it);
  }

  if (!available.length) return false;

  const best = bestByTier(available);
  return await equipIfNeeded(bot, best);
}

module.exports = { ensureBestToolForBlock };
