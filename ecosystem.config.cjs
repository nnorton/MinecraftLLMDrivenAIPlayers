// ecosystem.config.cjs
const personas = require("./personas");

// IMPORTANT:
// 4096MB heap per bot will OOM most hosts when multiple bots run.
// Default to 1024MB and let NODE_HEAP_MB override per-machine.
const NODE_HEAP_MB = parseInt(process.env.NODE_HEAP_MB || "1024", 10);

// Restart a bot before the kernel OOM-kills it.
// You can tune this based on your server RAM / number of bots.
const MAX_MEMORY_RESTART = process.env.PM2_MAX_MEMORY_RESTART || "1300M";

module.exports = {
  apps: personas.map((p) => ({
    name: `mc-${p.username}`,
    script: "./src/index.js",
    instances: 1,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 2000,

    // Give each bot its own heap ceiling
    node_args: [`--max-old-space-size=${NODE_HEAP_MB}`],

    // PM2 will restart the process if RSS grows beyond this threshold
    max_memory_restart: MAX_MEMORY_RESTART,

    // Run from repo root so dotenv finds .env
    cwd: __dirname,

    env: {
      BOT_NAME: p.username,
    },
  })),
};
