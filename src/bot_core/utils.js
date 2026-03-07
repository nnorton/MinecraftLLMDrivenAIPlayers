// src/bot_core/utils.js

function dbg(bot, msg, enabled) {
  if (!enabled) return;
  try {
    console.log(`[${bot.username}] ${msg}`);
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeType(t) {
  return String(t || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function isPathfinderPlanningError(msg) {
  const m = String(msg || "");
  return /Took\s+to\s+long\s+to\s+decide\s+path\s+to\s+goal/i.test(m);
}

function isMajorStepType(type) {
  return (
    type === "GATHER_WOOD" ||
    type === "MINE_BLOCKS" ||
    type === "FARM_HARVEST_REPLANT" ||
    type === "BUILD_STRUCTURE" ||
    type === "BUILD_MONUMENT" ||
    type === "BUILD_MONUMENT_COMPLEX" ||
    type === "CRAFT_TOOLS" ||
    type === "SMELT_ORE" ||
    type === "FIGHT_MOBS"
  );
}

function parseInsufficientMaterial(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(
    /Insufficient\s+([a-z0-9_]+):\s*have\s*(\d+),\s*need\s*at\s*least\s*(\d+)/i
  );
  if (!m) return null;
  return {
    material: m[1].toLowerCase(),
    have: parseInt(m[2], 10) || 0,
    need: parseInt(m[3], 10) || 0,
  };
}

function parseMissingBuildComponent(errMsg) {
  const msg = String(errMsg || "");

  let m = msg.match(/Missing\s+build\s+component:\s*([a-z0-9_]+)\s*(?:reason=([a-z0-9_:-]+))?/i);
  if (m) {
    return {
      component: String(m[1] || "").toLowerCase(),
      reason: String(m[2] || "").toLowerCase() || null,
    };
  }

  m = msg.match(/Build\s+incomplete:\s*could\s+not\s+place\s+door\s*\(([^)]+)\)/i);
  if (m) {
    return {
      component: "door",
      reason: String(m[1] || "").toLowerCase(),
    };
  }

  return null;
}

function parseNoPlaceableMaterial(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(/No\s+placeable\s+material\s+found\s+for\s+([a-z0-9_]+)/i);
  if (!m) return null;
  return { kind: String(m[1] || "").toLowerCase() };
}

function parseBuildIncomplete(errMsg) {
  const msg = String(errMsg || "");
  const m = msg.match(
    /Build\s+incomplete:\s*completion\s*(\d+)%\s*\(placed=(\d+)\/(\d+)/i
  );
  if (!m) return null;
  return {
    completionPct: parseInt(m[1], 10) || 0,
    placed: parseInt(m[2], 10) || 0,
    total: parseInt(m[3], 10) || 0,
  };
}

function posObj(bot) {
  const p = bot?.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

module.exports = {
  dbg,
  sleep,
  clamp,
  shortErr,
  normalizeType,
  isPathfinderPlanningError,
  isMajorStepType,
  parseInsufficientMaterial,
  parseMissingBuildComponent,
  parseNoPlaceableMaterial,
  parseBuildIncomplete,
  posObj,
};
