// src/index.js
require("dotenv").config();
const personas = require("../personas");
const { createAgent } = require("./bot");

const HOST = process.env.MC_HOST;
const PORT = parseInt(process.env.MC_PORT || "25565", 10);
const JOIN_STAGGER_MS = 4000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log(`Connecting to ${HOST}:${PORT}`);

  const allBotNames = new Set(personas.map(p => p.username));

  for (const cfg of personas) {
    await sleep(JOIN_STAGGER_MS);
    createAgent({
      host: HOST,
      port: PORT,
      username: cfg.username,
      persona: cfg.persona,
      allBotNames
    });
  }
})();
