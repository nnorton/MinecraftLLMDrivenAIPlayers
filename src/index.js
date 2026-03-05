// src/index.js
require("dotenv").config();

const { installSafeConsole } = require("./utils/safe_console");
installSafeConsole();

// Fail-fast: after uncaught errors, exit so PM2 restarts a clean process.
// Keeping the process alive after an uncaughtException often leaves mineflayer in a bad state.
function fatalExit(tag, err) {
  const name = process.env.BOT_NAME || process.argv[2] || "bot";

  const isEpipe = err && (err.code === "EPIPE" || String(err.message || "").includes("EPIPE"));
  if (isEpipe) {
    // Logging transport failure; don't crash the bot.
    try {
      console.error(`[${name}] ${tag}: write EPIPE (stdout/stderr closed). Continuing.`);
    } catch {}
    return;
  }

  console.error(`[${name}] ${tag}:`, err);
  // Give logs a moment to flush
  setTimeout(() => process.exit(1), 250).unref?.();
}

process.on("unhandledRejection", (reason) => fatalExit("unhandledRejection", reason));
process.on("uncaughtException", (err) => fatalExit("uncaughtException", err));

// Extra signal visibility (PM2 sometimes reports SIGABRT/SIGTERM without context)
for (const sig of ["SIGTERM", "SIGINT", "SIGABRT"]) {
  try {
    process.on(sig, () => {
      const name = process.env.BOT_NAME || process.argv[2] || "bot";
      console.warn(`[${name}] received ${sig} (pid=${process.pid})`);
      // Exit so PM2 can restart if needed
      process.exit(0);
    });
  } catch {}
}

const personas = require("../personas");
const { createAgent } = require("./bot");

const HOST = process.env.MC_HOST;
const PORT = parseInt(process.env.MC_PORT || "25565", 10);

// Optional memory watchdog (highly recommended)
const MEM_WATCHDOG_ENABLED = String(process.env.MEM_WATCHDOG_ENABLED || "true").toLowerCase() !== "false";
const MAX_RSS_MB = parseInt(process.env.MAX_RSS_MB || "0", 10); // 0 = disabled
const MEM_LOG_EVERY_MS = parseInt(process.env.MEM_LOG_EVERY_MS || "60000", 10);

function startMemWatchdog(botName) {
  if (!MEM_WATCHDOG_ENABLED) return;

  setInterval(() => {
    const mu = process.memoryUsage();
    const rssMB = Math.round(mu.rss / 1024 / 1024);
    const heapMB = Math.round(mu.heapUsed / 1024 / 1024);

    // Periodic visibility
    if (String(process.env.DEBUG_MEM || "").toLowerCase() === "true") {
      console.log(`[${botName}] mem rss=${rssMB}MB heapUsed=${heapMB}MB`);
    }

    // If a cap is configured, exit cleanly before the kernel SIGKILLs us.
    if (MAX_RSS_MB > 0 && rssMB >= MAX_RSS_MB) {
      console.error(
        `[${botName}] MAX_RSS_MB exceeded (rss=${rssMB}MB >= ${MAX_RSS_MB}MB). Exiting for PM2 restart.`
      );
      process.exit(1);
    }
  }, MEM_LOG_EVERY_MS).unref?.();
}

// Pick bot via env or CLI arg:
//   BOT_NAME=BeaconBill node src/index.js
//   node src/index.js BeaconBill
const BOT_NAME = process.env.BOT_NAME || process.argv[2];

async function main() {
  if (!HOST) {
    console.error("Missing MC_HOST in env");
    process.exit(1);
  }

  if (!BOT_NAME) {
    console.error("Missing BOT_NAME (env) or username argument.\nExample: BOT_NAME=BeaconBill node src/index.js");
    process.exit(1);
  }

  const cfg = personas.find((p) => p.username === BOT_NAME);
  if (!cfg) {
    console.error(`BOT_NAME "${BOT_NAME}" not found in personas.js`);
    console.error(`Available: ${personas.map((p) => p.username).join(", ")}`);
    process.exit(1);
  }

  const allBotNames = new Set(personas.map((p) => p.username));

  console.log(`Starting single bot process: ${cfg.username}`);
  console.log(`Connecting to ${HOST}:${PORT}`);

  startMemWatchdog(cfg.username);

  createAgent({
    host: HOST,
    port: PORT,
    username: cfg.username,
    persona: cfg.persona,
    allBotNames,
  });
}

main().catch((err) => {
  console.error("Fatal error in src/index.js:", err);
  process.exit(1);
});
