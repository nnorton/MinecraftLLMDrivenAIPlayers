// src/planner.js
require("dotenv").config();

const { recentEvents, recentFailuresFor } = require("./team_bus");
const { drainMessages } = require("./inbox");
const { logPlan } = require("./llm_logger");
const { pickNextTask } = require("./task_picker");

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "1000", 10);

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
function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 240);
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
function inventoryCounts(bot) {
  const inv = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of inv) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return counts;
}
function hasAnyTool(counts, names) {
  for (const n of names) if ((counts[n] || 0) > 0) return true;
  return false;
}
function extractText(resp) {
  const t1 = (resp?.output_text || "").trim();
  if (t1) return t1;

  const outs = resp?.output || [];
  const chunks = [];
  for (const o of outs) {
    const content = o?.content || [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) chunks.push(c.text.trim());
      if (typeof c?.content === "string" && c.content.trim()) chunks.push(c.content.trim());
      if (typeof c?.output_text === "string" && c.output_text.trim()) chunks.push(c.output_text.trim());
    }
  }
  return chunks.join("\n").trim();
}

function ensurePlanNonEmpty(bot, plan) {
  if (Array.isArray(plan) && plan.length > 0) return plan.slice(0, 3);
  const picked = pickNextTask(bot);
  if (picked && picked.type) return [picked];
  return [{ type: "WANDER" }];
}

function chooseHelpfulPlanNonLLM({ bot, humanMessage }) {
  const msg = String(humanMessage || "").toLowerCase();
  const counts = inventoryCounts(bot);
  const hasPick = hasAnyTool(counts, ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"]);
  const hasAxe = hasAnyTool(counts, ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe"]);

  if (msg.includes("fort") || msg.includes("wall") || msg.includes("defense") || msg.includes("build")) {
    // If we don't have good materials, mine first
    if (!hasPick) {
      return [
        { type: "SAY", text: "I’ll craft tools, then mine stone to build a real fort." },
        { type: "CRAFT_TOOLS" },
        { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 24 },
      ];
    }
    return [
      { type: "SAY", text: "Building a recognizable fort (9x9, 4-high walls) using a consistent material." },
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
    { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12 },
    { type: "SMELT_ORE" },
  ];
}

async function planActions({ systemPrompt, bot, humanMessage, trigger = "autonomy" }) {
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
    `- A FORT must be at least size=9 and height=4 (walls). Prefer size=9 or 11.`,
    `- Monuments must be at least height=9 (prefer 11–13).`,
    `- Use one consistent material (prefer cobblestone/stone_bricks/smooth_stone).`,
    `- Do NOT claim to build a fort/monument by placing only a few blocks.`,
    ``,
    `Allowed actions (choose 1–3 steps total):`,
    `- SAY: {"type":"SAY","text":"..." }`,
    `- WANDER: {"type":"WANDER"}`,
    `- FOLLOW: {"type":"FOLLOW","player":"ExactPlayerName"}`,
    `- GOTO: {"type":"GOTO","x":0,"y":64,"z":0}`,
    `- RETURN_BASE: {"type":"RETURN_BASE"}`,
    `- GATHER_WOOD: {"type":"GATHER_WOOD","count":8}`,
    `- MINE_BLOCKS: {"type":"MINE_BLOCKS","targets":["coal_ore","iron_ore","stone"],"count":10}`,
    `- FARM_HARVEST_REPLANT: {"type":"FARM_HARVEST_REPLANT","crops":["wheat","carrots","potatoes"],"max":12}`,
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT","size":9,"height":4,"material":"cobblestone"}`,
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

  const systemStr = String(systemPrompt || "").trim();
  const menuStr = menu.join("\n");

  // If OpenAI client can't initialize, fallback immediately (never idle)
  let client;
  try {
    client = await getClient();
  } catch (err) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `client_init_failed:${shortErr(err)}` });
    return {
      say: humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  async function doCall(extraNudge) {
    return client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: systemStr },
        { role: "user", content: extraNudge ? `${menuStr}\n\n${extraNudge}` : menuStr },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
  }

  let text = "";
  try {
    const resp1 = await doCall(null);
    text = extractText(resp1);

    if (!text) {
      const resp2 = await doCall(
        "IMPORTANT: Your last response was empty. Return VALID JSON matching the schema now."
      );
      text = extractText(resp2);
    }

    if (!text) {
      const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
      logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: "empty_llm_response" });
      return {
        say: humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry.") : "",
        plan: ensurePlanNonEmpty(bot, nonLLMPlan),
      };
    }
  } catch (err) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `llm_call_error:${shortErr(err)}` });
    return {
      say: humanMessage ? clampChat("I hit a thinking error—continuing useful tasks while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `parse_error:${shortErr(err)}` });
    return {
      say: humanMessage ? clampChat("I couldn’t parse my own response—continuing helpful work while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  const say = obj?.say ? clampChat(obj.say) : (humanMessage ? "Okay — I’ll work on that." : "");
  const plan = ensurePlanNonEmpty(bot, Array.isArray(obj?.plan) ? obj.plan : null);

  // Enforce: never return SAY-only (must do something useful)
  const nonSay = plan.filter((p) => String(p?.type || "").toUpperCase() !== "SAY");
  if (nonSay.length === 0) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    return { say, plan: ensurePlanNonEmpty(bot, nonLLMPlan) };
  }

  return { say, plan };
}

module.exports = { planActions };
