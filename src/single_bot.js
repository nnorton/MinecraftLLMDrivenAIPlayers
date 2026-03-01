// src/single_bot.js
require("dotenv").config();

const personas = require("../personas");
const { createAgent } = require("./bot");

const HOST = process.env.MC_HOST;
const PORT = parseInt(process.env.MC_PORT || "25565", 10);

// You can pass BOT_NAME as env var or as a CLI arg:
//   BOT_NAME=ForemanFinn node src/single_bot.js
//   node src/single_bot.js ForemanFinn
const BOT_NAME = process.env.BOT_NAME || process.argv[2];

async function main() {
  if (!HOST) {
    console.error("Missing MC_HOST in env");
    process.exit(1);
  }
  if (!BOT_NAME) {
    console.error("Missing BOT_NAME (env) or username argument.\nExample: BOT_NAME=ForemanFinn node src/single_bot.js");
    process.exit(1);
  }

  const cfg = personas.find(p => p.username === BOT_NAME);
  if (!cfg) {
    console.error(`BOT_NAME "${BOT_NAME}" not found in personas.js`);
    console.error(`Available: ${personas.map(p => p.username).join(", ")}`);
    process.exit(1);
  }

  const allBotNames = new Set(personas.map(p => p.username));

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

main().catch(err => {
  console.error("Fatal error in single_bot.js:", err);
  process.exit(1);
});
