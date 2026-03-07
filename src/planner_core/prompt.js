// src/planner_core/prompt.js

const { recentEvents, recentFailuresFor } = require("../team_bus");
const { drainMessages } = require("../inbox");
const { summarizeInventory } = require("./utils");

function buildMenuPrompt({ bot, humanMessage }) {
  const pos = bot.entity?.position;
  const isNight = bot.time?.isNight ?? false;
  const invSummary = summarizeInventory(bot);

  const menu = [
    `Return ONLY valid JSON. No extra text.`,
    `You control Minecraft bot "${bot.username}".`,
    ``,
    `You must produce a realistic, helpful response and a plan.`,
    `If a human asked you to do something specific, DO NOT ignore it.`,
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
