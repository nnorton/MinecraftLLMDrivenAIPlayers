// src/planner.js
require("dotenv").config();
const { recentEvents } = require("./team_bus");
const { logPlan } = require("./llm_logger");

const MODEL = "gpt-5-mini";
const MAX_OUTPUT_TOKENS = 520;

// Cache OpenAI client via dynamic import so CommonJS can load ESM SDK
let _client = null;
async function getClient() {
  if (_client) return _client;
  const mod = await import("openai");
  const OpenAI = mod.default || mod.OpenAI || mod;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function summarizeInventory(bot, limit = 12) {
  const inv = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of inv) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}x${count}`)
    .join(", ");
}

/**
 * Returns: { say: string, plan: Array<Action> }
 * Stronger constraints to prevent random actions:
 * - Requires "say" + "intent"
 * - "say" must paraphrase human request
 * - First action must align with intent
 * - If request not possible, ask a clarifying question and wander/return base
 */
async function planActions({ systemPrompt, bot, humanMessage, trigger = "autonomy" }) {
  const client = await getClient();

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
    `Allowed actions (choose 1–3 steps total):`,
    `- SAY: {"type":"SAY","text":"..." }  // short in-character chat`,
    `- WANDER: {"type":"WANDER"}  // roam nearby aimlessly`,
    `- FOLLOW: {"type":"FOLLOW","player":"ExactPlayerName"}  // follow a player`,
    `- GOTO: {"type":"GOTO","x":0,"y":64,"z":0}  // walk to coordinates`,
    `- RETURN_BASE: {"type":"RETURN_BASE"}  // go to saved base location`,
    `- GATHER_WOOD: {"type":"GATHER_WOOD","count":8}  // collect nearby logs`,
    `- MINE_BLOCKS: {"type":"MINE_BLOCKS","targets":["coal_ore","iron_ore","stone"],"count":10}  // mine nearby targets`,
    `- FARM_HARVEST_REPLANT: {"type":"FARM_HARVEST_REPLANT","crops":["wheat","carrots","potatoes"],"max":12}  // harvest+replant nearby crops`,
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT"|"WALL"|"TOWER"}  // build small starter defenses near you (no breaking blocks)`,
    `- BUILD_MONUMENT: {"type":"BUILD_MONUMENT"}  // build simple decorative monument (no breaking blocks)`,
    `- BUILD_MONUMENT_COMPLEX: {"type":"BUILD_MONUMENT_COMPLEX","kind":"OBELISK"|"ARCH"|"SPIRAL_TOWER"|"SHRINE"}  // build larger decorative monument (no breaking blocks)`,
    `- CRAFT_TOOLS: {"type":"CRAFT_TOOLS"}  // craft basic tools if materials exist`,
    `- SMELT_ORE: {"type":"SMELT_ORE"}  // smelt iron ore if furnace+fuel exist`,
    `- FIGHT_MOBS: {"type":"FIGHT_MOBS","seconds":20}  // fight nearby hostiles briefly; stop if unsafe`,
    ``,
    `Output schema (MUST follow exactly):`,
    `{"intent":"one short sentence about what the human wants", "say":"one short in-character message to the human", "plan":[ ...actions ]}`,
    ``,
    `Say requirements (IMPORTANT):`,
    `- You MUST include "say" every time.`,
    `- If this was a human request, "say" MUST paraphrase the request in 1 sentence, then briefly confirm what you’ll do.`,
    `- If you cannot satisfy the request with the allowed actions, ask a clarifying question in "say" and set plan=[{"type":"WANDER"}] or [{"type":"RETURN_BASE"}].`,
    ``,
    `Planning requirements (IMPORTANT):`,
    `- The FIRST action in the plan MUST directly help accomplish the "intent".`,
    `- Do not choose random actions unrelated to the human request.`,
    `- Choose only 1–3 steps total.`,
    ``,
    `Safety & behavior:`,
    `- Never grief: do NOT break or destroy player-built structures or steal items.`,
    `- Avoid harassment or threats.`,
    `- If it's night and you’re low on food/health, prefer safety (RETURN_BASE / BUILD_STRUCTURE / brief safe tasks).`,
  ];

  if (pos) {
    menu.push(
      `State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`
    );
  }
  if (invSummary) menu.push(`Inventory(top): ${invSummary}`);

  // Team context (doesn't trigger immediate replans, just informs next plan)
  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (optional context):");
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

  // Parse JSON
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

  // Log intent separately (helps debug “random behavior”)
  logPlan({
    bot: bot.username,
    trigger,
    intent: obj?.intent || null
  });

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
