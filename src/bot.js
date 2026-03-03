// src/bot.js
require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const collectBlock = require("mineflayer-collectblock").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

const { planActions } = require("./planner");
const { postEvent } = require("./team_bus");
const { pushMessage } = require("./inbox");
const { pickNextTask } = require("./task_picker");

const { goto, follow, wander, tickMovement } = require("./actions/movement");
const { getBase, setBase } = require("./actions/memory");
const { buildFort, buildMonument, buildMonumentComplex } = require("./actions/build");
const { craftTools, smeltOre } = require("./actions/craft");
const { fightMobs } = require("./actions/combat");
const gather = require("./actions/gather");

// ---- Controls ----
const AUTONOMY_INTERVAL_MS = 5 * 60 * 1000;
const TASK_TICK_MS = 1500;
const COOLDOWN_ON_HUMAN_MS = 1500;
const WANDER_RADIUS = 30;

// ✅ Memory reducer: Mineflayer chunk radius per bot
// Suggested: 2-4. Default here is 3.
const BOT_VIEW_DISTANCE = parseInt(process.env.BOT_VIEW_DISTANCE || "3", 10);

// ---- LLM on/off switch ----
// Set LLM_ENABLED=false in .env to completely disable OpenAI usage.
// When disabled, bots will only use deterministic/non-LLM task logic.
function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}
const LLM_ENABLED = parseBool(process.env.LLM_ENABLED, true);

// ---- Pathfinder tuning ----
const PATHFINDER_THINK_TIMEOUT_MS = parseInt(
  process.env.PATHFINDER_THINK_TIMEOUT_MS || "10000",
  10
);
const PATHFINDER_ERROR_RETRY_LIMIT = parseInt(
  process.env.PATHFINDER_ERROR_RETRY_LIMIT || "2",
  10
);

// ---- Plan commitment (reduce mid-task plan switching) ----
const PLAN_COMMIT_MS = parseInt(process.env.PLAN_COMMIT_MS || "60000", 10);

// ---- “Always busy” controls ----
const WANDER_MAX_MS = parseInt(process.env.WANDER_MAX_MS || "45000", 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "180000", 10);
const STUCK_NO_MOVE_MS = parseInt(process.env.STUCK_NO_MOVE_MS || "35000", 10);

// ---- Extra unstuck tuning ----
const UNSTUCK_COOLDOWN_MS = parseInt(process.env.UNSTUCK_COOLDOWN_MS || "90000", 10);
const GOAL_GRACE_MS = parseInt(process.env.GOAL_GRACE_MS || "8000", 10);
const UNSTUCK_STAGE1_MS = parseInt(process.env.UNSTUCK_STAGE1_MS || "9000", 10);

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeType(t) {
  return String(t || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function isPathfinderPlanningError(msg) {
  const m = String(msg || "");
  return /Took\s+to\s+long\s+to\s+decide\s+path\s+to\s+goal/i.test(m);
}

function isMajorStepType(type) {
  return (
    type === "GATHER_WOOD" ||
    type === "MINE_BLOCKS" ||
    type === "FARM_HARVEST_REPLANT" ||
    type === "BUILD_STRUCTURE" ||
    type === "BUILD_MONUMENT" ||
    type === "BUILD_MONUMENT_COMPLEX" ||
    type === "CRAFT_TOOLS" ||
    type === "SMELT_ORE" ||
    type === "FIGHT_MOBS"
  );
}

function invCount(bot, itemName) {
  const items = bot.inventory?.items?.() || [];
  let total = 0;
  for (const it of items) if (it.name === itemName) total += it.count || 0;
  return total;
}

function parseInsufficientMaterial(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(
    /Insufficient\s+([a-z0-9_]+):\s*have\s*(\d+),\s*need\s*at\s*least\s*(\d+)/i
  );
  if (!m) return null;
  return {
    material: m[1].toLowerCase(),
    have: parseInt(m[2], 10) || 0,
    need: parseInt(m[3], 10) || 0,
  };
}

function parseBuildIncomplete(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(
    /Build\s+incomplete:\s*completion\s*(\d+)%\s*\(placed=(\d+)\/(\d+)/i
  );
  if (!m) return null;
  return {
    completionPct: parseInt(m[1], 10) || 0,
    placed: parseInt(m[2], 10) || 0,
    total: parseInt(m[3], 10) || 0,
  };
}

function mineTargetForMaterial(material) {
  if (material === "cobblestone") return "stone";
  if (material.endsWith("_planks")) return null;
  return material;
}

function deterministicPlan(bot, humanMessage) {
  const msg = String(humanMessage || "").toLowerCase();

  if (
    msg.includes("fort") ||
    msg.includes("wall") ||
    msg.includes("defense") ||
    msg.includes("castle")
  ) {
    return [
      { type: "SAY", text: "Understood — I’ll build a proper fort and keep working until it’s done." },
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 32, radius: 48 },
      { type: "BUILD_STRUCTURE", kind: "FORT", size: 9, height: 4, material: "cobblestone" },
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
      { type: "GATHER_WOOD", count: 12 },
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

function remediateInsufficientMaterial({ bot, step, parsed }) {
  const { material, have, need } = parsed;
  const deficit = Math.max(0, need - have);

  step._resourceRetries = (step._resourceRetries || 0) + 1;
  if (step._resourceRetries > 2) {
    return {
      ok: false,
      reason: `resource_retry_exhausted:${material}`,
      newQueue: [
        { type: "SAY", text: `I keep coming up short on ${material}. Switching to other useful work for now.` },
        { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12, radius: 48 },
        { type: "SMELT_ORE" },
      ],
    };
  }

  const buffer = 24;
  const wantExtra = Math.max(16, Math.min(96, deficit + buffer));
  const mineTarget = mineTargetForMaterial(material);

  if (material.endsWith("_planks")) {
    return {
      ok: true,
      reason: `gather_wood_for_${material}`,
      newQueue: [
        { type: "SAY", text: `I’m short on ${material}. I’ll gather wood and craft planks, then continue.` },
        { type: "GATHER_WOOD", count: Math.max(6, Math.ceil(wantExtra / 4)) },
        { type: "CRAFT_TOOLS" },
        step,
      ],
    };
  }

  if (!mineTarget) {
    return {
      ok: true,
      reason: `fallback_mine_stone_for_${material}`,
      newQueue: [
        { type: "SAY", text: `I’m short on ${material}. I’ll mine more stone first.` },
        { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: wantExtra, radius: 48 },
        step,
      ],
    };
  }

  return {
    ok: true,
    reason: `mine_${mineTarget}_for_${material}`,
    newQueue: [
      { type: "SAY", text: `I’m short on ${material}. I’ll mine some more, then continue.` },
      { type: "MINE_BLOCKS", targets: [mineTarget, "coal_ore"], count: wantExtra, radius: 48 },
      step,
    ],
  };
}

function posObj(bot) {
  const p = bot.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

async function createAgent(opts) {
  const { host, port, persona, username } = opts;

  const bot = mineflayer.createBot({
    host,
    port,
    username,
    viewDistance: BOT_VIEW_DISTANCE,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(toolPlugin);

  bot._planQueue = [];
  bot._current = null;
  bot._executing = false;
  bot._planning = false;
  bot._lastAutonomyAt = 0;
  bot._lastHumanAt = 0;
  bot._commitUntil = 0;
  bot._pendingHuman = null;

  bot._lastPos = null;
  bot._lastMoveAt = Date.now();
  bot._wanderStartedAt = 0;
  bot._stepStartedAt = 0;
  bot._lastUnstuckAt = 0;
  bot._lastGoalChangeAt = 0;
  bot._unstuckStage1At = 0;

  bot._lastChatAt = 0;

  function safeChat(msg) {
    const t = Date.now();
    if (t - bot._lastChatAt < 900) return;
    bot._lastChatAt = t;
    try {
      bot.chat(String(msg || "").slice(0, 220));
    } catch {}
  }

  let reconnectAttempts = 0;
  let reconnectScheduled = false;

  function scheduleReconnect(reason) {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    reconnectAttempts++;

    const delay = clamp(1000 * reconnectAttempts, 2500, 20000);
    console.warn(`[${username}] reconnecting in ${Math.round(delay / 1000)}s (reason=${reason})`);

    setTimeout(() => {
      try {
        createAgent(opts);
      } catch (e) {
        console.error(`[${username}] reconnect spawn failed:`, e?.message || e);
        reconnectScheduled = false;
        scheduleReconnect("spawn_failed");
      }
    }, delay);
  }

  function ensureWork() {
    if (!bot.entity) return;
    if (bot._planning) return;
    if (bot._executing) return;

    const now = Date.now();
    const hasWork = bot._planQueue.length > 0;

    if (!hasWork) {
      if (bot._pendingHuman && !bot._planning) {
        const pending = bot._pendingHuman;
        bot._pendingHuman = null;
        bot._lastHumanAt = Date.now();
        bot._planning = true;

        const personaPrompt = persona?.systemPrompt || "";

        const planPromise = LLM_ENABLED
          ? planActions({
              systemPrompt: personaPrompt,
              bot,
              humanMessage: pending.text,
              trigger: "human_deferred",
            })
          : Promise.resolve({ say: "", plan: deterministicPlan(bot, pending.text) });

        planPromise
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) bot._planQueue = res.plan;
          })
          .catch((e) => {
            console.error(`[${bot.username}] deferred planning failed`, e?.message || e);
            bot._planQueue = deterministicPlan(bot, pending.text);
          })
          .finally(() => {
            bot._planning = false;
            ensureWork();
          });
        return;
      }

      if (now - bot._lastHumanAt < COOLDOWN_ON_HUMAN_MS) return;

      if (now - bot._lastAutonomyAt > AUTONOMY_INTERVAL_MS) {
        bot._lastAutonomyAt = now;
        bot._planning = true;

        const personaPrompt = persona?.systemPrompt || "";

        const planPromise = LLM_ENABLED
          ? planActions({ systemPrompt: personaPrompt, bot, humanMessage: null, trigger: "autonomy" })
          : Promise.resolve({
              say: "",
              plan: pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }],
            });

        planPromise
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) bot._planQueue = res.plan;
          })
          .catch((e) => {
            console.error(`[${bot.username}] planning failed`, e?.message || e);
            bot._planQueue = pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }];
          })
          .finally(() => {
            bot._planning = false;
            ensureWork();
          });
        return;
      }

      bot._planQueue = pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }];
    }

    executeNextStep().catch(() => {});
  }

  async function executeNextStep() {
    if (bot._executing) return;
    if (!bot._planQueue.length) return;

    bot._executing = true;
    const startedAt = Date.now();
    const step = bot._planQueue[0];
    bot._current = step;

    const type = normalizeType(step?.type);

    if (isMajorStepType(type)) {
      bot._commitUntil = Math.max(bot._commitUntil || 0, Date.now() + PLAN_COMMIT_MS);
    }

    const stepPos = posObj(bot);

    try {
      if (!type) {
        bot._planQueue.shift();
      } else if (type === "SAY") {
        if (step.text) safeChat(step.text);
        bot._planQueue.shift();
      } else if (type === "PAUSE") {
        await sleep(parseInt(step.ms, 10) || 250);
        bot._planQueue.shift();
      } else if (type === "RESET_PATHFINDER") {
        try { bot.pathfinder.setGoal(null); } catch {}
        try { bot.clearControlStates(); } catch {}
        bot._planQueue.shift();
      } else if (type === "SET_BASE") {
        const p = posObj(bot);
        if (p) setBase(bot, p);
        bot._planQueue.shift();
      } else if (type === "WANDER") {
        const r = parseInt(step.radius, 10) || WANDER_RADIUS;
        const maxMs = parseInt(step.maxMs, 10) || WANDER_MAX_MS;
        wander(bot, r, maxMs);
      } else if (type === "FOLLOW") {
        follow(bot, step.player);
      } else if (type === "GOTO") {
        goto(bot, step.x, step.y, step.z);
      } else if (type === "RETURN_BASE") {
        const b = getBase(bot);
        if (!b) {
          safeChat("I don't have a base saved yet.");
          bot._planQueue.shift();
        } else {
          goto(bot, b.x, b.y, b.z);
        }
      } else if (type === "GATHER_WOOD") {
        await gather.gatherWood(bot, step.count ?? 8);
        bot._planQueue.shift();
      } else if (type === "MINE_BLOCKS") {
        await gather.mineTargets(
          bot,
          step.targets ?? ["coal_ore", "iron_ore", "stone"],
          step.count ?? 10,
          step.radius ?? undefined
        );
        bot._planQueue.shift();
      } else if (type === "FARM_HARVEST_REPLANT") {
        await gather.farmHarvestReplant(bot, step.crops ?? ["wheat", "carrots", "potatoes"], step.max ?? 12);
        bot._planQueue.shift();
      } else if (type === "BUILD_STRUCTURE") {
        await buildFort(bot, step);
        bot._planQueue.shift();
      } else if (type === "BUILD_MONUMENT") {
        await buildMonument(bot, step);
        bot._planQueue.shift();
      } else if (type === "BUILD_MONUMENT_COMPLEX") {
        await buildMonumentComplex(bot, step.kind || "OBELISK", step);
        bot._planQueue.shift();
      } else if (type === "CRAFT_TOOLS") {
        await craftTools(bot);
        bot._planQueue.shift();
      } else if (type === "SMELT_ORE") {
        await smeltOre(bot);
        bot._planQueue.shift();
      } else if (type === "FIGHT_MOBS") {
        await fightMobs(bot, step.seconds ?? 20);
        bot._planQueue.shift();
      } else {
        bot._planQueue.shift();
      }

      if (
        type !== "SAY" &&
        type !== "WANDER" &&
        type !== "FOLLOW" &&
        type !== "GOTO" &&
        type !== "RETURN_BASE"
      ) {
        postEvent(bot.username, `${TEAM_PREFIX} ok ${type}`, "action_ok", {
          type,
          ms: Date.now() - startedAt,
          pos: stepPos,
          pos2: posObj(bot),
        });
      }
    } catch (e) {
      const reason = shortErr(e);
      console.error(`[${bot.username}] step failed`, e?.message || e);

      const parsed = parseInsufficientMaterial(reason);
      if (parsed && bot._current) {
        const remediation = remediateInsufficientMaterial({ bot, step: bot._current, parsed });
        if (remediation?.ok && Array.isArray(remediation.newQueue) && remediation.newQueue.length) {
          postEvent(bot.username, `${TEAM_PREFIX} recover ${type}: ${remediation.reason}`, "action_recover", {
            type,
            reason: remediation.reason,
            err: reason,
            ms: Date.now() - startedAt,
            pos: stepPos,
            pos2: posObj(bot),
          });
          bot._planQueue = [...remediation.newQueue, ...bot._planQueue.slice(1)];
          bot._current = null;
          return;
        }
      }

      const incomplete = parseBuildIncomplete(reason);
      if (incomplete && bot._current && normalizeType(bot._current.type) === "BUILD_STRUCTURE") {
        bot._current._buildRetries = (bot._current._buildRetries || 0) + 1;
        const tries = bot._current._buildRetries;
        if (tries <= 6) {
          postEvent(bot.username, `${TEAM_PREFIX} recover ${type}: build_incomplete_${tries}`, "action_recover", {
            type,
            reason: `build_incomplete_${tries}`,
            err: reason,
            ms: Date.now() - startedAt,
            pos: stepPos,
            pos2: posObj(bot),
            completionPct: incomplete.completionPct,
            placed: incomplete.placed,
            total: incomplete.total,
          });
          bot._planQueue = [
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 4, maxMs: 3500 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }
      }

      if (isPathfinderPlanningError(reason) && bot._current) {
        bot._current._pathRetries = (bot._current._pathRetries || 0) + 1;
        const tries = bot._current._pathRetries;

        if (tries <= PATHFINDER_ERROR_RETRY_LIMIT) {
          postEvent(bot.username, `${TEAM_PREFIX} recover ${type}: pathfinder_retry_${tries}`, "action_recover", {
            type,
            reason: `pathfinder_retry_${tries}`,
            err: reason,
            ms: Date.now() - startedAt,
            pos: stepPos,
            pos2: posObj(bot),
          });

          bot._planQueue = [
            { type: "RESET_PATHFINDER" },
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 6, maxMs: 6000 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }
      }

      postEvent(bot.username, `${TEAM_PREFIX} fail ${type}: ${reason}`, "action_fail", {
        type,
        reason,
        ms: Date.now() - startedAt,
        pos: stepPos,
        pos2: posObj(bot),
      });
      bot._planQueue.shift();
      bot._current = null;
    } finally {
      bot._executing = false;
      ensureWork();
    }
  }

  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    try {
      bot.pathfinder.thinkTimeout = PATHFINDER_THINK_TIMEOUT_MS;
    } catch {}

    ensureWork();
  });

  bot.on("chat", (username2, message) => {
    if (!username2 || username2 === bot.username) return;
    if (!message) return;

    if (message.startsWith(TEAM_PREFIX)) {
      postEvent(username2, message, "chat", {});
      return;
    }

    bot._lastHumanAt = Date.now();
    pushMessage(bot.username, { from: username2, text: message, ts: Date.now() });

    const now = Date.now();
    const hasWork = bot._planQueue.length > 0;
    const committed = hasWork && now < (bot._commitUntil || 0);

    if (committed) {
      bot._pendingHuman = { from: username2, text: message, ts: now };
      safeChat("Got it — I’ll respond after I finish this step.");
      return;
    }

    bot._pendingHuman = { from: username2, text: message, ts: now };
    bot._planQueue = [];
    ensureWork();
  });

  const workInterval = setInterval(() => {
    try {
      tickMovement(bot);
    } catch {}
    ensureWork();
  }, TASK_TICK_MS);

  bot.on("end", () => {
    clearInterval(workInterval);
    scheduleReconnect("end");
  });

  bot.on("kicked", () => {
    clearInterval(workInterval);
    scheduleReconnect("kicked");
  });

  bot.on("error", () => {
    clearInterval(workInterval);
    scheduleReconnect("error");
  });

  return bot;
}

module.exports = { createAgent };
