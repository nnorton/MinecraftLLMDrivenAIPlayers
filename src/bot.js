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
const { loadLastLLMPlan } = require("./state_store");

const { goto, follow, wander, tickMovement } = require("./actions/movement");
const { getBase, setBase } = require("./actions/memory");
const { buildFort, buildMonument, buildMonumentComplex } = require("./actions/build");
const { craftTools, smeltOre } = require("./actions/craft");
const { fightMobs } = require("./actions/combat");
const gather = require("./actions/gather");

// ---- Controls ----
const AUTONOMY_INTERVAL_MS = 5 * 60 * 1000;
const TASK_TICK_MS = parseInt(process.env.TASK_TICK_MS || "1500", 10);
const COOLDOWN_ON_HUMAN_MS = 1500;
const WANDER_RADIUS = parseInt(process.env.WANDER_RADIUS || "30", 10);

// ✅ Memory reducer: Mineflayer chunk radius per bot
// Suggested: 2-4. Default here is 3.
const BOT_VIEW_DISTANCE = parseInt(process.env.BOT_VIEW_DISTANCE || "3", 10);

// ---- LLM on/off switch ----
function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}
const LLM_ENABLED = parseBool(process.env.LLM_ENABLED, true);

const DEBUG_BOT = String(process.env.DEBUG_BOT || "").toLowerCase() === "true";

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

function dbg(bot, msg) {
  if (!DEBUG_BOT) return;
  try {
    console.log(`[${bot.username}] ${msg}`);
  } catch {}
}

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
        { type: "GATHER_WOOD", count: 12, radius: 80 },
        { type: "CRAFT_TOOLS" },
        step,
      ],
    };
  }

  if (!mineTarget) {
    return {
      ok: true,
      reason: `fallback_wander_for_${material}`,
      newQueue: [
        { type: "WANDER", radius: 18, maxMs: 12000 },
        step,
      ],
    };
  }

  return {
    ok: true,
    reason: `stockpile_${material}`,
    newQueue: [
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: [mineTarget, "coal_ore"], count: wantExtra, radius: 72 },
      step,
    ],
  };
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

  // loop-control + spam control
  bot._lastStepLogType = null;
  bot._ensureScheduled = false;

  function scheduleEnsureWork() {
    if (bot._ensureScheduled) return;
    bot._ensureScheduled = true;
    setImmediate(() => {
      bot._ensureScheduled = false;
      ensureWork();
    });
  }

  function safeChat(msg) {
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

    // ✅ If we are currently in a movement step, don't restart work.
    // Movement steps rely on tickMovement() to progress/finish.
    const curType = normalizeType(bot._current?.type);
    if (curType === "WANDER" || curType === "GOTO" || curType === "FOLLOW") return;

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
            scheduleEnsureWork();
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
            scheduleEnsureWork();
          });
        return;
      }

      bot._planQueue = pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }];
    }

    const nextType = normalizeType(bot._planQueue?.[0]?.type);
    if (DEBUG_BOT && nextType && nextType !== bot._lastStepLogType) {
      bot._lastStepLogType = nextType;
      dbg(bot, `next step -> ${nextType}`);
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
        try {
          bot.pathfinder.setGoal(null);
        } catch {}
        try {
          bot.clearControlStates();
        } catch {}
        bot._planQueue.shift();
      } else if (type === "SET_BASE") {
        const p = posObj(bot);
        if (p) setBase(bot, p);
        bot._planQueue.shift();
      } else if (type === "WANDER") {
        const r = parseInt(step.radius, 10) || WANDER_RADIUS;
        const maxMs = parseInt(step.maxMs, 10) || WANDER_MAX_MS;
        wander(bot, r, maxMs);
        // do not shift; tickMovement() will shift when done
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
        // IMPORTANT: If no trees nearby, gatherWood returns 0 (no throw).
        // Inject exploration so bots don't stand still forever.
        const got = await gather.gatherWood(bot, step.count ?? 8, step.radius ?? 64);
        if (!got || got <= 0) {
          bot._planQueue = [
            { type: "WANDER", radius: 24, maxMs: 12000 },
            { type: "GATHER_WOOD", count: step.count ?? 8, radius: (step.radius ?? 64) + 32 },
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }
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
        await gather.farmHarvestReplant(
          bot,
          step.crops ?? ["wheat", "carrots", "potatoes"],
          step.max ?? 12,
          step.radius ?? undefined
        );
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
        // 🔥 KEY FIX:
        // craftTools() returns ok:false on "no_logs" (and does not throw),
        // which previously caused an infinite immediate retry loop.
        const res = await craftTools(bot);

        if (!res?.ok) {
          const reason = String(res?.reason || "");
          const missing = Array.isArray(res?.missing) ? res.missing.map(String) : [];

          // If we can't craft because we have no logs, go get logs (movement),
          // and if there are no trees nearby, wander to explore first.
          const needsLogs =
            reason === "no_logs" ||
            missing.includes("*_log") ||
            missing.includes("_log") ||
            missing.some((m) => m.includes("log"));

          if (needsLogs) {
            bot._planQueue = [
              { type: "GATHER_WOOD", count: 12, radius: 64 },
              { type: "CRAFT_TOOLS" },
              ...bot._planQueue.slice(1),
            ];
            bot._current = null;
            return;
          }

          // Generic craft failure: explore a bit then retry once.
          bot._planQueue = [
            { type: "WANDER", radius: 18, maxMs: 9000 },
            { type: "CRAFT_TOOLS" },
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }

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
      // ✅ avoid tight recursion loops; schedule for next tick
      scheduleEnsureWork();
    }
  }

  function posObj(bot) {
    const p = bot?.entity?.position;
    if (!p) return null;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
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

    (async () => {
      try {
        bot._lastAutonomyAt = Date.now();
        const last = await loadLastLLMPlan(bot.username);
        if (last && Array.isArray(last.plan) && last.plan.length) {
          bot._planQueue = last.plan;
        }
      } catch {
        // ignore
      } finally {
        scheduleEnsureWork();
      }
    })();
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
    scheduleEnsureWork();
  });

  const workInterval = setInterval(() => {
    try {
      tickMovement(bot);
    } catch {}
    scheduleEnsureWork();
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
