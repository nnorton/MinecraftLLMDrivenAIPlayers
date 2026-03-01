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

// ---- “Always busy” controls ----
const WANDER_MAX_MS = parseInt(process.env.WANDER_MAX_MS || "45000", 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "180000", 10);
const STUCK_NO_MOVE_MS = parseInt(process.env.STUCK_NO_MOVE_MS || "20000", 10);

// ✅ New: anti-spam + grace periods
const UNSTUCK_COOLDOWN_MS = parseInt(process.env.UNSTUCK_COOLDOWN_MS || "60000", 10); // 60s
const GOAL_GRACE_MS = parseInt(process.env.GOAL_GRACE_MS || "6000", 10); // 6s after goal change
const UNSTUCK_STAGE1_MS = parseInt(process.env.UNSTUCK_STAGE1_MS || "8000", 10); // stage1 attempt window

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500;

// ---- Bot-to-bot DM + social ping ----
const ENABLE_SOCIAL_PING = (process.env.BOT_SOCIAL_PING || "1") === "1";
const SOCIAL_PING_INTERVAL_MS = parseInt(process.env.BOT_SOCIAL_PING_INTERVAL_MS || "60000", 10);
const SOCIAL_PING_PROB = parseFloat(process.env.BOT_SOCIAL_PING_PROB || "0.15");
const BOT_DM_RATE_MS = parseInt(process.env.BOT_DM_RATE_MS || "15000", 10);

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}
function normalizeType(t) {
  return String(t || "").trim().toUpperCase();
}
function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 220);
}
function posObj(bot) {
  const p = bot.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

async function createAgent(opts) {
  const { host, port, persona, username, allBotNames } = opts;

  const bot = mineflayer.createBot({ host, port, username });
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

  // team intel dirty flag
  bot._teamDirty = false;
  bot._teamDirtyAt = 0;

  // Watchdog state
  bot._lastPos = null;
  bot._lastMoveAt = Date.now();
  bot._wanderStartedAt = 0;
  bot._stepStartedAt = 0;

  // ✅ New: unstuck control state
  bot._lastUnstuckAt = 0;
  bot._lastGoalChangeAt = 0;
  bot._unstuckStage1At = 0;

  // Chat throttle
  bot._lastChatAt = 0;
  function safeChat(msg) {
    const t = Date.now();
    if (t - bot._lastChatAt < 1100) return;
    bot._lastChatAt = t;
    try {
      bot.chat(clampChat(msg));
    } catch {}
  }

  // Track goal changes for grace period
  try {
    bot.pathfinder.on("goal_updated", () => {
      bot._lastGoalChangeAt = Date.now();
      // reset movement baseline on new goal to avoid immediate false unstuck
      bot._lastPos = bot.entity?.position ? bot.entity.position.clone() : bot._lastPos;
      bot._lastMoveAt = Date.now();
    });
  } catch {}

  // --------------------------
  // Reconnect / backoff state
  // --------------------------
  let reconnectAttempts = 0;
  let reconnectScheduled = false;
  const intervalIds = [];

  function cleanupTimers() {
    while (intervalIds.length) {
      try {
        clearInterval(intervalIds.pop());
      } catch {}
    }
  }

  function scheduleReconnect(reason) {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    cleanupTimers();
    reconnectAttempts += 1;
    const delay = Math.min(5000 * reconnectAttempts, 60000);
    console.log(`[${username}] reconnecting in ${Math.round(delay / 1000)}s (reason=${reason})`);
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

    // If team intel arrived recently, do a cheap replan (no LLM)
    if (bot._teamDirty) {
      const head = bot._planQueue?.[0];
      const headType = head ? normalizeType(head.type) : "";
      const idleOrWander = !head || headType === "WANDER";
      if (idleOrWander) {
        bot._planQueue = [pickNextTask(bot)];
        bot._current = null;
        bot._wanderStartedAt = 0;
        bot._stepStartedAt = 0;
        bot._teamDirty = false;
        return;
      }
    }

    if (!bot._planQueue || bot._planQueue.length === 0) {
      bot._planQueue = [pickNextTask(bot)];
      bot._current = null;
      bot._wanderStartedAt = 0;
      bot._stepStartedAt = 0;
      return;
    }

    // If wandering too long, replace wander with a real task
    const head = bot._planQueue[0];
    if (normalizeType(head.type) === "WANDER") {
      if (!bot._wanderStartedAt) bot._wanderStartedAt = Date.now();
      if (Date.now() - bot._wanderStartedAt > WANDER_MAX_MS) {
        bot._planQueue = [pickNextTask(bot)];
        bot._current = null;
        bot._wanderStartedAt = 0;
        bot._stepStartedAt = 0;
        safeChat("(switching tasks)");
      }
    } else {
      bot._wanderStartedAt = 0;
    }
  }

  function isMovementAction() {
    const step = bot._planQueue?.[0];
    const type = normalizeType(step?.type);
    return type === "GOTO" || type === "FOLLOW" || type === "RETURN_BASE" || type === "WANDER";
  }

  async function doUnstuckStage1() {
    // Small “wiggle” attempt that often solves fence/corner jitter without nuking the plan
    try {
      bot.setControlState("jump", true);
      bot.setControlState("left", true);
      bot.setControlState("forward", true);
      setTimeout(() => {
        try {
          bot.setControlState("jump", false);
          bot.setControlState("left", false);
          bot.setControlState("forward", false);
        } catch {}
      }, 900);
    } catch {}
  }

  function updateMovementWatchdog() {
    if (!bot.entity) return;

    // Only apply to movement actions
    if (!isMovementAction()) return;

    const now = Date.now();

    // Cooldown so it can't spam
    if (now - bot._lastUnstuckAt < UNSTUCK_COOLDOWN_MS) return;

    // Grace period after goal changes
    if (now - bot._lastGoalChangeAt < GOAL_GRACE_MS) return;

    const p = bot.entity.position;

    if (!bot._lastPos) {
      bot._lastPos = p.clone();
      bot._lastMoveAt = now;
      return;
    }

    const moved = p.distanceTo(bot._lastPos) > 0.25;
    if (moved) {
      bot._lastPos = p.clone();
      bot._lastMoveAt = now;
      bot._unstuckStage1At = 0;
      return;
    }

    // If we haven't moved for a while…
    if (now - bot._lastMoveAt > STUCK_NO_MOVE_MS) {
      // Stage 1: try a quick wiggle first (once), then wait a bit
      if (!bot._unstuckStage1At) {
        bot._unstuckStage1At = now;
        doUnstuckStage1();
        // Give it some time to resolve without spamming chat
        bot._lastMoveAt = now;
        return;
      }

      // If stage1 didn't help after a window, Stage 2: cancel goal + new task
      if (now - bot._unstuckStage1At > UNSTUCK_STAGE1_MS) {
        try {
          bot.pathfinder.setGoal(null);
        } catch {}
        bot._current = null;
        if (bot._planQueue && bot._planQueue.length) bot._planQueue.shift();
        bot._planQueue = [pickNextTask(bot)];

        bot._lastUnstuckAt = now;
        bot._unstuckStage1At = 0;
        bot._lastPos = p.clone();
        bot._lastMoveAt = now;

        safeChat("(unstuck)");
      }
    }
  }

  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));

    if (!getBase(bot)) {
      const b = setBase(bot);
      if (b) postEvent(bot.username, `${TEAM_PREFIX} Base set at ${b.x} ${b.y} ${b.z}`, "team", { base: b });
    }

    safeChat(`(${bot.username}) online.`);

    bot._planQueue = [pickNextTask(bot)];
    bot._wanderStartedAt = 0;

    intervalIds.push(setInterval(() => tick(bot), TASK_TICK_MS));

    intervalIds.push(
      setInterval(async () => {
        if (!bot.entity) return;
        if (bot._planning) return;
        if (Date.now() - bot._lastAutonomyAt < AUTONOMY_INTERVAL_MS) return;

        bot._planning = true;
        try {
          const { say, plan } = await planActions({
            systemPrompt: persona.system,
            bot,
            humanMessage: null,
            trigger: "autonomy",
          });

          if (say) safeChat(say);
          bot.pathfinder.setGoal(null);
          bot._planQueue = Array.isArray(plan) && plan.length ? plan : [pickNextTask(bot)];
          bot._current = null;
          bot._lastAutonomyAt = Date.now();
          bot._wanderStartedAt = 0;
          bot._teamDirty = false;

          // goal grace
          bot._lastGoalChangeAt = Date.now();
        } catch (e) {
          console.error(`[${bot.username}] autonomy planning error:`, e?.message || e);
        } finally {
          bot._planning = false;
        }
      }, 15000)
    );

    if (ENABLE_SOCIAL_PING) {
      intervalIds.push(
        setInterval(() => {
          try {
            if (!bot.entity) return;
            if (bot._planning || bot._executing) return;
            if (Math.random() > SOCIAL_PING_PROB) return;
            const others = allBotNames ? Array.from(allBotNames).filter((n) => n !== bot.username) : [];
            if (!others.length) return;
            const target = others[Math.floor(Math.random() * others.length)];
            const now = Date.now();
            if (now - bot._lastDmAt < BOT_DM_RATE_MS) return;
            bot._lastDmAt = now;
            safeChat(`@${target} status check — what are you working on?`);
          } catch {}
        }, SOCIAL_PING_INTERVAL_MS)
      );
    }
  });

  bot.on("chat", async (sender, message) => {
    if (sender === bot.username) return;
    const isBotSender = allBotNames && allBotNames.has(sender);

    if (String(message).startsWith(TEAM_PREFIX)) {
      const t = Date.now();
      if (t - bot._lastTeamEventAt > TEAM_EVENT_RATE_MS) {
        bot._lastTeamEventAt = t;
        postEvent(sender, message, "team", { ts: t });
        bot._teamDirty = true;
        bot._teamDirtyAt = t;
      }
      return;
    }

    const mention = `@${bot.username}`;
    const isMentionToMe = message.toLowerCase().startsWith(mention.toLowerCase());

    if (isBotSender) {
      if (isMentionToMe) {
        const dmText = message.slice(mention.length).trim();
        pushMessage(bot.username, sender, dmText);
      }
      return;
    }

    if (!isMentionToMe) return;
    if (Date.now() - bot._lastHumanAt < COOLDOWN_ON_HUMAN_MS) return;
    bot._lastHumanAt = Date.now();

    const humanText = message.slice(mention.length).trim();
    if (bot._planning) return;

    bot._planning = true;
    try {
      const { say, plan } = await planActions({
        systemPrompt: persona.system,
        bot,
        humanMessage: humanText,
        trigger: "human",
      });

      safeChat(say || `I heard you: "${humanText}". What should I do first?`);
      bot.pathfinder.setGoal(null);
      bot._planQueue = Array.isArray(plan) && plan.length ? plan : [pickNextTask(bot)];
      bot._current = null;
      bot._wanderStartedAt = 0;
      bot._teamDirty = false;

      bot._lastGoalChangeAt = Date.now();
    } catch (e) {
      console.error(`[${bot.username}] chat planning error:`, e?.message || e);
      safeChat("I had trouble thinking—can you repeat that?");
    } finally {
      bot._planning = false;
    }
  });

  bot.on("kicked", (reason) => {
    console.warn(`[${username}] kicked:`, reason);
    scheduleReconnect("kicked");
  });

  bot.on("error", (err) => {
    console.error(`[${username}] bot error:`, err?.message || err);
  });

  bot.on("end", () => {
    console.warn(`[${username}] disconnected`);
    scheduleReconnect("end");
  });

  async function tick(bot) {
    if (!bot.entity) return;

    ensureWork();

    // Movement watchdog (now with grace + cooldown + staged)
    updateMovementWatchdog();

    if (tickMovement(bot)) return;

    if (bot._executing) return;
    if (!bot._planQueue || bot._planQueue.length === 0) return;

    if (bot._stepStartedAt && Date.now() - bot._stepStartedAt > STEP_TIMEOUT_MS) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      bot._current = null;
      if (bot._planQueue.length) bot._planQueue.shift();
      bot._planQueue = [pickNextTask(bot)];
      bot._stepStartedAt = 0;
      safeChat("(timed out, switching tasks)");

      postEvent(bot.username, `[TEAM] step timeout`, "action_fail", {
        type: "STEP_TIMEOUT",
        reason: "step exceeded STEP_TIMEOUT_MS",
        pos: posObj(bot),
      });
      return;
    }

    const step = bot._planQueue[0];
    const type = normalizeType(step.type);

    bot._executing = true;
    if (!bot._stepStartedAt) bot._stepStartedAt = Date.now();

    const startedAt = Date.now();
    const stepPos = posObj(bot);

    try {
      if (type === "SAY") {
        const txt = String(step.text || "");
        const isDm = txt.trim().startsWith("@");
        const now = Date.now();
        if (!isDm || now - bot._lastDmAt >= BOT_DM_RATE_MS) {
          if (isDm) bot._lastDmAt = now;
          safeChat(txt);
        }
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "WANDER") {
        wander(bot, WANDER_RADIUS);
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
        await gather.mineTargets(bot, step.targets ?? ["coal_ore", "iron_ore", "stone"], step.count ?? 10);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "FARM_HARVEST_REPLANT") {
        await gather.farmHarvestReplant(bot, step.crops ?? ["wheat", "carrots", "potatoes"], step.max ?? 12);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_STRUCTURE") {
        await buildFort(bot);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_MONUMENT") {
        await buildMonument(bot);
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      } else if (type === "BUILD_MONUMENT_COMPLEX") {
        await buildMonumentComplex(bot, step.kind || "OBELISK");
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
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;
      }

      if (type !== "SAY" && type !== "WANDER" && type !== "FOLLOW" && type !== "GOTO" && type !== "RETURN_BASE") {
        postEvent(bot.username, `${TEAM_PREFIX} ok ${type}`, "action_ok", {
          type,
          ms: Date.now() - startedAt,
          pos: stepPos,
          pos2: posObj(bot),
        });
      }
    } catch (e) {
      console.error(`[${bot.username}] step failed`, e?.message || e);

      postEvent(bot.username, `${TEAM_PREFIX} fail ${type}: ${shortErr(e)}`, "action_fail", {
        type,
        reason: shortErr(e),
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

  return bot;
}

module.exports = { createAgent };
