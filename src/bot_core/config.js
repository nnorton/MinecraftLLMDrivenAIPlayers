// src/bot_core/config.js
require("dotenv").config();

function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}

// ---- Controls ----
const AUTONOMY_INTERVAL_MS = 5 * 60 * 1000;
const TASK_TICK_MS = parseInt(process.env.TASK_TICK_MS || "1500", 10);
const COOLDOWN_ON_HUMAN_MS = 1500;
const WANDER_RADIUS = parseInt(process.env.WANDER_RADIUS || "30", 10);

// Mineflayer chunk radius per bot (memory reducer)
const BOT_VIEW_DISTANCE = parseInt(process.env.BOT_VIEW_DISTANCE || "3", 10);

// ---- LLM on/off switch ----
const LLM_ENABLED = parseBool(process.env.LLM_ENABLED, true);

const DEBUG_BOT = String(process.env.DEBUG_BOT || "").toLowerCase() === "true";

// ---- Pathfinder tuning ----
const PATHFINDER_THINK_TIMEOUT_MS = parseInt(
  process.env.PATHFINDER_THINK_TIMEOUT_MS || "10000",
  10
);
const PATHFINDER_ERROR_RETRY_LIMIT = parseInt(
  process.env.PATHFINDER_ERROR_RETRY_LIMIT || "2",
  10
);

// ---- Plan commitment (reduce mid-task plan switching) ----
const PLAN_COMMIT_MS = parseInt(process.env.PLAN_COMMIT_MS || "60000", 10);

// ---- “Always busy” controls ----
const WANDER_MAX_MS = parseInt(process.env.WANDER_MAX_MS || "45000", 10);
const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || "180000", 10);
const STUCK_NO_MOVE_MS = parseInt(process.env.STUCK_NO_MOVE_MS || "35000", 10);

// ---- Extra unstuck tuning ----
const UNSTUCK_COOLDOWN_MS = parseInt(process.env.UNSTUCK_COOLDOWN_MS || "90000", 10);
const GOAL_GRACE_MS = parseInt(process.env.GOAL_GRACE_MS || "8000", 10);
const UNSTUCK_STAGE1_MS = parseInt(process.env.UNSTUCK_STAGE1_MS || "9000", 10);

// ---- Team influence controls ----
const TEAM_PREFIX = "[TEAM]";
const TEAM_EVENT_RATE_MS = 2500;

module.exports = {
  parseBool,
  AUTONOMY_INTERVAL_MS,
  TASK_TICK_MS,
  COOLDOWN_ON_HUMAN_MS,
  WANDER_RADIUS,
  BOT_VIEW_DISTANCE,
  LLM_ENABLED,
  DEBUG_BOT,
  PATHFINDER_THINK_TIMEOUT_MS,
  PATHFINDER_ERROR_RETRY_LIMIT,
  PLAN_COMMIT_MS,
  WANDER_MAX_MS,
  STEP_TIMEOUT_MS,
  STUCK_NO_MOVE_MS,
  UNSTUCK_COOLDOWN_MS,
  GOAL_GRACE_MS,
  UNSTUCK_STAGE1_MS,
  TEAM_PREFIX,
  TEAM_EVENT_RATE_MS,
};
