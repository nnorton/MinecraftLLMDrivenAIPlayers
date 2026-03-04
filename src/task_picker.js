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

function stockpileBuildingBlocksTask(bot, counts) {
  // get stone/cobble for building
  if (!hasPickaxe(counts)) return { type: "CRAFT_TOOLS" };
  return { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 36 };
}

function generalProductiveTask(bot, counts) {
  // If hungry, try farming/food gathering (simple heuristic)
  if (bot.food != null && bot.food <= 10) {
    if (!hasAxe(counts)) return { type: "GATHER_WOOD", count: 12 };
    // FARM will harvest+replant if crops exist, otherwise it will create a small starter plot.
    return { type: "FARM", crops: ["wheat", "carrots", "potatoes"], max: 10, size: 5 };
  }

  // tools first
  if (!hasPickaxe(counts) || !hasAxe(counts)) return { type: "CRAFT_TOOLS" };

  // mine resources
  if ((counts.iron_ore || 0) < 12) return { type: "MINE_BLOCKS", targets: ["iron_ore", "coal_ore", "stone"], count: 18 };

  // smelt if we have ore
  if ((counts.iron_ore || 0) >= 10 && (counts.furnace || 0) > 0) return { type: "SMELT_ORE" };

  // default: mine/build
  return { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 14 };
}

function pickNextTask(bot) {
  const counts = invCounts(bot);

  // If a recent build failed, prioritize stockpiling
  const fails = recentFailuresFor ? recentFailuresFor(bot.username, 15 * 60 * 1000) : [];
  const recentBuildFail = (fails || []).some((f) => normalizeType(f?.type).includes("BUILD"));

  if (recentBuildFail) {
    return stockpileBuildingBlocksTask(bot, counts);
  }

  // Occasionally do something fun
  const okToDoExtras = hasPickaxe(counts) && (bot.food == null || bot.food > 10);
  if (okToDoExtras && Math.random() < 0.08) {
    return randChoice([
      { type: "FARM", crops: ["wheat", "carrots", "potatoes"], max: 10, size: 5 },
      { type: "BUILD_MONUMENT", height: 11, material: "stone_bricks" },
    ]);
  }

  return generalProductiveTask(bot, counts);
}

// Very small "human message -> deterministic plan" helper.
// This prevents idle behavior when LLM is off or LLM returns nothing.
function deterministicPlan(bot, message) {
  const m = String(message || "").toLowerCase();
  if (m.includes("wood")) return [{ type: "GATHER_WOOD", count: 16 }];
  if (m.includes("mine") || m.includes("iron") || m.includes("coal"))
    return [{ type: "MINE_BLOCKS", targets: ["iron_ore", "coal_ore", "stone"], count: 18 }];
  if (m.includes("build") || m.includes("fort")) return [{ type: "BUILD_STRUCTURE", kind: "FORT", size: 9, height: 4 }];
  return [pickNextTask(bot)];
}

module.exports = { pickNextTask, deterministicPlan };
