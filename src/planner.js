// src/planner.js
require("dotenv").config();
const { recentEvents } = require("./team_bus");
const { drainMessages } = require("./inbox");
const { logPlan } = require("./llm_logger");

const MODEL = "gpt-5-mini";
const MAX_OUTPUT_TOKENS = 560;

// Cache OpenAI client via dynamic import (CJS compatible with ESM SDK)
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
    `If another bot DM'd you, reply helpfully (use SAY "@Name ...").`,
    ``,
    `Allowed actions (choose 1–3 steps total):`,
    `- SAY: {"type":"SAY","text":"..." }  // short chat; to reply to a DM, begin with "@Name "`,
    `- WANDER: {"type":"WANDER"}  // roam nearby`,
    `- FOLLOW: {"type":"FOLLOW","player":"ExactPlayerName"}  // follow a player`,
    `- GOTO: {"type":"GOTO","x":0,"y":64,"z":0}  // walk to coordinates`,
    `- RETURN_BASE: {"type":"RETURN_BASE"}  // go to saved base`,
    `- GATHER_WOOD: {"type":"GATHER_WOOD","count":8}  // collect nearby logs`,
    `- MINE_BLOCKS: {"type":"MINE_BLOCKS","targets":["coal_ore","iron_ore","stone"],"count":10}  // mine nearby targets`,
    `- FARM_HARVEST_REPLANT: {"type":"FARM_HARVEST_REPLANT","crops":["wheat","carrots","potatoes"],"max":12}  // harvest+replant nearby crops`,
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT"|"WALL"|"TOWER"}  // build small defenses (no breaking blocks)`,
    `- BUILD_MONUMENT: {"type":"BUILD_MONUMENT"}  // simple decorative monument (no breaking blocks)`,
    `- BUILD_MONUMENT_COMPLEX: {"type":"BUILD_MONUMENT_COMPLEX","kind":"OBELISK"|"ARCH"|"SPIRAL_TOWER"|"SHRINE"}  // larger decorative monument (no breaking blocks)`,
    `- CRAFT_TOOLS: {"type":"CRAFT_TOOLS"}  // craft basic tools`,
    `- SMELT_ORE: {"type":"SMELT_ORE"}  // smelt ore if possible`,
    `- FIGHT_MOBS: {"type":"FIGHT_MOBS","seconds":20}  // fight nearby hostiles briefly; stop if unsafe`,
    ``,
    `Output schema (MUST follow exactly):`,
    `{"intent":"one short sentence about what the latest request/message wants", "say":"one short in-character message", "plan":[ ...actions ]}`,
    ``,
    `Say requirements:`,
    `- You MUST include "say" every time.`,
    `- If humanMessage exists, "say" MUST paraphrase it and confirm what you’ll do.`,
    `- If bot DMs exist, "say" should reply (start with "@SenderName ...").`,
    `- If you cannot satisfy a request with allowed actions, ask a clarifying question in "say" and set plan=[{"type":"WANDER"}] or [{"type":"RETURN_BASE"}].`,
    ``,
    `Planning requirements:`,
    `- The FIRST action in plan MUST directly help accomplish the intent.`,
    `- Do not choose random actions unrelated to the latest request/message.`,
    `- Choose only 1–3 steps total.`,
    ``,
    `Safety & behavior:`,
    `- Never grief: do NOT break/destroy player builds or steal items.`,
    `- Avoid harassment or threats.`,
    `- At night, prefer safer actions if low health/food.`,
  ];

  if (pos) {
    menu.push(
      `State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`
    );
  }
  if (invSummary) menu.push(`Inventory(top): ${invSummary}`);

  // TEAM updates (shared context)
  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (optional context):");
    for (const e of ev) menu.push(`- ${e.from}: ${e.text}`);
  }

  // ✅ Direct messages (per-bot inbox)
  const dms = drainMessages(bot.username, 8);
  if (dms.length) {
    menu.push("", "Direct messages to you (reply helpfully):");
    for (const m of dms) menu.push(`- From ${m.from}: ${m.text}`);
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

  logPlan({ bot: bot.username, trigger, intent: obj?.intent || null });

  const say = obj?.say ? clampChat(obj.say) : "";
  const plan = Array.isArray(obj?.plan) ? obj.plan.slice(0, 3) : [{ type: "WANDER" }];

  logPlan({ bot: bot.username, trigger, normalized: { say, plan } });

  return { say, plan };
}

module.exports = { planActions };
