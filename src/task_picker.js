// src/task_picker.js
// Cheap non-LLM task selection to keep bots busy continuously.

function countInv(bot, nameContains) {
  const items = bot.inventory?.items?.() || [];
  return items
    .filter(i => i.name.includes(nameContains))
    .reduce((sum, i) => sum + (i.count || 0), 0);
}

function hasAny(bot, names) {
  const items = bot.inventory?.items?.() || [];
  const set = new Set(items.map(i => i.name));
  return names.some(n => set.has(n));
}

function isLow(bot) {
  return (bot.health ?? 20) <= 10 || (bot.food ?? 20) <= 8;
}

// Rotate through a simple “work cycle” so behavior isn’t repetitive.
const CYCLE = [
  { type: "GATHER_WOOD", count: 12 },
  { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 14 },
  { type: "FARM_HARVEST_REPLANT", crops: ["wheat", "carrots", "potatoes"], max: 12 },
  { type: "BUILD_MONUMENT_COMPLEX", kind: "OBELISK" },
  { type: "CRAFT_TOOLS" },
  { type: "SMELT_ORE" },
];

function pickNextTask(bot) {
  // Safety-first if struggling
  if (isLow(bot) || bot.time?.isNight) {
    return { type: "RETURN_BASE" };
  }

  // If bot has almost no blocks, gather wood (gives planks later)
  const planks = countInv(bot, "_planks");
  const logs = countInv(bot, "_log");
  const cobble = countInv(bot, "cobblestone");
  const blocks = planks + logs + cobble;

  if (blocks < 32) return { type: "GATHER_WOOD", count: 16 };

  // If they have no basic tools, craft them
  if (!hasAny(bot, ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"])) {
    return { type: "CRAFT_TOOLS" };
  }

  // Cycle so each bot stays busy without thinking too hard
  bot._workCycleIndex = (bot._workCycleIndex ?? Math.floor(Math.random() * CYCLE.length)) % CYCLE.length;
  const next = CYCLE[bot._workCycleIndex];
  bot._workCycleIndex = (bot._workCycleIndex + 1) % CYCLE.length;

  return next;
}

module.exports = { pickNextTask };
