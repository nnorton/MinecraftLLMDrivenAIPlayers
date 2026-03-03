// src/index.js
require("dotenv").config();

// Keep the process alive on unexpected async errors. PM2 can still restart us,
// but avoiding hard crashes reduces bot dropouts.
process.on("unhandledRejection", (reason) => {
  console.error(`[${process.env.BOT_NAME || process.argv[2] || "bot"}] unhandledRejection:`, reason);
});
process.on("uncaughtException", (err) => {
  console.error(`[${process.env.BOT_NAME || process.argv[2] || "bot"}] uncaughtException:`, err);
});

const personas = require("../personas");
const { createAgent } = require("./bot");

const HOST = process.env.MC_HOST;
const PORT = parseInt(process.env.MC_PORT || "25565", 10);

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
    console.error(
      "Missing BOT_NAME (env) or username argument.\n" + "Example: BOT_NAME=BeaconBill node src/index.js"
    );
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
