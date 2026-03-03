// src/planner_core/non_llm.js

const { pickNextTask } = require("../task_picker");
const { inventoryCounts, hasAnyTool } = require("./utils");

function ensurePlanNonEmpty(bot, plan) {
  if (Array.isArray(plan) && plan.length > 0) return plan.slice(0, 3);
  const picked = pickNextTask(bot);
  if (picked && picked.type) return [picked];
  return [{ type: "WANDER" }];
}

function chooseHelpfulPlanNonLLM({ bot, humanMessage }) {
  const msg = String(humanMessage || "").toLowerCase();
  const counts = inventoryCounts(bot);
  const hasPick = hasAnyTool(counts, [
    "wooden_pickaxe",
    "stone_pickaxe",
    "iron_pickaxe",
    "diamond_pickaxe",
  ]);
  const hasAxe = hasAnyTool(counts, ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe"]);

  if (msg.includes("fort") || msg.includes("wall") || msg.includes("defense") || msg.includes("build")) {
    // Deterministic fort attempt; recovery logic in bot engine will mine when insufficient.
    if (!hasPick) {
      return [
        { type: "SAY", text: "I’ll craft tools, mine stone, then build a proper fort." },
        { type: "CRAFT_TOOLS" },
        { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 32, radius: 48 },
      ];
    }
    return [
      { type: "SAY", text: "Building a recognizable fort (9x9, 4-high walls) using cobblestone." },
      { type: "BUILD_STRUCTURE", kind: "FORT", size: 9, height: 4, material: "cobblestone" },
    ];
  }

  if (!hasPick || !hasAxe) {
    return [
      { type: "SAY", text: "Crafting tools and collecting starter resources." },
      { type: "CRAFT_TOOLS" },
      { type: "GATHER_WOOD", count: 10 },
    ];
  }

  return [
    { type: "SAY", text: "Continuing useful work: mining and processing resources." },
    { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12, radius: 48 },
    { type: "SMELT_ORE" },
  ];
}

module.exports = { ensurePlanNonEmpty, chooseHelpfulPlanNonLLM };
