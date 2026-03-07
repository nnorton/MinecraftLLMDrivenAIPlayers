// src/planner_core/prompt.js

const { recentEvents, recentFailuresFor } = require("../team_bus");
const { drainMessages } = require("../inbox");
const { loadMemory, getWorldSummary } = require("../actions/memory");
const { summarizeInventory, inventoryCounts, hasAnyTool } = require("./utils");

function hasAnyStructureOfKind(mem, kinds) {
  const want = new Set((Array.isArray(kinds) ? kinds : [kinds]).map((k) => String(k).toUpperCase()));
  return (mem.structures || []).some((s) => want.has(String(s?.kind || "").toUpperCase()));
}

function structureUtilities(mem) {
  const set = new Set();
  for (const s of mem.structures || []) {
    for (const u of Array.isArray(s.utilities) ? s.utilities : []) {
      set.add(String(u).toLowerCase());
    }
  }
  return set;
}

function countByNamePrefix(counts, needle) {
  return Object.entries(counts || {})
    .filter(([name]) => String(name).includes(needle))
    .reduce((sum, [, n]) => sum + (n || 0), 0);
}

function cropItemCount(counts) {
  const names = ["wheat", "carrot", "carrots", "potato", "potatoes", "beetroot"];
  let total = 0;
  for (const n of names) total += counts[n] || 0;
  return total;
}

function seedItemCount(counts) {
  return (counts.wheat_seeds || 0) + (counts.beetroot_seeds || 0);
}

function buildResourceGapAnalysis(bot) {
  const mem = loadMemory(bot.username);
  const counts = inventoryCounts(bot);
  const gaps = [];

  const hasBase =
    !!mem.base ||
    hasAnyStructureOfKind(mem, ["FORT", "HOUSE", "HUT", "CABIN", "BASE", "SHELTER"]);

  const utilSet = structureUtilities(mem);
  const hasKnownFarm = Array.isArray(mem.farms) && mem.farms.length > 0;
  const hasStorage = !!mem.storage?.chest || utilSet.has("storage") || (counts.chest || 0) > 0;
  const hasCrafting = utilSet.has("crafting") || (counts.crafting_table || 0) > 0;
  const hasFurnace = utilSet.has("furnace") || (counts.furnace || 0) > 0;
  const hasBed = utilSet.has("bed") || countByNamePrefix(counts, "_bed") > 0;

  const woodTotal =
    countByNamePrefix(counts, "_log") +
    countByNamePrefix(counts, "_planks") +
    (counts.stick || 0);

  const stoneTotal =
    (counts.cobblestone || 0) +
    (counts.stone || 0) +
    (counts.stone_bricks || 0) +
    (counts.deepslate || 0) +
    (counts.cobbled_deepslate || 0);

  const fuelTotal = (counts.coal || 0) + (counts.charcoal || 0);
  const oreTotal = (counts.iron_ore || 0) + (counts.raw_iron || 0);
  const foodTotal = cropItemCount(counts) + (counts.bread || 0);
  const seedTotal = seedItemCount(counts);

  const hasWoodTool = hasAnyTool(counts, [
    "wooden_axe",
    "stone_axe",
    "iron_axe",
    "golden_axe",
    "diamond_axe",
    "netherite_axe",
  ]);

  const hasPickaxe = hasAnyTool(counts, [
    "wooden_pickaxe",
    "stone_pickaxe",
    "iron_pickaxe",
    "golden_pickaxe",
    "diamond_pickaxe",
    "netherite_pickaxe",
  ]);

  if (hasBase && !hasStorage) gaps.push("Has a base/shelter but lacks storage. Prefer adding chest/storage before making another base.");
  if (hasBase && !hasCrafting) gaps.push("Has a base/shelter but lacks a crafting table nearby. Prefer adding crafting utility.");
  if (hasBase && !hasFurnace && (oreTotal > 0 || fuelTotal > 0)) {
    gaps.push("Has a base and some smelting inputs but lacks furnace utility. Prefer adding furnace or smelting.");
  }
  if (hasBase && !hasBed) gaps.push("Has a base/shelter but no known bed. Prefer adding a bed instead of building a new base.");
  if (hasKnownFarm && foodTotal < 10) gaps.push("Has a farm but food stores seem low. Prefer harvest/replant or gather food.");
  if (hasKnownFarm && seedTotal < 3) gaps.push("Has a farm but seed supply is low. Prefer harvesting grass/wheat and replanting carefully.");
  if (!hasKnownFarm && hasBase && foodTotal < 8) gaps.push("Has a base but no known farm and food seems low. A small farm is reasonable if seeds/crops are available.");
  if (woodTotal < 12) gaps.push("Wood supply looks low. Prefer gathering wood before any large structure expansion.");
  if (stoneTotal < 24 && !hasBase) gaps.push("Building materials are limited for a strong shelter. Prefer mining stone/cobblestone before a fort.");
  if (fuelTotal <= 1 && (oreTotal > 0 || hasFurnace)) gaps.push("Fuel is low for smelting. Prefer mining coal or making charcoal.");
  if (!hasWoodTool) gaps.push("No axe detected. Prefer crafting tools before major wood gathering or construction.");
  if (!hasPickaxe) gaps.push("No pickaxe detected. Prefer crafting tools before mining stone/ore.");

  if (hasBase && hasKnownFarm && hasStorage && hasCrafting && hasFurnace && hasBed) {
    gaps.push("Core infrastructure already exists. Prefer productive next steps like harvesting, mining, smelting, stockpiling, exploration, or improving utilities instead of rebuilding basics.");
  }

  return gaps.slice(0, 8);
}

function buildMenuPrompt({ bot, humanMessage }) {
  const pos = bot.entity?.position;
  const isNight = bot.time?.isNight ?? false;
  const invSummary = summarizeInventory(bot);
  const worldSummary = getWorldSummary(bot);
  const resourceGaps = buildResourceGapAnalysis(bot);

  const menu = [
    `Return ONLY valid JSON. No extra text.`,
    `You control Minecraft bot "${bot.username}".`,
    ``,
    `You must produce a realistic, helpful response and a plan.`,
    `If a human asked you to do something specific, DO NOT ignore it.`,
    ``,
    `LONG-TERM WORLD CONTEXT RULES:`,
    `- Treat the persistent world summary and resource gap analysis below as source-of-truth for what you have already built or established.`,
    `- Do NOT keep proposing new bases/forts/houses if you already have a usable base unless a human explicitly asked for another one or the current one clearly lacks key utilities.`,
    `- If you already have a farm, prefer harvesting, replanting, mining, gathering, smelting, stockpiling, or improving utilities instead of making another farm.`,
    `- Prefer rational next steps based on current shortages and infrastructure gaps.`,
    `- The plan should reflect the bot's persona, but still be practical and efficient.`,
    ``,
    `IMPORTANT BUILD RULES (to ensure recognizable structures):`,
    `- A FORT must be simple and intentional: foundation, floor, doorway, full walls, and a roofline/battlements.`,
    `- A FORT must be at least size=9 and height=4 (walls). Prefer size=9 or 11.`,
    `- A HOUSE/HUT should be compact and realistic: floor, walls, doorway, windows, roof.`,
    `- Monuments must be at least height=9 (prefer 11–13).`,
    `- Use one consistent primary material (prefer cobblestone/stone_bricks for forts, planks/cobblestone for huts).`,
    `- Do NOT claim to build a fort/house/monument by placing only a few blocks.`,
    `- If asked for shelter or a base, you may include interior utilities: bed, storage, crafting table, furnace.`,
    ``,
    `Allowed actions (choose 1–3 steps total):`,
    `- SAY: {"type":"SAY","text":"..." }`,
    `- WANDER: {"type":"WANDER"}`,
    `- FOLLOW: {"type":"FOLLOW","player":"ExactPlayerName"}`,
    `- GOTO: {"type":"GOTO","x":0,"y":64,"z":0}`,
    `- RETURN_BASE: {"type":"RETURN_BASE"}`,
    `- GATHER_WOOD: {"type":"GATHER_WOOD","count":8}`,
    `- MINE_BLOCKS: {"type":"MINE_BLOCKS","targets":["coal_ore","iron_ore","stone"],"count":10}`,
    `- FARM: {"type":"FARM","crops":["wheat","carrots","potatoes"],"max":12,"size":5}`,
    `- FARM_HARVEST_REPLANT: {"type":"FARM_HARVEST_REPLANT","crops":["wheat","carrots","potatoes"],"max":12}`,
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT","size":9,"height":4,"material":"cobblestone"}`,
    `- BUILD_STRUCTURE with utilities: {"type":"BUILD_STRUCTURE","kind":"FORT","size":9,"height":4,"material":"cobblestone","includeBed":true,"includeStorage":true,"includeCrafting":true,"includeFurnace":true}`,
    `- BUILD_STRUCTURE house/hut: {"type":"BUILD_STRUCTURE","kind":"HOUSE","size":7,"height":3,"material":"oak_planks","includeBed":true,"includeStorage":true,"includeCrafting":true}`,
    `- BUILD_MONUMENT: {"type":"BUILD_MONUMENT","height":11,"material":"stone_bricks"}`,
    `- BUILD_MONUMENT_COMPLEX: {"type":"BUILD_MONUMENT_COMPLEX","kind":"OBELISK","height":13,"material":"stone_bricks"}`,
    `- CRAFT_TOOLS: {"type":"CRAFT_TOOLS"}`,
    `- SMELT_ORE: {"type":"SMELT_ORE"}`,
    `- FIGHT_MOBS: {"type":"FIGHT_MOBS","seconds":20}`,
    ``,
    `Output schema (MUST follow exactly):`,
    `{"intent":"one short sentence", "say":"one short message", "plan":[ ...actions ]}`,
  ];

  if (pos) {
    menu.push(
      `State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`
    );
  }

  if (invSummary) menu.push(`Inventory(top): ${invSummary}`);

  if (worldSummary.length) {
    menu.push("", "Persistent world summary (important):");
    for (const line of worldSummary) menu.push(`- ${line}`);
  }

  if (resourceGaps.length) {
    menu.push("", "Resource / infrastructure gap analysis (important):");
    for (const line of resourceGaps) menu.push(`- ${line}`);
  }

  const fails = recentFailuresFor(bot.username, 20 * 60 * 1000, 5);
  if (fails.length) {
    menu.push("", "Recent failures (avoid repeating mistakes):");
    for (const f of fails) {
      const d = f.data && typeof f.data === "object" ? f.data : null;
      const stepType = d?.type ? ` type=${d.type}` : "";
      const reason = d?.reason ? ` reason=${String(d.reason).slice(0, 120)}` : "";
      menu.push(`- ${new Date(f.ts).toLocaleTimeString()}${stepType}${reason}`);
    }
  }

  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (optional context):");
    for (const e of ev) {
      const kind = e.kind && e.kind !== "chat" ? ` (${e.kind})` : "";
      menu.push(`- ${e.from}${kind}: ${e.text}`);
    }
  }

  const dms = drainMessages(bot.username, 8);
  if (dms.length) {
    menu.push("", "Direct messages to you (reply helpfully):");
    for (const m of dms) menu.push(`- From ${m.from}: ${m.text}`);
  }

  if (humanMessage) menu.push("", `Human said: "${humanMessage}"`);

  return menu.join("\n");
}

module.exports = { buildMenuPrompt };
