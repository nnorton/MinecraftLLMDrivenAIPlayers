// src/bot_core/create_agent.js
require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const collectBlock = require("mineflayer-collectblock").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

const { postEvent } = require("../team_bus");
const { pushMessage } = require("../inbox");
const { loadLastLLMPlan } = require("../state_store");
const { tickMovement } = require("../actions/movement");

const { attachEngine } = require("./engine");
const config = require("./config");
const { clamp } = require("./utils");

async function createAgent(opts) {
  const { host, port, persona, username } = opts;

  const bot = mineflayer.createBot({
    host,
    port,
    username,
    viewDistance: config.BOT_VIEW_DISTANCE,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(toolPlugin);

  // Shared state used by engine
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

  const { safeChat, scheduleEnsureWork, ensureWork } = attachEngine({ bot, persona, config });

  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    try {
      bot.pathfinder.thinkTimeout = config.PATHFINDER_THINK_TIMEOUT_MS;
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

    if (message.startsWith(config.TEAM_PREFIX)) {
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
  }, config.TASK_TICK_MS);

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

  // If something external modified the queue, make sure we try to work
  bot.on("health", () => {
    scheduleEnsureWork();
  });

  // Kick off initial work loop (in case spawn already happened very fast)
  setTimeout(() => {
    try {
      ensureWork();
    } catch {}
  }, 250);

  return bot;
}

module.exports = { createAgent };
