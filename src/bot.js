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

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500;

// ---- Bot-to-bot DM + social ping ----
const ENABLE_SOCIAL_PING = (process.env.BOT_SOCIAL_PING || "1") === "1";
const SOCIAL_PING_INTERVAL_MS = parseInt(process.env.BOT_SOCIAL_PING_INTERVAL_MS || "60000", 10);
const SOCIAL_PING_PROB = parseFloat(process.env.BOT_SOCIAL_PING_PROB || "0.15"); // 0..1
const BOT_DM_RATE_MS = parseInt(process.env.BOT_DM_RATE_MS || "15000", 10); // per bot: max 1 dm/15s

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeType(t) {
  return String(t || "").trim().toUpperCase();
}

/**
 * Creates a bot AND self-heals by spawning a replacement on disconnect.
 * Important: reconnect spawns a brand-new Mineflayer instance (required).
 */
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

  // Chat throttle (avoid spam kicks)
  bot._lastChatAt = 0;
  function safeChat(msg) {
    const t = Date.now();
    if (t - bot._lastChatAt < 1100) return;
    bot._lastChatAt = t;
    try {
      bot.chat(clampChat(msg));
    } catch {}
  }

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
    const delay = Math.min(5000 * reconnectAttempts, 60000); // 5s, 10s, 15s... cap 60s

    console.log(`[${username}] reconnecting in ${Math.round(delay / 1000)}s (reason=${reason})`);

    setTimeout(() => {
      try {
        // spawn a fresh bot instance
        createAgent(opts);
      } catch (e) {
        console.error(`[${username}] reconnect spawn failed:`, e?.message || e);
        // Try again later
        reconnectScheduled = false;
        scheduleReconnect("spawn_failed");
      }
    }, delay);
  }

  bot.once("spawn", () => {
    // Successful connection -> reset backoff
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));

    if (!getBase(bot)) {
      const b = setBase(bot);
      if (b) postEvent(bot.username, `${TEAM_PREFIX} Base set at ${b.x} ${b.y} ${b.z}`);
    }

    safeChat(`(${bot.username}) online. @mention me.`);

    bot._planQueue = [{ type: "WANDER" }];
    wander(bot, WANDER_RADIUS);

    // Task loop
    intervalIds.push(setInterval(() => tick(bot), TASK_TICK_MS));

    // Autonomy loop: LLM max once/5 min/bot
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
        bot._planQueue = Array.isArray(plan) && plan.length ? plan : [{ type: "WANDER" }];
        bot._current = null;
        bot._lastAutonomyAt = Date.now();
      } catch (e) {
        console.error(`[${bot.username}] autonomy planning error:`, (e && e.message) ? e.message : e);
      } finally {
        bot._planning = false;
      }
    }, 15000));

    // Social ping loop: bots initiate DMs without humans
    if (ENABLE_SOCIAL_PING) {
      intervalIds.push(setInterval(() => {
        try {
          if (!bot.entity) return;
          if (bot._planning || bot._executing) return;
          if (Math.random() > SOCIAL_PING_PROB) return;

          const others = allBotNames ? Array.from(allBotNames).filter(n => n !== bot.username) : [];
          if (!others.length) return;

          const target = others[Math.floor(Math.random() * others.length)];

          // DM rate limit per bot
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

    // Record TEAM broadcasts
    if (String(message).startsWith(TEAM_PREFIX)) {
      const t = Date.now();
      if (t - bot._lastTeamEventAt > TEAM_EVENT_RATE_MS) {
        bot._lastTeamEventAt = t;
        postEvent(sender, message);
      }
      return; // never replan directly from TEAM messages
    }

    const mention = `@${bot.username}`;
    const isMentionToMe = message.toLowerCase().startsWith(mention.toLowerCase());

    // Bot-to-bot DM: if another bot @mentions me, put it in my inbox.
    // Do NOT trigger immediate replanning (prevents loops).
    if (isBotSender) {
      if (isMentionToMe) {
        const dmText = message.slice(mention.length).trim();
        pushMessage(bot.username, sender, dmText);
      }
      return;
    }

    // Human-triggered replanning
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
      bot._planQueue = Array.isArray(plan) && plan.length ? plan : [{ type: "WANDER" }];
      bot._current = null;
    } catch (e) {
      console.error(`[${bot.username}] chat planning error:`, (e && e.message) ? e.message : e);
      safeChat("I had trouble thinking—can you repeat that?");
    } finally {
      bot._planning = false;
    }
  });

  // Kicked can happen before end; scheduleReconnect is idempotent
  bot.on("kicked", (reason) => {
    console.warn(`[${username}] kicked:`, reason);
    scheduleReconnect("kicked");
  });

  bot.on("error", (err) => {
    // EPIPE etc can appear after disconnect; reconnect handled by 'end'
    console.error(`[${username}] bot error:`, err?.message || err);
  });

  bot.on("end", () => {
    console.warn(`[${username}] disconnected`);
    scheduleReconnect("end");
  });

  async function tick(bot) {
    if (!bot.entity) return;

    if (tickMovement(bot)) return;
    if (bot._executing) return;
    if (!bot._planQueue || bot._planQueue.length === 0) return;

    const step = bot._planQueue[0];
    const type = normalizeType(step.type);

    bot._executing = true;

    try {
      if (type === "SAY") {
        // DM rate limit to avoid chatter storms
        const now = Date.now();
        const txt = String(step.text || "");
        const isDm = txt.trim().startsWith("@");
        if (!isDm || (now - bot._lastDmAt >= BOT_DM_RATE_MS)) {
          if (isDm) bot._lastDmAt = now;
          safeChat(txt);
        }
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "WANDER") {
        wander(bot, WANDER_RADIUS);

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
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Gathered wood near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "MINE_BLOCKS") {
        await gather.mineTargets(bot, step.targets ?? ["coal_ore", "iron_ore", "stone"], step.count ?? 10);
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Mining done near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "FARM_HARVEST_REPLANT") {
        await gather.farmHarvestReplant(bot, step.crops ?? ["wheat", "carrots", "potatoes"], step.max ?? 12);
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Farmed near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "BUILD_STRUCTURE") {
        await buildFort(bot);
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Built structure near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "BUILD_MONUMENT") {
        await buildMonument(bot);
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Built monument near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "BUILD_MONUMENT_COMPLEX") {
        await buildMonumentComplex(bot, step.kind || "OBELISK");
        const p = bot.entity.position.floored();
        postEvent(bot.username, `${TEAM_PREFIX} Built complex monument (${step.kind || "OBELISK"}) near ${p.x} ${p.y} ${p.z}`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "CRAFT_TOOLS") {
        await craftTools(bot);
        postEvent(bot.username, `${TEAM_PREFIX} Crafted tools.`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "SMELT_ORE") {
        await smeltOre(bot);
        postEvent(bot.username, `${TEAM_PREFIX} Started smelting.`);
        bot._planQueue.shift();
        bot._current = null;

      } else if (type === "FIGHT_MOBS") {
        await fightMobs(bot, step.seconds ?? 20);
        postEvent(bot.username, `${TEAM_PREFIX} Cleared nearby hostiles.`);
        bot._planQueue.shift();
        bot._current = null;

      } else {
        bot._planQueue.shift();
        bot._current = null;
      }
    } catch (e) {
      console.error(`[${bot.username}] step failed`, (e && e.message) ? e.message : e);
      bot._planQueue.shift();
      bot._current = null;
    } finally {
      bot._executing = false;
    }
  }

  return bot;
}

module.exports = { createAgent };
