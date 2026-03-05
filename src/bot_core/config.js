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

// ---- Status logging (optional; used if you have status_logger.js wired in) ----
const STATUS_LOG_INTERVAL_MS = parseInt(process.env.STATUS_LOG_INTERVAL_MS || "15000", 10);
const STATUS_LOG_ON_CHANGE = parseBool(process.env.STATUS_LOG_ON_CHANGE, true);
const STATUS_LOG_INCLUDE_GOAL = parseBool(process.env.STATUS_LOG_INCLUDE_GOAL, false);

// ---- Anti-tight-loop pacing (prevents ms=0 loops that cause disconnects) ----
const MIN_STEP_GAP_MS = parseInt(process.env.MIN_STEP_GAP_MS || "200", 10); // minimum delay after any "done" step
const FAST_STEP_MS_THRESHOLD = parseInt(process.env.FAST_STEP_MS_THRESHOLD || "25", 10); // classify as "too fast"
const FAST_STEP_MAX_STREAK = parseInt(process.env.FAST_STEP_MAX_STREAK || "8", 10); // after N fast steps…
const FAST_STEP_BACKOFF_BASE_MS = parseInt(process.env.FAST_STEP_BACKOFF_BASE_MS || "250", 10); // start backoff
const FAST_STEP_BACKOFF_MAX_MS = parseInt(process.env.FAST_STEP_BACKOFF_MAX_MS || "5000", 10); // cap backoff

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
  STATUS_LOG_INTERVAL_MS,
  STATUS_LOG_ON_CHANGE,
  STATUS_LOG_INCLUDE_GOAL,
  MIN_STEP_GAP_MS,
  FAST_STEP_MS_THRESHOLD,
  FAST_STEP_MAX_STREAK,
  FAST_STEP_BACKOFF_BASE_MS,
  FAST_STEP_BACKOFF_MAX_MS,
};
