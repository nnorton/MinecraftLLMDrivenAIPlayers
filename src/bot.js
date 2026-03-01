// src/bot.js
require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const collectBlock = require("mineflayer-collectblock").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

const { planActions } = require("./planner");
const { postEvent } = require("./team_bus");

const { goto, follow, wander, tickMovement } = require("./actions/movement");
const { getBase, setBase } = require("./actions/memory");
const { buildFort, buildMonument, buildMonumentComplex } = require("./actions/build");
const { craftTools, smeltOre } = require("./actions/craft");
const { fightMobs } = require("./actions/combat");
const gather = require("./actions/gather");

// ---- Controls ----
const AUTONOMY_INTERVAL_MS = 5 * 60 * 1000; // at most one autonomous LLM plan per 5 min per bot
const TASK_TICK_MS = 1500;
const COOLDOWN_ON_HUMAN_MS = 1500;
const WANDER_RADIUS = 10;

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500; // avoid team spam
const MAX_BOT_CHAT_ECHO = 0;     // keep 0 to avoid bot-to-bot echo chains

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeType(t) {
  return String(t || "").trim().toUpperCase();
}

async function createAgent({ host, port, persona, username, allBotNames }) {
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

  // Optional: safe chat throttle (helps avoid server spam rules)
  bot._lastChatAt = 0;
  function safeChat(msg) {
    const t = Date.now();
    if (t - bot._lastChatAt < 1100) return;
    bot._lastChatAt = t;
    try { bot.chat(clampChat(msg)); } catch {}
  }

  bot.once("spawn", () => {
    const mcData = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));

    if (!getBase(bot)) {
      const b = setBase(bot);
      if (b) postEvent(bot.username, `${TEAM_PREFIX} Base set at ${b.x} ${b.y} ${b.z}`);
    }

    safeChat(`(${bot.username}) online. @mention me.`);

    // light activity
    bot._planQueue = [{ type: "WANDER" }];
    wander(bot, WANDER_RADIUS);

    // Task loop
    setInterval(() => tick(bot), TASK_TICK_MS);

    // Autonomy loop (LLM max once/5min/bot)
    setInterval(async () => {
      if (!bot.entity) return;
      if (bot._planning) return;
      if (Date.now() - bot._lastAutonomyAt < AUTONOMY_INTERVAL_MS) return;

      bot._planning = true;
      try {
        const { say, plan } = await planActions({
          systemPrompt: persona.system,
          bot,
          humanMessage: null
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
    }, 15000);
  });

  // ✅ Bot-to-bot influence:
  // - Bots can publish TEAM events by chatting "[TEAM] ..."
  // - Bot messages do NOT trigger immediate replans (prevents loops)
  bot.on("chat", async (sender, message) => {
    if (sender === bot.username) return;

    const isBotSender = allBotNames && allBotNames.has(sender);

    // Record TEAM broadcasts from any sender (human or bot)
    if (String(message).startsWith(TEAM_PREFIX)) {
      const t = Date.now();
      if (t - bot._lastTeamEventAt > TEAM_EVENT_RATE_MS) {
        bot._lastTeamEventAt = t;
        postEvent(sender, message); // store the whole message (prefix included)
      }
      // Important: do not replan off TEAM messages directly
      return;
    }

    // If it's a bot sender and not a TEAM broadcast, ignore to prevent loops
    if (isBotSender) {
      if (MAX_BOT_CHAT_ECHO > 0) {
        // (Optional) could log or react, but default is off
      }
      return;
    }

    // Human-triggered replanning via @mention (immediate)
    const mention = `@${bot.username}`;
    if (!message.toLowerCase().startsWith(mention.toLowerCase())) return;

    if (Date.now() - bot._lastHumanAt < COOLDOWN_ON_HUMAN_MS) return;
    bot._lastHumanAt = Date.now();

    const humanText = message.slice(mention.length).trim();

    if (bot._planning) return;
    bot._planning = true;

    try {
      const { say, plan } = await planActions({
        systemPrompt: persona.system,
        bot,
        humanMessage: humanText
      });

      safeChat(say || "Got it.");

      bot.pathfinder.setGoal(null);
      bot._planQueue = Array.isArray(plan) && plan.length ? plan : [{ type: "WANDER" }];
      bot._current = null;
    } catch (e) {
      console.error(`[${bot.username}] chat planning error:`, (e && e.message) ? e.message : e);
      safeChat("Brain hiccup—try again.");
    } finally {
      bot._planning = false;
    }
  });

  bot.on("error", (e) => console.error(`[${bot.username}] bot error`, e));
  bot.on("end", () => console.log(`[${bot.username}] disconnected`));

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
        safeChat(step.text || "");
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
          safeChat("No base set.");
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
        await buildFort(bot); // starter: treat all kinds as fort
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
