// src/bot_core/deterministic_plan.js

const { pickNextTask } = require("../task_picker");

function deterministicPlan(bot, humanMessage) {
  const msg = String(humanMessage || "").toLowerCase();
  const wantsUtilities =
    msg.includes("bed") || msg.includes("storage") || msg.includes("chest") || msg.includes("crafting") || msg.includes("furnace");

  if (msg.includes("house") || msg.includes("hut") || msg.includes("cabin") || msg.includes("shelter") || msg.includes("base")) {
    return [
      { type: "SAY", text: "Understood — I’ll build a compact shelter with a realistic layout." },
      { type: "CRAFT_TOOLS" },
      { type: "GATHER_WOOD", count: 16, radius: 64 },
      {
        type: "BUILD_STRUCTURE",
        kind: "HOUSE",
        size: 7,
        height: 3,
        material: "oak_planks",
        includeBed: wantsUtilities,
        includeStorage: wantsUtilities,
        includeCrafting: wantsUtilities,
        includeFurnace: wantsUtilities,
      },
    ];
  }

  if (
    msg.includes("fort") ||
    msg.includes("wall") ||
    msg.includes("defense") ||
    msg.includes("castle")
  ) {
    return [
      { type: "SAY", text: wantsUtilities ? "Understood — I’ll build a proper fort with useful interior blocks." : "Understood — I’ll build a proper fort and keep working until it’s done." },
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 32, radius: 48 },
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

  if (msg.includes("monument") || msg.includes("obelisk") || msg.includes("statue")) {
    return [
      { type: "SAY", text: "Got it — I’ll build a recognizable monument." },
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 24, radius: 48 },
      { type: "BUILD_MONUMENT", height: 11, material: "stone_bricks" },
    ];
  }

  if (msg.includes("wood") || msg.includes("logs")) {
    return [
      { type: "SAY", text: "On it — gathering wood." },
      { type: "GATHER_WOOD", count: 12, radius: 64 },
    ];
  }

  if (msg.includes("iron") || msg.includes("coal") || msg.includes("mine")) {
    return [
      { type: "SAY", text: "On it — mining useful resources." },
      { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 18, radius: 64 },
      { type: "SMELT_ORE" },
    ];
  }

  const picked = pickNextTask(bot);
  if (picked) return [picked];
  return [{ type: "WANDER", radius: 24, maxMs: 20000 }];
}

module.exports = { deterministicPlan };
