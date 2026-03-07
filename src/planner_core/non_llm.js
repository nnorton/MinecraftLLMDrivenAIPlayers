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

  const wantsShelter =
    msg.includes("house") || msg.includes("hut") || msg.includes("cabin") || msg.includes("shelter") || msg.includes("base");
  const wantsFort = msg.includes("fort") || msg.includes("wall") || msg.includes("defense") || msg.includes("build");
  const wantsUtilities =
    msg.includes("bed") || msg.includes("storage") || msg.includes("chest") || msg.includes("crafting") || msg.includes("furnace");

  if (wantsShelter || wantsFort) {
    if (!hasPick) {
      return [
        { type: "SAY", text: "I’ll craft tools, gather materials, and build a proper shelter." },
        { type: "CRAFT_TOOLS" },
        { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 32, radius: 48 },
      ];
    }

    if (wantsShelter && !wantsFort) {
      return [
        { type: "SAY", text: "Building a compact shelter with a real roof and useful interior." },
        {
          type: "BUILD_STRUCTURE",
          kind: "HOUSE",
          size: 7,
          height: 3,
          material: counts.oak_planks ? "oak_planks" : "cobblestone",
          includeBed: wantsUtilities,
          includeStorage: wantsUtilities,
          includeCrafting: wantsUtilities,
          includeFurnace: wantsUtilities,
        },
      ];
    }

    return [
      { type: "SAY", text: wantsUtilities ? "Building a proper fort with useful interior blocks." : "Building a proper fort with full walls and a real layout." },
      {
        type: "BUILD_STRUCTURE",
        kind: "FORT",
        size: 9,
        height: 4,
        material: "cobblestone",
        includeBed: wantsUtilities,
        includeStorage: wantsUtilities,
        includeCrafting: wantsUtilities,
        includeFurnace: wantsUtilities,
      },
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
