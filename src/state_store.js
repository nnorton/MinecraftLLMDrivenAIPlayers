// src/state_store.js
// Lightweight, crash-safe persistence for per-bot state (eg, last successful LLM plan).

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

function sanitizeName(name) {
  return String(name || "bot")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

function stateDir() {
  // Default to a stable location that survives process restarts.
  // Users can override with BOT_STATE_DIR in .env.
  const cfg = process.env.BOT_STATE_DIR;
  if (cfg && String(cfg).trim()) return path.resolve(String(cfg).trim());

  // If CWD is inside the repo, this yields <repo>/state.
  return path.resolve(process.cwd(), "state");
}

function planFilePath(username) {
  return path.join(stateDir(), `${sanitizeName(username)}.last_llm_plan.json`);
}

async function ensureDir() {
  const dir = stateDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(obj, null, 2);
  await fsp.writeFile(tmp, payload, "utf8");
  await fsp.rename(tmp, filePath);
}

async function saveLastLLMPlan(username, planObj) {
  if (!username) return;
  await ensureDir();
  const filePath = planFilePath(username);

  const record = {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    hostname: os.hostname(),
    username: String(username),
    // Keep only the fields we need to safely resume work.
    say: typeof planObj?.say === "string" ? planObj.say : "",
    intent: typeof planObj?.intent === "string" ? planObj.intent : "",
    trigger: typeof planObj?.trigger === "string" ? planObj.trigger : "",
    plan: Array.isArray(planObj?.plan) ? planObj.plan : [],
  };

  // Best-effort: a failed write should not break gameplay.
  try {
    await atomicWriteJson(filePath, record);
  } catch {
    // ignore
  }
}

async function loadLastLLMPlan(username) {
  if (!username) return null;
  const filePath = planFilePath(username);
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    const obj = JSON.parse(txt);
    if (!obj || !Array.isArray(obj.plan)) return null;
    return obj;
  } catch {
    return null;
  }
}

module.exports = {
  stateDir,
  planFilePath,
  saveLastLLMPlan,
  loadLastLLMPlan,
};
