// src/actions/memory.js
const fs = require("fs");
const path = require("path");

const MEM_DIR = path.join(process.cwd(), "mem");
if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });

function memPath(botName) {
  return path.join(MEM_DIR, `${botName}.json`);
}

function loadMemory(botName) {
  const p = memPath(botName);
  if (!fs.existsSync(p)) return { base: null, build_sites: {} };
  try {
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!m || typeof m !== "object") return { base: null, build_sites: {} };
    if (!m.build_sites || typeof m.build_sites !== "object") m.build_sites = {};
    if (!("base" in m)) m.base = null;
    return m;
  } catch {
    return { base: null, build_sites: {} };
  }
}

function saveMemory(botName, mem) {
  fs.writeFileSync(memPath(botName), JSON.stringify(mem, null, 2));
}

function toBlockPos(pos) {
  if (!pos) return null;
  const x = Number.isFinite(pos.x) ? Math.floor(pos.x) : null;
  const y = Number.isFinite(pos.y) ? Math.floor(pos.y) : null;
  const z = Number.isFinite(pos.z) ? Math.floor(pos.z) : null;
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/**
 * Set the bot's "base" position.
 * Compatible with older callers:
 * - setBase(bot) uses bot.entity.position
 * - setBase(bot, {x,y,z}) uses the provided position
 */
function setBase(bot, posOverride) {
  const mem = loadMemory(bot.username);
  const pos = posOverride ? posOverride : bot.entity?.position;
  const p = toBlockPos(pos);
  if (!p) return null;
  mem.base = p;
  saveMemory(bot.username, mem);
  return mem.base;
}

function getBase(bot) {
  const mem = loadMemory(bot.username);
  return mem.base;
}

/**
 * Fixed build sites (persist across restarts).
 * Keys are strings like "FORT", "MONUMENT".
 */
function setBuildSite(bot, key, posOverride) {
  const mem = loadMemory(bot.username);
  const k = String(key || "").trim().toUpperCase();
  if (!k) return null;

  const pos = posOverride ? posOverride : bot.entity?.position;
  const p = toBlockPos(pos);
  if (!p) return null;

  mem.build_sites[k] = p;
  saveMemory(bot.username, mem);
  return p;
}

function getBuildSite(bot, key) {
  const mem = loadMemory(bot.username);
  const k = String(key || "").trim().toUpperCase();
  if (!k) return null;
  const p = mem.build_sites?.[k];
  if (!p) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return p;
}

function clearBuildSite(bot, key) {
  const mem = loadMemory(bot.username);
  const k = String(key || "").trim().toUpperCase();
  if (!k) return false;
  if (!mem.build_sites || typeof mem.build_sites !== "object") mem.build_sites = {};
  delete mem.build_sites[k];
  saveMemory(bot.username, mem);
  return true;
}

module.exports = {
  loadMemory,
  saveMemory,
  setBase,
  getBase,
  setBuildSite,
  getBuildSite,
  clearBuildSite,
};
