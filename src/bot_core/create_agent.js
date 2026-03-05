// src/bot_core/create_agent.js
require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const collectBlock = require("mineflayer-collectblock").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

const { monitorEventLoopDelay } = require("perf_hooks");

const { postEvent } = require("../team_bus");
const { pushMessage } = require("../inbox");
const { loadLastLLMPlan } = require("../state_store");
const { tickMovement } = require("../actions/movement");

const { installChatLimiter } = require("../utils/chat_limiter");

const { attachEngine } = require("./engine");
const config = require("./config");
const { clamp } = require("./utils");

// --- Safe import of diag helpers (DO NOT crash bots if file missing) ---
let safeJson, shortOneLine, getBotSnapshot;
try {
  ({ safeJson, shortOneLine, getBotSnapshot } = require("../utils/diag"));
} catch (e) {
  safeJson = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      try {
        return String(v);
      } catch {
        return "<unstringifiable>";
      }
    }
  };
  shortOneLine = (s, max = 380) => {
    const str = String(s ?? "");
    const one = str.replace(/\s+/g, " ").trim();
    if (one.length <= max) return one;
    return one.slice(0, max - 3) + "...";
  };
  getBotSnapshot = (bot) => {
    const now = Date.now();
    const pos = bot?.entity?.position;
    return {
      cur: bot?._current?.type ? String(bot._current.type).toUpperCase() : "NONE",
      q: Array.isArray(bot?._planQueue) ? bot._planQueue.length : 0,
      planning: !!bot?._planning,
      executing: !!bot?._executing,
      pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
      lastPacketMs: bot?._diag?.lastPacketAt ? now - bot._diag.lastPacketAt : null,
      lastMoveMs: bot?._diag?.lastMoveAt ? now - bot._diag.lastMoveAt : null,
      eventLoopDelayMsP95: bot?._diag?.eventLoopDelayMsP95 ?? null,
    };
  };

  try {
    console.warn(`[${process.env.BOT_NAME || "bot"}] [warn] diag helpers not found; using fallback. (${e?.code || e})`);
  } catch {}
}

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

  // IMPORTANT: prevent kicks like "disconnect.spam"
  // Make this non-fatal if anything goes wrong.
  try {
    installChatLimiter(bot);
  } catch (e) {
    console.warn(`[${username}] [warn] installChatLimiter failed (non-fatal): ${e?.message || e}`);
  }

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

  // diagnostic state
  bot._diag = {
    createdAt: Date.now(),
    spawnedAt: null,
    lastPacketAt: null,
    lastMoveAt: null,
    eventLoopDelayMsP95: null,
  };

  let reconnectAttempts = 0;
  let reconnectScheduled = false;

  let elDelay = null;
  function startEventLoopMonitor() {
    try {
      elDelay?.disable?.();
    } catch {}
    try {
      elDelay = monitorEventLoopDelay({ resolution: 20 });
      elDelay.enable();
      setInterval(() => {
        try {
          bot._diag.eventLoopDelayMsP95 = Math.round(elDelay.percentile(95) / 1e6);
          elDelay.reset();
        } catch {}
      }, 15000).unref?.();
    } catch (e) {
      console.warn(`[${username}] [warn] event loop monitor unavailable: ${e?.message || e}`);
    }
  }

  function stopEventLoopMonitor() {
    try {
      elDelay?.disable?.();
    } catch {}
    elDelay = null;
  }

  function logDisconnect(kind, details) {
    const snap = getBotSnapshot(bot);
    const d = details ? shortOneLine(details, 650) : null;
    console.warn(`[${username}] [disconnect] kind=${kind} details=${d || ""} snap=${safeJson(snap)}`);
  }

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

  try {
    bot._client?.on?.("packet", () => {
      bot._diag.lastPacketAt = Date.now();
    });
  } catch {}

  bot.on("move", () => {
    bot._diag.lastMoveAt = Date.now();
  });

  bot.on("login", () => {
    console.log(`[${username}] [lifecycle] login host=${host}:${port}`);
  });

  bot.once("spawn", () => {
    reconnectAttempts = 0;
    reconnectScheduled = false;

    bot._diag.spawnedAt = Date.now();
    bot._diag.lastPacketAt = Date.now();
    bot._diag.lastMoveAt = Date.now();
    startEventLoopMonitor();

    try {
      const g = bot.game || {};
      console.log(
        `[${username}] [lifecycle] spawn dimension=${g.dimension || "?"} mode=${g.gameMode || "?"} difficulty=${
          g.difficulty || "?"
        }`
      );
    } catch {}

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
          console.log(`[${username}] [startup] loaded last plan q=${bot._planQueue.length}`);
        } else {
          console.log(`[${username}] [startup] no last plan found`);
        }
      } catch (e) {
        console.warn(`[${username}] [startup] loadLastLLMPlan failed: ${e?.message || e}`);
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

  const heartbeatMs = Math.max(15000, parseInt(process.env.HEARTBEAT_LOG_MS || "30000", 10) || 30000);
  const heartbeat = setInterval(() => {
    try {
      console.log(`[${username}] [heartbeat] ${safeJson(getBotSnapshot(bot))}`);
    } catch {}
  }, heartbeatMs);
  heartbeat.unref?.();

  bot.on("end", (reason) => {
    try {
      logDisconnect("end", reason);
    } catch {}
    stopEventLoopMonitor();
    clearInterval(workInterval);
    clearInterval(heartbeat);
    scheduleReconnect("end");
  });

  bot.on("kicked", (reason, loggedIn) => {
    try {
      logDisconnect("kicked", `loggedIn=${loggedIn} reason=${safeJson(reason)}`);
    } catch {}
    stopEventLoopMonitor();
    clearInterval(workInterval);
    clearInterval(heartbeat);
    scheduleReconnect("kicked");
  });

  bot.on("error", (err) => {
    try {
      logDisconnect("error", err?.stack || err?.message || safeJson(err));
    } catch {}
    stopEventLoopMonitor();
    clearInterval(workInterval);
    clearInterval(heartbeat);
    scheduleReconnect("error");
  });

  bot.on("health", () => {
    scheduleEnsureWork();
  });

  setTimeout(() => {
    try {
      ensureWork();
    } catch {}
  }, 250);

  return bot;
}

module.exports = { createAgent };
