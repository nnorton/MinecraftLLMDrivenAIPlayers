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
const WANDER_RADIUS = 10;

// ---- “Always busy” controls ----
const WANDER_MAX_MS = parseInt(process.env.WANDER_MAX_MS || "45000", 10); // after this, pick real task
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "180000", 10); // 3 min per step
const STUCK_NO_MOVE_MS = parseInt(process.env.STUCK_NO_MOVE_MS || "20000", 10); // 20s no movement => reset

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

  // Watchdog state
  bot._lastPos = null;
  bot._lastMoveAt = Date.now();
  bot._wanderStartedAt = 0;
  bot._stepStartedAt = 0;

  // Chat throttle
  bot._lastChatAt = 0;
  function safeChat(msg) {
    const t = Date.now();
    if (t - bot._lastChatAt < 1100) return;
    bot._lastChatAt = t;
    try { bot.chat(clampChat(msg)); } catch {}
  }

  // --------------------------
  // Reconnect / backoff state
  // --------------------------
  let reconnectAttempts = 0;
  let reconnectScheduled = false;
  const intervalIds = [];

  function cleanupTimers() {
    while (intervalIds.length) {
      try { clearInterval(intervalIds.pop()); } catch {}
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

  function ensureWork(reason = "ensureWork") {
    if (!bot.entity) return;
    if (bot._planning) return;
    if (bot._executing) return;

    // If no plan, immediately pick a concrete task
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

  function updateMovementWatchdog() {
    if (!bot.entity) return;
    const p = bot.entity.position;

    if (!bot._lastPos) {
      bot._lastPos = p.clone();
      bot._lastMoveAt = Date.now();
      return;
    }

    const moved = p.distanceTo(bot._lastPos) > 0.25;
    if (moved) {
      bot._lastPos = p.clone();
      bot._lastMoveAt = Date.now();
      return;
    }

    // If stuck: clear goal, clear current step, pick a new task
    if (Date.now() - bot._lastMoveAt > STUCK_NO_MOVE_MS) {
      try { bot.pathfinder.setGoal(null); } catch {}
      bot._current = null;
      // If we were in a long step, drop it
      if (bot._planQueue && bot._planQueue.length) bot._planQueue.shift();
      bot._planQueue = [pickNextTask(bot)];
      bot._lastMoveAt = Date.now();
      safeChat("(unstuck)");
    }
  }

  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));

    if (!getBase(bot)) {
      const b = setBase(bot);
      if (b) postEvent(bot.username, `${TEAM_PREFIX} Base set at ${b.x} ${b.y} ${b.z}`);
    }

    safeChat(`(${bot.username}) online.`);

    // Start doing real work immediately
    bot._planQueue = [pickNextTask(bot)];
    bot._wanderStartedAt = 0;

    intervalIds.push(setInterval(() => tick(bot), TASK_TICK_MS));

    // Autonomy loop stays as-is (LLM cadence unchanged)
    intervalIds.push(setInterval(async () => {
      if (!bot.entity) return;
      if (bot._planning) return;
      if (Date.now() - bot._lastAutonomyAt < AUTONOMY_INTERVAL_MS) return;

      bot._planning = true;
      try {
        const { say, plan } = await planActions({
          systemPrompt: persona.system,
          bot,
          humanMessage: null,
          trigger: "autonomy"
        });

        if (say) safeChat(say);

        bot.pathfinder.setGoal(null);
        bot._planQueue = Array.isArray(plan) && plan.length ? plan : [pickNextTask(bot)];
        bot._current = null;
        bot._lastAutonomyAt = Date.now();
        bot._wanderStartedAt = 0;
      } catch (e) {
        console.error(`[${bot.username}] autonomy planning error:`, e?.message || e);
      } finally {
        bot._planning = false;
      }
    }, 15000));

    // Social ping loop (optional)
    if (ENABLE_SOCIAL_PING) {
      intervalIds.push(setInterval(() => {
        try {
          if (!bot.entity) return;
          if (bot._planning || bot._executing) return;
          if (Math.random() > SOCIAL_PING_PROB) return;

          const others = allBotNames ? Array.from(allBotNames).filter(n => n !== bot.username) : [];
          if (!others.length) return;

          const target = others[Math.floor(Math.random() * others.length)];
          const now = Date.now();
          if (now - bot._lastDmAt < BOT_DM_RATE_MS) return;
          bot._lastDmAt = now;

          safeChat(`@${target} status check — what are you working on?`);
        } catch {}
      }, SOCIAL_PING_INTERVAL_MS));
    }
  });

  bot.on("chat", async (sender, message) => {
    if (sender === bot.username) return;

    const isBotSender = allBotNames && allBotNames.has(sender);

    if (String(message).startsWith(TEAM_PREFIX)) {
      const t = Date.now();
      if (t - bot._lastTeamEventAt > TEAM_EVENT_RATE_MS) {
        bot._lastTeamEventAt = t;
        postEvent(sender, message);
      }
      return;
    }

    const mention = `@${bot.username}`;
    const isMentionToMe = message.toLowerCase().startsWith(mention.toLowerCase());

    // Bot-to-bot DM inbox
    if (isBotSender) {
      if (isMentionToMe) {
        const dmText = message.slice(mention.length).trim();
        pushMessage(bot.username, sender, dmText);
      }
      return;
    }

    // Human mention -> immediate LLM plan
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
        trigger: "human"
      });

      safeChat(say || `I heard you: "${humanText}". What should I do first?`);
      bot.pathfinder.setGoal(null);
      bot._planQueue = Array.isArray(plan) && plan.length ? plan : [pickNextTask(bot)];
      bot._current = null;
      bot._wanderStartedAt = 0;
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

    // Always-busy enforcement + stuck detection
    ensureWork("tick");
    updateMovementWatchdog();

    // If movement subsystem is handling something, let it run
    if (tickMovement(bot)) return;
    if (bot._executing) return;
    if (!bot._planQueue || bot._planQueue.length === 0) return;

    // Step timeout watchdog
    if (bot._stepStartedAt && Date.now() - bot._stepStartedAt > STEP_TIMEOUT_MS) {
      try { bot.pathfinder.setGoal(null); } catch {}
      bot._current = null;
      if (bot._planQueue.length) bot._planQueue.shift();
      bot._planQueue = [pickNextTask(bot)];
      bot._stepStartedAt = 0;
      safeChat("(timed out, switching tasks)");
      return;
    }

    const step = bot._planQueue[0];
    const type = normalizeType(step.type);

    bot._executing = true;
    if (!bot._stepStartedAt) bot._stepStartedAt = Date.now();

    try {
      if (type === "SAY") {
        const now = Date.now();
        const txt = String(step.text || "");
        const isDm = txt.trim().startsWith("@");
        if (!isDm || (now - bot._lastDmAt >= BOT_DM_RATE_MS)) {
          if (isDm) bot._lastDmAt = now;
          safeChat(txt);
        }
        bot._planQueue.shift();
        bot._current = null;
        bot._stepStartedAt = 0;

      } else if (type === "WANDER") {
        wander(bot, WANDER_RADIUS);
        // don't shift; ensureWork will replace wander after WANDER_MAX_MS
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
    } catch (e) {
      console.error(`[${bot.username}] step failed`, e?.message || e);
      bot._planQueue.shift();
      bot._current = null;
      bot._stepStartedAt = 0;
    } finally {
      bot._executing = false;
      // Always ensure there is a next task queued
      ensureWork("finally");
    }
  }

  return bot;
}

module.exports = { createAgent };
