// src/task_picker.js
// Deterministic, non-LLM task selection for keeping bots productive.

const { recentFailuresFor } = require("./team_bus");

function normalizeType(t) {
  return String(t || "").trim().toUpperCase();
}

function invCounts(bot) {
  const items = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of items) counts[it.name] = (counts[it.name] || 0) + it.count;
  return counts;
}

function hasAxe(counts) {
  return !!(
    counts.wooden_axe ||
    counts.stone_axe ||
    counts.iron_axe ||
    counts.golden_axe ||
    counts.diamond_axe ||
    counts.netherite_axe
  );
}

function hasPickaxe(counts) {
  return !!(
    counts.wooden_pickaxe ||
    counts.stone_pickaxe ||
    counts.iron_pickaxe ||
    counts.golden_pickaxe ||
    counts.diamond_pickaxe ||
    counts.netherite_pickaxe
  );
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function canDo(bot, type) {
  const t = normalizeType(type);
  const cd = bot?._cooldowns?.[t];
  if (!cd) return true;
  return Date.now() >= cd;
}

function stockpileBuildingBlocksTask(bot, counts) {
  if (!hasPickaxe(counts)) return { type: "CRAFT_TOOLS" };
  return { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 36 };
}

function generalProductiveTask(bot, counts) {
  if (bot.food != null && bot.food <= 10) {
    if (!hasAxe(counts)) return { type: "GATHER_WOOD", count: 12 };

    if (canDo(bot, "FARM")) {
      return { type: "FARM", crops: ["wheat", "carrots", "potatoes"], max: 10, size: 5 };
    }

    return { type: "MINE_BLOCKS", targets: ["coal_ore", "stone"], count: 10 };
  }

  if (!hasPickaxe(counts) || !hasAxe(counts)) return { type: "CRAFT_TOOLS" };
  if ((counts.iron_ore || 0) < 12) return { type: "MINE_BLOCKS", targets: ["iron_ore", "coal_ore", "stone"], count: 18 };
  if ((counts.iron_ore || 0) >= 10 && (counts.furnace || 0) > 0) return { type: "SMELT_ORE" };

  return { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 14 };
}

function pickNextTask(bot) {
  const counts = invCounts(bot);

  const fails = recentFailuresFor ? recentFailuresFor(bot.username, 15 * 60 * 1000) : [];
  const recentBuildFail = (fails || []).some((f) => normalizeType(f?.type).includes("BUILD"));

  if (recentBuildFail) {
    return stockpileBuildingBlocksTask(bot, counts);
  }

  const okToDoExtras = hasPickaxe(counts) && (bot.food == null || bot.food > 10);
  if (okToDoExtras && Math.random() < 0.08) {
    return randChoice(
      [
        canDo(bot, "FARM") ? { type: "FARM", crops: ["wheat", "carrots", "potatoes"], max: 10, size: 5 } : null,
        {
          type: "BUILD_STRUCTURE",
          kind: "HOUSE",
          size: 7,
          height: 3,
          material: counts.oak_planks ? "oak_planks" : "cobblestone",
          includeBed: true,
          includeStorage: true,
          includeCrafting: true,
        },
        { type: "BUILD_MONUMENT", height: 11, material: "stone_bricks" },
      ].filter(Boolean)
    );
  }

  return generalProductiveTask(bot, counts);
}

function deterministicPlan(bot, message) {
  const m = String(message || "").toLowerCase();
  const wantsUtilities =
    m.includes("bed") || m.includes("storage") || m.includes("chest") || m.includes("crafting") || m.includes("furnace");

  if (m.includes("wood")) return [{ type: "GATHER_WOOD", count: 16 }];
  if (m.includes("mine") || m.includes("iron") || m.includes("coal"))
    return [{ type: "MINE_BLOCKS", targets: ["iron_ore", "coal_ore", "stone"], count: 18 }];
  if (m.includes("house") || m.includes("hut") || m.includes("cabin") || m.includes("shelter") || m.includes("base")) {
    return [{ type: "BUILD_STRUCTURE", kind: "HOUSE", size: 7, height: 3, includeBed: wantsUtilities, includeStorage: wantsUtilities, includeCrafting: wantsUtilities, includeFurnace: wantsUtilities }];
  }
  if (m.includes("build") || m.includes("fort")) {
    return [{ type: "BUILD_STRUCTURE", kind: "FORT", size: 9, height: 4, includeBed: wantsUtilities, includeStorage: wantsUtilities, includeCrafting: wantsUtilities, includeFurnace: wantsUtilities }];
  }
  return [pickNextTask(bot)];
}

module.exports = { pickNextTask, deterministicPlan };
