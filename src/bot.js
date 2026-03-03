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

// ---- LLM rate limiting (per bot) ----
// Prevents bots from calling OpenAI too frequently between steps/failures.
const LLM_MIN_INTERVAL_MINUTES = parseFloat(process.env.LLM_MIN_INTERVAL_MINUTES || "2");
const LLM_MIN_INTERVAL_MS = Math.max(0, LLM_MIN_INTERVAL_MINUTES) * 60 * 1000;

const WANDER_RADIUS = 30;

// ✅ Memory reducer: Mineflayer chunk radius per bot
// Suggested: 2-4. Default here is 3.
const BOT_VIEW_DISTANCE = parseInt(process.env.BOT_VIEW_DISTANCE || "3", 10);

// ---- Pathfinder tuning ----
// mineflayer-pathfinder can throw: "Took to long to decide path to goal!" when path planning exceeds thinkTimeout.
// We set a slightly higher thinkTimeout and add retry logic with a small nudge.
const PATHFINDER_THINK_TIMEOUT_MS = parseInt(process.env.PATHFINDER_THINK_TIMEOUT_MS || "10000", 10);
const PATHFINDER_ERROR_RETRY_LIMIT = parseInt(process.env.PATHFINDER_ERROR_RETRY_LIMIT || "2", 10);

// ---- Plan commitment (reduce mid-task plan switching) ----
// While a "major" step is running, we queue incoming human requests and apply them when we reach a safe boundary.
const PLAN_COMMIT_MS = parseInt(process.env.PLAN_COMMIT_MS || "60000", 10);

// ---- “Always busy” controls ----
const WANDER_MAX_MS = parseInt(process.env.WANDER_MAX_MS || "45000", 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "180000", 10);
const STUCK_NO_MOVE_MS = parseInt(process.env.STUCK_NO_MOVE_MS || "35000", 10); // a bit more tolerant by default

// ---- Extra unstuck tuning ----
const UNSTUCK_COOLDOWN_MS = parseInt(process.env.UNSTUCK_COOLDOWN_MS || "90000", 10);
const GOAL_GRACE_MS = parseInt(process.env.GOAL_GRACE_MS || "8000", 10);
const UNSTUCK_STAGE1_MS = parseInt(process.env.UNSTUCK_STAGE1_MS || "9000", 10);

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500;

// ---- Bot utils ----
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
  // Steps that are expected to take time and should not be interrupted by re-planning.
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

// Parse errors like: "Insufficient cobblestone: have 186, need at least 202"
function parseInsufficientMaterial(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(/Insufficient\s+([a-z0-9_]+):\s*have\s*(\d+),\s*need\s*at\s*least\s*(\d+)/i);
  if (!m) return null;
  return {
    material: m[1].toLowerCase(),
    have: parseInt(m[2], 10) || 0,
    need: parseInt(m[3], 10) || 0,
  };
}

function parseBuildIncomplete(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(/Build\s+incomplete:\s*completion\s*(\d+)%\s*\(placed=(\d+)\/(\d+)/i);
  if (!m) return null;
  return {
    completionPct: parseInt(m[1], 10) || 0,
    placed: parseInt(m[2], 10) || 0,
    total: parseInt(m[3], 10) || 0,
  };
}

function estimateFortBlocks(size = 9, height = 4) {
  // Rough underestimate is fine; builder has its own strict check.
  const s = Math.max(5, Math.min(13, parseInt(size, 10) || 9));
  const h = Math.max(3, Math.min(8, parseInt(height, 10) || 4));
  const floor = s * s;
  const walls = 4 * s * h;
  // Towers + battlements can add a lot; include a buffer.
  return floor + walls + Math.ceil(0.35 * (floor + walls));
}

function setActiveGoalFromStep(bot, step) {
  const type = normalizeType(step?.type);
  if (type === "BUILD_STRUCTURE" && String(step?.kind || "").toUpperCase() === "FORT") {
    bot._activeGoal = {
      kind: "FORT",
      params: {
        size: step.size ?? 9,
        height: step.height ?? 4,
        material: step.material || "cobblestone",
      },
      startedAt: Date.now(),
      lastAttemptAt: 0,
      done: false,
      retries: 0,
    };
  }
}

function mineTargetForMaterial(material) {
  // When you mine "stone" blocks you get "cobblestone" items.
  if (material === "cobblestone") return "stone";
  // Planks come from logs; let gatherWood handle it.
  if (material.endsWith("_planks")) return null;
  // Default fallback: try to mine the material block itself (if it exists).
  return material;
}

function continuationPlanForGoal(bot) {
  const g = bot._activeGoal;
  if (!g || g.done) return null;

  if (g.kind === "FORT") {
    const size = g.params.size ?? 9;
    const height = g.params.height ?? 4;
    const material = g.params.material || "cobblestone";
    const needed = estimateFortBlocks(size, height);
    const have = invCount(bot, material);
    const deficit = Math.max(0, needed - have);

    // If we're short, mine stone (for cobblestone) and keep going.
    if (deficit > 0) {
      const mineCount = Math.max(16, Math.min(64, deficit + 24));
      return [
        {
          type: "SAY",
          text: `Preparing to build the fort: need ~${needed} ${material}, have ${have}. Mining more…`,
        },
        { type: "MINE_BLOCKS", targets: [mineTargetForMaterial(material) || "stone", "coal_ore"], count: mineCount, radius: 48 },
        { type: "BUILD_STRUCTURE", kind: "FORT", size, height, material },
      ];
    }

    return [
      { type: "SAY", text: "Continuing fort construction until it’s clearly complete." },
      { type: "BUILD_STRUCTURE", kind: "FORT", size, height, material },
    ];
  }

  return null;
}

function remediateInsufficientMaterial({ bot, step, parsed }) {
  const { material, have, need } = parsed;
  const deficit = Math.max(0, need - have);

  // Guard against infinite loops: only retry a given step a couple times
  step._resourceRetries = (step._resourceRetries || 0) + 1;
  if (step._resourceRetries > 2) {
    return {
      ok: false,
      reason: `resource_retry_exhausted:${material}`,
      newQueue: [
        {
          type: "SAY",
          text: `I keep coming up short on ${material}. I’ll switch to other useful work for now.`,
        },
        { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12, radius: 48 },
        { type: "SMELT_ORE" },
      ],
    };
  }

  // Mine/craft enough extra, with buffer so we don't thrash.
  const buffer = 24;
  const wantExtra = Math.max(16, Math.min(96, deficit + buffer));

  const mineTarget = mineTargetForMaterial(material);

  // If the required material is planks, do a wood+craft loop.
  if (material.endsWith("_planks")) {
    return {
      ok: true,
      reason: `gather_wood_for_${material}`,
      newQueue: [
        {
          type: "SAY",
          text: `I’m short on ${material}. I’ll gather some wood and craft planks, then continue.`,
        },
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
  const { host, port, persona, username, allBotNames } = opts;

  // ✅ Apply viewDistance here
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
  bot._lastTeamEventAt = 0;
  bot._lastDmAt = 0;

  // LLM call timestamp (for rate limiting)
  bot._lastLlmAt = 0;

  // Long-running goal state (helps complete tasks like "build a fort" without constant replanning)
  bot._activeGoal = null; // { kind, params, startedAt, lastAttemptAt, done, retries }

  // Plan switching guard
  bot._commitUntil = 0;
  bot._pendingHuman = null; // { from, text, ts }

  // team intel dirty flag
  bot._teamDirty = false;
  bot._teamDirtyAt = 0;

  // Watchdog state
  bot._lastPos = null;
  bot._lastMoveAt = Date.now();
  bot._wanderStartedAt = 0;
  bot._stepStartedAt = 0;
  bot._lastUnstuckAt = 0;
  bot._lastGoalChangeAt = 0;
  bot._unstuckStage1At = 0;

  // Chat throttle
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
    console.warn(
      `[${username}] reconnecting in ${Math.round(delay / 1000)}s (reason=${reason})`
    );

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

    // If we have an active long-running goal (e.g., fort), keep progressing with deterministic logic
    // instead of replanning / calling the LLM between partial attempts.
    if (!hasWork && bot._activeGoal && !bot._activeGoal.done) {
      const cont = continuationPlanForGoal(bot);
      if (Array.isArray(cont) && cont.length) {
        bot._planQueue = cont;
      }
    }

    // If no work, plan
    if (!bot._planQueue.length) {
      // If a human message arrived while we were committed to a long task, handle it now.
      if (bot._pendingHuman && !bot._planning) {
        const pending = bot._pendingHuman;
        bot._pendingHuman = null;
        bot._lastHumanAt = Date.now();
        bot._planning = true;
        const personaPrompt = persona?.systemPrompt || "";

        // Per-bot LLM rate limit: if too soon, handle the human request with non-LLM continuation this tick.
        if (LLM_MIN_INTERVAL_MS > 0 && now - (bot._lastLlmAt || 0) < LLM_MIN_INTERVAL_MS) {
          const cont = continuationPlanForGoal(bot);
          bot._planQueue = cont && cont.length ? cont : (pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }]);
          bot._planning = false;
          ensureWork();
          return;
        }
        bot._lastLlmAt = now;

        planActions({
          systemPrompt: personaPrompt,
          bot,
          humanMessage: pending.text,
          trigger: "human_deferred",
        })
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) {
              bot._planQueue = res.plan;
              try {
                setActiveGoalFromStep(
                  bot,
                  res.plan.find((s) => isMajorStepType(normalizeType(s?.type))) || res.plan[0]
                );
              } catch {}
            }
          })
          .catch((e) => {
            console.error(`[${bot.username}] deferred planning failed`, e?.message || e);
            const picked = pickNextTask(bot);
            bot._planQueue = picked ? [picked] : [{ type: "WANDER" }];
          })
          .finally(() => {
            bot._planning = false;
            ensureWork();
          });
        return;
      }

      // Autonomy planning or human prompt
      if (now - bot._lastHumanAt < COOLDOWN_ON_HUMAN_MS) return;

      if (now - bot._lastAutonomyAt > AUTONOMY_INTERVAL_MS) {
        bot._lastAutonomyAt = now;
        bot._planning = true;

        const personaPrompt = persona?.systemPrompt || "";

        // Per-bot LLM rate limit: if too soon, do useful deterministic work instead of calling the LLM.
        if (LLM_MIN_INTERVAL_MS > 0 && now - (bot._lastLlmAt || 0) < LLM_MIN_INTERVAL_MS) {
          const cont = continuationPlanForGoal(bot);
          bot._planQueue = cont && cont.length ? cont : (pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }]);
          bot._planning = false;
          ensureWork();
          return;
        }
        bot._lastLlmAt = now;

        planActions({ systemPrompt: personaPrompt, bot, humanMessage: null, trigger: "autonomy" })
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) {
              bot._planQueue = res.plan;
              try {
                setActiveGoalFromStep(
                  bot,
                  res.plan.find((s) => isMajorStepType(normalizeType(s?.type))) || res.plan[0]
                );
              } catch {}
            }
          })
          .catch((e) => {
            console.error(`[${bot.username}] planning failed`, e?.message || e);
            // hard fallback
            const picked = pickNextTask(bot);
            bot._planQueue = picked ? [picked] : [{ type: "WANDER" }];
          })
          .finally(() => {
            bot._planning = false;
            ensureWork();
          });
        return;
      }

      // If in between autonomy windows, do something small
      const picked = pickNextTask(bot);
      if (picked) bot._planQueue = [picked];
      else bot._planQueue = [{ type: "WANDER" }];
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

    // If we're about to run a long/important step, "commit" for a bit so we don't constantly
    // switch plans due to new LLM outputs or incidental chat.
    if (isMajorStepType(type)) {
      bot._commitUntil = Math.max(bot._commitUntil || 0, Date.now() + PLAN_COMMIT_MS);
    }
    const stepPos = posObj(bot);

    try {
      if (!type) {
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "SAY") {
        if (step.text) safeChat(step.text);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "PAUSE") {
        await sleep(parseInt(step.ms, 10) || 250);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "RESET_PATHFINDER") {
        try {
          bot.pathfinder.setGoal(null);
        } catch {}
        try {
          bot.clearControlStates();
        } catch {}
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "SET_BASE") {
        const p = posObj(bot);
        if (p) setBase(bot, p);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "WANDER") {
        const r = parseInt(step.radius, 10) || WANDER_RADIUS;
        const maxMs = parseInt(step.maxMs, 10) || WANDER_MAX_MS;
        wander(bot, r, maxMs);
        bot._stepStartedAt = 0;
      } else if (type === "FOLLOW") {
        follow(bot, step.player);
        bot._stepStartedAt = 0;
      } else if (type === "GOTO") {
        goto(bot, step.x, step.y, step.z);
        bot._stepStartedAt = 0;
      } else if (type === "RETURN_BASE") {
        const b = getBase(bot);
        if (!b) {
          safeChat("I don't have a base saved yet.");
          bot._planQueue.shift();
        } else {
          goto(bot, b.x, b.y, b.z);
        }
        bot._stepStartedAt = 0;
      } else if (type === "GATHER_WOOD") {
        await gather.gatherWood(bot, step.count ?? 8);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "MINE_BLOCKS") {
        await gather.mineTargets(
          bot,
          step.targets ?? ["coal_ore", "iron_ore", "stone"],
          step.count ?? 10,
          step.radius ?? undefined
        );
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "FARM_HARVEST_REPLANT") {
        await gather.farmHarvestReplant(bot, step.crops ?? ["wheat", "carrots", "potatoes"], step.max ?? 12);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_STRUCTURE") {
        // ✅ NEW: Pass parameters through so builder can size/choose materials.
        await buildFort(bot, step);
        // If this was a fort build, consider the goal completed once the builder returns successfully.
        if (bot._activeGoal && bot._activeGoal.kind === "FORT") {
          bot._activeGoal.done = true;
        }
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_MONUMENT") {
        await buildMonument(bot, step);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_MONUMENT_COMPLEX") {
        await buildMonumentComplex(bot, step.kind || "OBELISK", step);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "CRAFT_TOOLS") {
        await craftTools(bot);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "SMELT_ORE") {
        await smeltOre(bot);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "FIGHT_MOBS") {
        await fightMobs(bot, step.seconds ?? 20);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else {
        // Unknown step: drop it
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      }

      // Light telemetry for important actions
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

      // Recovery: if a build (or other action) fails due to missing/insufficient materials,
      // inject prerequisite gathering/mining steps and retry a limited number of times.
      const parsed = parseInsufficientMaterial(reason);
      if (parsed && bot._current) {
        const remediation = remediateInsufficientMaterial({ bot, step: bot._current, parsed });
        if (remediation?.ok && Array.isArray(remediation.newQueue) && remediation.newQueue.length) {
          postEvent(
            bot.username,
            `${TEAM_PREFIX} recover ${type}: ${remediation.reason}`,
            "action_recover",
            {
              type,
              reason: remediation.reason,
              err: reason,
              ms: Date.now() - startedAt,
              pos: stepPos,
              pos2: posObj(bot),
            }
          );

          // Replace the current step with a small recovery plan so we don't thrash on the same failure.
          bot._planQueue = [...remediation.newQueue, ...bot._planQueue.slice(1)];
          bot._current = null;
          bot._stepStartedAt = 0;

          // Best-effort chat (throttled by safeChat)
          try {
            const firstSay = remediation.newQueue.find((s) => normalizeType(s?.type) === "SAY");
            if (firstSay?.text) safeChat(firstSay.text);
          } catch {}
          return;
        }
      }

      // Recovery: if the builder reports incomplete progress, keep trying the same build step
      // (usually means we placed many blocks but haven't hit the completion threshold yet).
      const incomplete = parseBuildIncomplete(reason);
      if (incomplete && bot._current && normalizeType(bot._current.type) === "BUILD_STRUCTURE") {
        bot._current._buildRetries = (bot._current._buildRetries || 0) + 1;
        const tries = bot._current._buildRetries;

        if (tries <= 6) {
          postEvent(
            bot.username,
            `${TEAM_PREFIX} recover ${type}: build_incomplete_${tries}`,
            "action_recover",
            {
              type,
              reason: `build_incomplete_${tries}`,
              err: reason,
              ms: Date.now() - startedAt,
              pos: stepPos,
              pos2: posObj(bot),
              completionPct: incomplete.completionPct,
              placed: incomplete.placed,
              total: incomplete.total,
            }
          );

          bot._planQueue = [{ type: "PAUSE", ms: 250 }, { type: "WANDER", radius: 4, maxMs: 3500 }, bot._current, ...bot._planQueue.slice(1)];
          bot._current = null;
          bot._stepStartedAt = 0;
          return;
        }
      }

      // Recovery: if mining can't find target blocks nearby, explore a bit and retry.
      if (/No target blocks nearby/i.test(reason) && bot._current && normalizeType(bot._current.type) === "MINE_BLOCKS") {
        bot._current._searchRetries = (bot._current._searchRetries || 0) + 1;
        const tries = bot._current._searchRetries;

        if (tries <= 5) {
          postEvent(
            bot.username,
            `${TEAM_PREFIX} recover ${type}: expand_search_${tries}`,
            "action_recover",
            {
              type,
              reason: `expand_search_${tries}`,
              err: reason,
              ms: Date.now() - startedAt,
              pos: stepPos,
              pos2: posObj(bot),
            }
          );

          // Increase search radius progressively.
          const nextRadius = Math.min(96, Math.max(32, (bot._current.radius || 32) + 16));
          bot._current.radius = nextRadius;

          bot._planQueue = [
            { type: "RESET_PATHFINDER" },
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 14, maxMs: 14000 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          bot._stepStartedAt = 0;
          return;
        }
      }

      // Recovery: if we hit pathfinder planning timeouts, don't immediately abandon the step.
      // Insert a small nudge (reset pathfinder + short wander) and retry the same step a couple times.
      if (isPathfinderPlanningError(reason) && bot._current) {
        bot._current._pathRetries = (bot._current._pathRetries || 0) + 1;
        const tries = bot._current._pathRetries;

        if (tries <= PATHFINDER_ERROR_RETRY_LIMIT) {
          postEvent(
            bot.username,
            `${TEAM_PREFIX} recover ${type}: pathfinder_retry_${tries}`,
            "action_recover",
            {
              type,
              reason: `pathfinder_retry_${tries}`,
              err: reason,
              ms: Date.now() - startedAt,
              pos: stepPos,
              pos2: posObj(bot),
            }
          );

          // Replace current step with a short reset + wander nudge, then retry the original step.
          bot._planQueue = [
            { type: "RESET_PATHFINDER" },
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 6, maxMs: 6000 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];

          bot._current = null;
          bot._stepStartedAt = 0;
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
      bot._stepStartedAt = 0;
    } finally {
      bot._executing = false;
      ensureWork();
    }
  }

  // ---- Lifecycle + watchdog wiring ----
  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    // Pathfinder tuning
    try {
      bot.pathfinder.thinkTimeout = PATHFINDER_THINK_TIMEOUT_MS;
    } catch {}

    // Kick work loop
    ensureWork();
  });

  bot.on("chat", (username2, message) => {
    if (!username2 || username2 === bot.username) return;
    if (!message) return;

    // Team prefixed broadcasts -> record + mark dirty
    if (message.startsWith(TEAM_PREFIX)) {
      postEvent(username2, message, "chat", {});
      bot._teamDirty = true;
      bot._teamDirtyAt = Date.now();
      return;
    }

    // Direct user message
    bot._lastHumanAt = Date.now();
    pushMessage(bot.username, { from: username2, text: message, ts: Date.now() });

    // If we're in the middle of a committed long task, don't wipe the current queue.
    // Queue the message and apply it when we reach a safe boundary (queue empty / idle).
    const now = Date.now();
    const hasWork = bot._planQueue.length > 0;
    const committed = hasWork && now < (bot._commitUntil || 0);

    if (committed) {
      bot._pendingHuman = { from: username2, text: message, ts: now };
      safeChat("Got it — I’ll respond after I finish this step.");
      return;
    }

    // Otherwise, plan immediately by clearing current queue (safe boundary)
    bot._pendingHuman = { from: username2, text: message, ts: now };
    bot._planQueue = [];
    ensureWork();
  });

  // ---- Work tick ----
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
