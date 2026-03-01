// src/planner.js
require("dotenv").config();
const OpenAI = require("openai");
const { recentEvents } = require("./team_bus");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "gpt-5-mini";
const MAX_OUTPUT_TOKENS = 420;

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

/**
 * Returns: { say: string, plan: Array<Action> }
 * Action is a JSON object with a "type" field matching the allowed actions.
 */
async function planActions({ systemPrompt, bot, humanMessage }) {
  const pos = bot.entity?.position;
  const isNight = bot.time?.isNight ?? false;

  const menu = [
    `Return ONLY valid JSON. No extra text.`,
    `You control Minecraft bot "${bot.username}".`,
    ``,
    `Choose a short plan of 1–3 steps using ONLY these actions:`,
    `- SAY: {"type":"SAY","text":"..."}`,
    `- WANDER: {"type":"WANDER"}`,
    `- FOLLOW: {"type":"FOLLOW","player":"ExactPlayerName"}`,
    `- GOTO: {"type":"GOTO","x":0,"y":64,"z":0}`,
    `- RETURN_BASE: {"type":"RETURN_BASE"}`,
    `- GATHER_WOOD: {"type":"GATHER_WOOD","count":8}`,
    `- MINE_BLOCKS: {"type":"MINE_BLOCKS","targets":["coal_ore","iron_ore","stone"],"count":10}`,
    `- FARM_HARVEST_REPLANT: {"type":"FARM_HARVEST_REPLANT","crops":["wheat","carrots","potatoes"],"max":12}`,
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT"|"WALL"|"TOWER"}`,
    `- BUILD_MONUMENT: {"type":"BUILD_MONUMENT"}`,
    `- BUILD_MONUMENT_COMPLEX: {"type":"BUILD_MONUMENT_COMPLEX","kind":"OBELISK"|"ARCH"|"SPIRAL_TOWER"|"SHRINE"}`,
    `- CRAFT_TOOLS: {"type":"CRAFT_TOOLS"}`,
    `- SMELT_ORE: {"type":"SMELT_ORE"}`,
    `- FIGHT_MOBS: {"type":"FIGHT_MOBS","seconds":20}`,
    ``,
    `Output schema: {"say":"optional short chat", "plan":[ ...actions ]}`,
    ``,
    `Rules:`,
    `- Never grief: do NOT break or destroy player-built structures or steal items.`,
    `- Avoid harm: no explicit violence threats or harassment.`,
    `- Prefer safe behavior at night: return to base, build defenses, light areas, or brief wander.`,
    `- Keep "say" brief and in-character.`,
  ];

  if (pos) menu.push(`State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`);

  // ✅ Bot-to-bot influence: include recent team updates (last ~10 minutes)
  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (incorporate them if useful):");
    for (const e of ev) {
      menu.push(`- ${e.from}: ${e.text}`);
    }
  }

  if (humanMessage) menu.push("", `Human said: "${humanMessage}"`);

  const resp = await client.responses.create({
    model: MODEL,
    input: [
      { role: "system", content: String(systemPrompt || "").trim() },
      { role: "user", content: menu.join("\n") }
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS
  });

  const text = (resp.output_text || "").trim();

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { say: "", plan: [{ type: "WANDER" }] };
  }

  const say = obj?.say ? clampChat(obj.say) : "";
  const plan = Array.isArray(obj?.plan) ? obj.plan.slice(0, 3) : [{ type: "WANDER" }];

  return { say, plan };
}

module.exports = { planActions };
