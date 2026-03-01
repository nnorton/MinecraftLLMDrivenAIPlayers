// src/llm_logger.js
const fs = require("fs");
const path = require("path");

const LOG_DIR = process.env.LOG_DIR || "logs";
const LOG_FILE = process.env.LLM_LOG_FILE || "llm_plans.jsonl";
const ENABLED = (process.env.LOG_LLM || "0") === "1";
const INCLUDE_PROMPTS = (process.env.LOG_LLM_PROMPTS || "0") === "1";

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ error: "Failed to JSON.stringify log record" });
  }
}

function logPlan(record) {
  if (!ENABLED) return;

  ensureDir();
  const filepath = path.join(LOG_DIR, LOG_FILE);

  // If prompts are disabled, remove them defensively
  if (!INCLUDE_PROMPTS) {
    if (record?.request) {
      delete record.request.system;
      delete record.request.user;
      delete record.request.menu;
    }
  }

  const line = safeJson({ ts: new Date().toISOString(), ...record }) + "\n";
  fs.appendFile(filepath, line, () => {});
}

module.exports = { logPlan };
