// src/planner.js
require("dotenv").config();
const { recentEvents } = require("./team_bus");
const { logPlan } = require("./llm_logger");

const MODEL = "gpt-5-mini";
const MAX_OUTPUT_TOKENS = 420;

// Cache the OpenAI client (loaded via dynamic import so CJS can use ESM deps)
let _client = null;
async function getClient() {
  if (_client) return _client;
  const mod = await import("openai"); // <-- ESM-safe from CommonJS
  const OpenAI = mod.default || mod.OpenAI || mod;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

/**
 * Returns: { say: string, plan: Array<Action> }
 * Adds JSONL logging of raw LLM output + parse errors + normalized plan.
 */
async function planActions({ systemPrompt, bot, humanMessage, trigger = "autonomy" }) {
  const client = await getClient();

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
    `- Prefer safe behavior at night: return to base, build defenses, or brief wander.`,
    `- Keep "say" brief and in-character.`,
  ];

  if (pos) {
    menu.push(
      `State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`
    );
  }

  // Team influence context
  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (incorporate if useful):");
    for (const e of ev) menu.push(`- ${e.from}: ${e.text}`);
  }

  if (humanMessage) menu.push("", `Human said: "${humanMessage}"`);

  const systemStr = String(systemPrompt || "").trim();
  const menuStr = menu.join("\n");

  let resp;
  let text = "";

  try {
    resp = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: systemStr },
        { role: "user", content: menuStr }
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS
    });

    text = (resp.output_text || "").trim();

    logPlan({
      bot: bot.username,
      trigger,
      model: MODEL,
      output_text: text,
      usage: resp.usage || null,
      request: {
        system: systemStr.slice(0, 2000),
        user: humanMessage ? String(humanMessage).slice(0, 500) : null,
        menu: menuStr.slice(0, 4000),
      }
    });
  } catch (err) {
    logPlan({
      bot: bot.username,
      trigger,
      model: MODEL,
      request_error: String(err?.message || err),
      request: {
        system: systemStr.slice(0, 2000),
        user: humanMessage ? String(humanMessage).slice(0, 500) : null,
        menu: menuStr.slice(0, 4000),
      }
    });
    throw err;
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    logPlan({
      bot: bot.username,
      trigger,
      model: MODEL,
      parse_error: String(err?.message || err),
      output_text: text
    });
    return { say: "", plan: [{ type: "WANDER" }] };
  }

  const say = obj?.say ? clampChat(obj.say) : "";
  const plan = Array.isArray(obj?.plan) ? obj.plan.slice(0, 3) : [{ type: "WANDER" }];

  logPlan({
    bot: bot.username,
    trigger,
    normalized: { say, plan }
  });

  return { say, plan };
}

module.exports = { planActions };
