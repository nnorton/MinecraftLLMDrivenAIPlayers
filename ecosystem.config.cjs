// ecosystem.config.cjs
const personas = require("./personas");

const NODE_HEAP_MB = parseInt(process.env.NODE_HEAP_MB || "4096", 10);

module.exports = {
  apps: personas.map((p) => ({
    name: `mc-${p.username}`,
    script: "./src/index.js", // your single-bot index.js
    instances: 1,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 2000,

    // Give each bot its own heap ceiling (optional but recommended)
    node_args: [`--max-old-space-size=${NODE_HEAP_MB}`],

    // Important: run from repo root so dotenv finds .env
    cwd: __dirname,

    // Only need BOT_NAME here; everything else comes from .env
    env: {
      BOT_NAME: p.username,
    },
  })),
};
