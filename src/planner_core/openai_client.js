// src/planner_core/openai_client.js
require("dotenv").config();

let _client = null;

async function getClient() {
  if (_client) return _client;
  const mod = await import("openai");
  const OpenAI = mod.default || mod.OpenAI || mod;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

module.exports = { getClient };
