// src/planner.js
require("dotenv").config();

const { recentEvents, recentFailuresFor } = require("./team_bus");
const { drainMessages } = require("./inbox");
const { logPlan } = require("./llm_logger");
const { pickNextTask } = require("./task_picker");

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "1000", 10);

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

/**
 * Ensure we ALWAYS return a plan with at least one action.
 * If caller passes nonsense, this will correct it.
 */
function ensurePlanNonEmpty(bot, plan) {
  if (Array.isArray(plan) && plan.length > 0) return plan.slice(0, 3);

  // Prefer a helpful task_picker task; if it fails, WANDER as last resort
  const picked = pickNextTask(bot);
  if (picked && picked.type) return [picked];

  return [{ type: "WANDER" }];
}

/**
 * Non-LLM "helpful plan" chooser.
 * 1) If human asked something recognizable, do that.
 * 2) Else, choose a productive plan based on inventory + basic needs.
 * 3) Always returns 1–3 steps.
 */
function chooseHelpfulPlanNonLLM({ bot, humanMessage }) {
  const msg = String(humanMessage || "").toLowerCase();
  const counts = inventoryCounts(bot);

  const hasPick = hasAnyTool(counts, ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"]);
  const hasAxe = hasAnyTool(counts, ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe"]);
  const hasFood = Object.keys(counts).some((k) => k.includes("bread") || k.includes("cooked") || k.includes("apple"));

  // --- Rule-based parsing for common human intents ---
  if (msg) {
    if (msg.includes("follow") || msg.includes("come to me") || msg.includes("come here")) {
      // We don't know exact player name from text; best effort: ask them to stand still while we follow
      return [
        { type: "SAY", text: "On my way. If you want me to follow, please tell me your exact username." },
        { type: "WANDER" },
      ];
    }

    if (msg.includes("go to") || msg.includes("coords") || msg.match(/\b-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\b/)) {
      // Extract first three integers if present
      const nums = msg.match(/-?\d+/g);
      if (nums && nums.length >= 3) {
        const x = parseInt(nums[0], 10);
        const y = parseInt(nums[1], 10);
        const z = parseInt(nums[2], 10);
        return [
          { type: "SAY", text: `Heading to ${x}, ${y}, ${z}.` },
          { type: "GOTO", x, y, z },
        ];
      }
      return [
        { type: "SAY", text: "I can go to coordinates—please share them like: x y z." },
        { type: "WANDER" },
      ];
    }

    if (msg.includes("base") || msg.includes("home") || msg.includes("return")) {
      return [
        { type: "SAY", text: "Returning to base." },
        { type: "RETURN_BASE" },
      ];
    }

    if (msg.includes("wood") || msg.includes("logs") || msg.includes("tree")) {
      return [
        { type: "SAY", text: "Got it—gathering wood." },
        { type: "GATHER_WOOD", count: 12 },
        { type: "CRAFT_TOOLS" },
      ];
    }

    if (msg.includes("mine") || msg.includes("iron") || msg.includes("coal") || msg.includes("stone")) {
      // If no pickaxe, craft first
      if (!hasPick) {
        return [
          { type: "SAY", text: "I’ll craft tools first, then mine for resources." },
          { type: "CRAFT_TOOLS" },
          { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12 },
        ];
      }
      return [
        { type: "SAY", text: "Mining for resources (coal/iron/stone)." },
        { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12 },
        { type: "SMELT_ORE" },
      ];
    }

    if (msg.includes("farm") || msg.includes("wheat") || msg.includes("carrot") || msg.includes("potato")) {
      return [
        { type: "SAY", text: "Working the nearby farm—harvest and replant." },
        { type: "FARM_HARVEST_REPLANT", crops: ["wheat", "carrots", "potatoes"], max: 12 },
      ];
    }

    if (msg.includes("build") || msg.includes("wall") || msg.includes("fort") || msg.includes("defense")) {
      return [
        { type: "SAY", text: "Building small defenses near our area." },
        { type: "BUILD_STRUCTURE", kind: "FORT" },
      ];
    }

    if (msg.includes("fight") || msg.includes("mobs") || msg.includes("zombie") || msg.includes("skeleton")) {
      return [
        { type: "SAY", text: "Engaging nearby hostiles briefly (staying safe)." },
        { type: "FIGHT_MOBS", seconds: 20 },
      ];
    }
  }

  // --- No human intent: choose productivity based on state ---
  // If starving / low health-ish, prefer safety + food gathering behaviors.
  // (We don't have a strong food action here, so we craft/tools/mine/return base to regroup.)
  if (bot.food != null && bot.food <= 8 && !hasFood) {
    return [
      { type: "SAY", text: "I’m low on food—regrouping and focusing on safe resource collection." },
      { type: "RETURN_BASE" },
      { type: "GATHER_WOOD", count: 8 },
    ];
  }

  // If lacking tools, craft first
  if (!hasPick || !hasAxe) {
    return [
      { type: "SAY", text: "Crafting tools and collecting starter resources." },
      { type: "CRAFT_TOOLS" },
      { type: "GATHER_WOOD", count: 10 },
    ];
  }

  // Otherwise: mine + smelt is generally high-value
  return [
    { type: "SAY", text: "Continuing useful work: mining and processing resources." },
    { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12 },
    { type: "SMELT_ORE" },
  ];
}

/**
 * Returns: { say: string, plan: Array }
 * GUARANTEE: plan is always non-empty and “helpful enough” (never idle).
 */
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
    `If another bot DM'd you, reply helpfully (use SAY "@Name ...").`,
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
    `- BUILD_STRUCTURE: {"type":"BUILD_STRUCTURE","kind":"FORT"|"WALL"|"TOWER"}`,
    `- BUILD_MONUMENT: {"type":"BUILD_MONUMENT"}`,
    `- BUILD_MONUMENT_COMPLEX: {"type":"BUILD_MONUMENT_COMPLEX","kind":"OBELISK"|"ARCH"|"SPIRAL_TOWER"|"SHRINE"}`,
    `- CRAFT_TOOLS: {"type":"CRAFT_TOOLS"}`,
    `- SMELT_ORE: {"type":"SMELT_ORE"}`,
    `- FIGHT_MOBS: {"type":"FIGHT_MOBS","seconds":20}`,
    ``,
    `Output schema (MUST follow exactly):`,
    `{"intent":"...", "say":"...", "plan":[ ...actions ]}`,
  ];

  if (pos) {
    menu.push(
      `State: pos=${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} health=${bot.health} food=${bot.food} night=${isNight}`
    );
  }
  if (invSummary) menu.push(`Inventory(top): ${invSummary}`);

  // Recent failures for THIS bot
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

  // Team events
  const ev = recentEvents(10 * 60 * 1000, 12);
  if (ev.length) {
    menu.push("", "Recent TEAM updates (optional context):");
    for (const e of ev) {
      const kind = e.kind && e.kind !== "chat" ? ` (${e.kind})` : "";
      menu.push(`- ${e.from}${kind}: ${e.text}`);
    }
  }

  // Bot DM inbox
  const dms = drainMessages(bot.username, 8);
  if (dms.length) {
    menu.push("", "Direct messages to you (reply helpfully):");
    for (const m of dms) menu.push(`- From ${m.from}: ${m.text}`);
  }

  if (humanMessage) menu.push("", `Human said: "${humanMessage}"`);

  const systemStr = String(systemPrompt || "").trim();
  const menuStr = menu.join("\n");

  // If OpenAI client can't initialize, fallback immediately.
  let client;
  try {
    client = await getClient();
  } catch (err) {
    const nonLLM = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `client_init_failed:${shortErr(err)}` });
    return { say: nonLLM[0]?.type === "SAY" ? clampChat(nonLLM[0].text) : "", plan: ensurePlanNonEmpty(bot, nonLLM) };
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

  const t0 = Date.now();
  let text = "";

  try {
    console.log(
      `[planner] request bot=${bot.username} trigger=${trigger} model=${MODEL} human=${humanMessage ? "1" : "0"}`
    );

    const resp1 = await doCall(null);
    text = extractText(resp1);

    const dt = Date.now() - t0;
    const rid = resp1?.id || resp1?.response_id || resp1?.request_id || null;
    console.log(
      `[planner] response bot=${bot.username} trigger=${trigger} ms=${dt} id=${rid || "n/a"} outLen=${text ? text.length : 0}`
    );

    logPlan({
      bot: bot.username,
      trigger,
      model: MODEL,
      output_text: text,
      usage: resp1?.usage || null,
    });

    // Retry once if empty
    if (!text) {
      const resp2 = await doCall(
        "IMPORTANT: Your last response was empty. Return VALID JSON matching the schema now."
      );
      const text2 = extractText(resp2);
      logPlan({ bot: bot.username, trigger, model: MODEL, retry_output_text: text2, usage: resp2?.usage || null });
      text = text2;
    }

    // If still empty -> non-LLM plan (helpful, never idle)
    if (!text) {
      const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
      logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: "empty_llm_response" });
      const plan = ensurePlanNonEmpty(bot, nonLLMPlan);
      const say = humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry that.") : "";
      return { say, plan };
    }
  } catch (err) {
    console.error(`[planner] error bot=${bot.username} trigger=${trigger} err=${shortErr(err)}`);
    logPlan({ bot: bot.username, trigger, model: MODEL, request_error: String(err?.message || err) });

    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `llm_call_error:${shortErr(err)}` });
    const plan = ensurePlanNonEmpty(bot, nonLLMPlan);
    const say = humanMessage ? clampChat("I hit a thinking error—continuing useful tasks while you retry that request.") : "";
    return { say, plan };
  }

  // Parse JSON
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    const excerpt = String(text || "").slice(0, 320);
    console.error(
      `[planner] parse_error bot=${bot.username} trigger=${trigger} err=${shortErr(err)} excerpt=${JSON.stringify(excerpt)}`
    );
    logPlan({ bot: bot.username, trigger, model: MODEL, parse_error: String(err?.message || err), output_text: text });

    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `parse_error:${shortErr(err)}` });
    const plan = ensurePlanNonEmpty(bot, nonLLMPlan);
    const say = humanMessage ? clampChat("I couldn’t parse my own response—continuing helpful work while you retry.") : "";
    return { say, plan };
  }

  // Normalize output
  const say = obj?.say ? clampChat(obj.say) : (humanMessage ? "Okay — I’ll work on that." : "");
  const plan = ensurePlanNonEmpty(bot, Array.isArray(obj?.plan) ? obj.plan : null);

  // If model gave SAY-only or useless plan, enforce non-idle by adding a picked task
  // (still keep first 3 steps total)
  const nonSaySteps = plan.filter((p) => String(p?.type || "").toUpperCase() !== "SAY");
  if (nonSaySteps.length === 0) {
    const picked = pickNextTask(bot);
    const combined = [];
    if (say) combined.push({ type: "SAY", text: say });
    if (picked && picked.type) combined.push(picked);
    else combined.push({ type: "WANDER" });

    logPlan({ bot: bot.username, trigger, enforced_non_idle: true, combined_plan: combined });
    return { say, plan: combined.slice(0, 3) };
  }

  logPlan({ bot: bot.username, trigger, normalized: { say, plan } });
  return { say, plan };
}

module.exports = { planActions };
