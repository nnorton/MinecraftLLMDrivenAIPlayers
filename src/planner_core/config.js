// src/planner_core/config.js
require("dotenv").config();

function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}

const LLM_ENABLED = parseBool(process.env.LLM_ENABLED, true);

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "1000", 10);

module.exports = { parseBool, LLM_ENABLED, MODEL, MAX_OUTPUT_TOKENS };
