// src/actions/memory.js
const fs = require("fs");
const path = require("path");

const MEM_DIR = path.join(process.cwd(), "mem");
if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });

function memPath(botName) {
  return path.join(MEM_DIR, `${botName}.json`);
}

function defaultMemory() {
  return {
    base: null,
    build_sites: {},
    storage: { chest: null },
    structures: [],
    farms: [],
    activity: {
      buildsCompleted: 0,
      farmsStarted: 0,
      harvestRuns: 0,
      lastStructureKind: null,
      lastFarmCrops: [],
      updatedAt: null,
    },
  };
}

function normalizeMemoryShape(maybeMem) {
  const mem = maybeMem && typeof maybeMem === "object" ? maybeMem : defaultMemory();

  if (!("base" in mem)) mem.base = null;
  if (!mem.build_sites || typeof mem.build_sites !== "object") mem.build_sites = {};
  if (!mem.storage || typeof mem.storage !== "object") mem.storage = { chest: null };
  if (!("chest" in mem.storage)) mem.storage.chest = null;
  if (!Array.isArray(mem.structures)) mem.structures = [];
  if (!Array.isArray(mem.farms)) mem.farms = [];
  if (!mem.activity || typeof mem.activity !== "object") mem.activity = defaultMemory().activity;

  if (!Number.isFinite(mem.activity.buildsCompleted)) mem.activity.buildsCompleted = 0;
  if (!Number.isFinite(mem.activity.farmsStarted)) mem.activity.farmsStarted = 0;
  if (!Number.isFinite(mem.activity.harvestRuns)) mem.activity.harvestRuns = 0;
  if (!Array.isArray(mem.activity.lastFarmCrops)) mem.activity.lastFarmCrops = [];
  if (!("lastStructureKind" in mem.activity)) mem.activity.lastStructureKind = null;
  if (!("updatedAt" in mem.activity)) mem.activity.updatedAt = null;

  return mem;
}

function loadMemory(botName) {
  const p = memPath(botName);
  if (!fs.existsSync(p)) return defaultMemory();
  try {
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeMemoryShape(m);
  } catch {
    return defaultMemory();
  }
}

function saveMemory(botName, mem) {
  const normalized = normalizeMemoryShape(mem);
  normalized.activity.updatedAt = new Date().toISOString();
  fs.writeFileSync(memPath(botName), JSON.stringify(normalized, null, 2));
}

function toBlockPos(pos) {
  if (!pos) return null;
  const x = Number.isFinite(pos.x) ? Math.floor(pos.x) : null;
  const y = Number.isFinite(pos.y) ? Math.floor(pos.y) : null;
  const z = Number.isFinite(pos.z) ? Math.floor(pos.z) : null;
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function samePos(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function nearPos(a, b, radius = 4) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= radius && Math.abs(a.y - b.y) <= 2 && Math.abs(a.z - b.z) <= radius;
}

function compactPos(p) {
  if (!p) return "unknown";
  return `${p.x},${p.y},${p.z}`;
}

function uniqStrings(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "").trim()).filter(Boolean))];
}

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

function getStorageChest(bot) {
  const mem = loadMemory(bot.username);
  const p = mem.storage?.chest;
  if (!p) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return p;
}

function setStorageChest(bot, posOverride) {
  const mem = loadMemory(bot.username);
  const pos = posOverride ? posOverride : bot.entity?.position;
  const p = toBlockPos(pos);
  if (!p) return null;
  if (!mem.storage || typeof mem.storage !== "object") mem.storage = { chest: null };
  mem.storage.chest = p;
  saveMemory(bot.username, mem);
  return p;
}

function recordStructure(bot, details = {}) {
  const mem = loadMemory(bot.username);
  const pos = toBlockPos(details.pos || bot.entity?.position);
  const kind = String(details.kind || "STRUCTURE").trim().toUpperCase();
  const material = details.material ? String(details.material).trim() : null;
  const size = Number.isFinite(details.size) ? Math.floor(details.size) : null;
  const height = Number.isFinite(details.height) ? Math.floor(details.height) : null;
  const utilities = uniqStrings(details.utilities || []);
  const now = new Date().toISOString();

  const existing = mem.structures.find(
    (s) => String(s?.kind || "").toUpperCase() === kind && (samePos(s.pos, pos) || nearPos(s.pos, pos, 5))
  );

  if (existing) {
    existing.pos = pos || existing.pos || null;
    existing.material = material || existing.material || null;
    existing.size = size || existing.size || null;
    existing.height = height || existing.height || null;
    existing.utilities = uniqStrings([...(existing.utilities || []), ...utilities]);
    existing.lastBuiltAt = now;
    existing.timesBuilt = Number.isFinite(existing.timesBuilt) ? existing.timesBuilt + 1 : 2;
  } else {
    mem.structures.push({
      kind,
      pos,
      material,
      size,
      height,
      utilities,
      firstBuiltAt: now,
      lastBuiltAt: now,
      timesBuilt: 1,
    });
  }

  mem.structures = mem.structures.slice(-12);
  mem.activity.buildsCompleted += 1;
  mem.activity.lastStructureKind = kind;
  saveMemory(bot.username, mem);
  return mem.structures[mem.structures.length - 1] || existing || null;
}

function recordFarm(bot, details = {}) {
  const mem = loadMemory(bot.username);
  const pos = toBlockPos(details.pos || bot.entity?.position);
  const crops = uniqStrings(details.crops || (details.crop ? [details.crop] : []));
  const size = Number.isFinite(details.size) ? Math.floor(details.size) : null;
  const mode = String(details.mode || "farm").trim().toLowerCase();
  const now = new Date().toISOString();

  const existing = mem.farms.find((f) => samePos(f.pos, pos) || nearPos(f.pos, pos, 6));
  if (existing) {
    existing.pos = pos || existing.pos || null;
    existing.crops = uniqStrings([...(existing.crops || []), ...crops]);
    existing.size = size || existing.size || null;
    existing.lastWorkedAt = now;
    existing.mode = mode || existing.mode || "farm";
    existing.timesWorked = Number.isFinite(existing.timesWorked) ? existing.timesWorked + 1 : 2;
  } else {
    mem.farms.push({
      pos,
      crops,
      size,
      mode,
      firstWorkedAt: now,
      lastWorkedAt: now,
      timesWorked: 1,
    });
  }

  mem.farms = mem.farms.slice(-10);
  if (mode === "create" || mode === "farm") mem.activity.farmsStarted += 1;
  if (mode === "harvest") mem.activity.harvestRuns += 1;
  mem.activity.lastFarmCrops = crops;
  saveMemory(bot.username, mem);
  return mem.farms[mem.farms.length - 1] || existing || null;
}

function getWorldSummary(bot) {
  const mem = loadMemory(bot.username);
  const lines = [];

  if (mem.base) lines.push(`Base: ${compactPos(mem.base)}`);
  if (mem.storage?.chest) lines.push(`Storage chest: ${compactPos(mem.storage.chest)}`);

  const structureBits = (mem.structures || []).slice(-6).map((s) => {
    const parts = [String(s.kind || "STRUCTURE").toUpperCase()];
    if (s.size) parts.push(`size=${s.size}`);
    if (s.height) parts.push(`height=${s.height}`);
    if (s.material) parts.push(`material=${s.material}`);
    if (Array.isArray(s.utilities) && s.utilities.length) parts.push(`utilities=${s.utilities.join("/")}`);
    if (s.pos) parts.push(`at ${compactPos(s.pos)}`);
    return parts.join(" ");
  });
  if (structureBits.length) lines.push(`Built structures: ${structureBits.join("; ")}`);

  const farmBits = (mem.farms || []).slice(-4).map((f) => {
    const parts = [];
    if (Array.isArray(f.crops) && f.crops.length) parts.push(f.crops.join("/"));
    else parts.push("unknown_crops");
    if (f.size) parts.push(`size=${f.size}`);
    if (f.mode) parts.push(`mode=${f.mode}`);
    if (f.pos) parts.push(`at ${compactPos(f.pos)}`);
    return parts.join(" ");
  });
  if (farmBits.length) lines.push(`Known farms: ${farmBits.join("; ")}`);

  const siteEntries = Object.entries(mem.build_sites || {});
  if (siteEntries.length) {
    lines.push(
      `Reserved build sites: ${siteEntries
        .slice(0, 6)
        .map(([k, p]) => `${k}@${compactPos(p)}`)
        .join(", ")}`
    );
  }

  const act = mem.activity || {};
  const stats = [];
  if (Number.isFinite(act.buildsCompleted)) stats.push(`buildsCompleted=${act.buildsCompleted}`);
  if (Number.isFinite(act.farmsStarted)) stats.push(`farmsStarted=${act.farmsStarted}`);
  if (Number.isFinite(act.harvestRuns)) stats.push(`harvestRuns=${act.harvestRuns}`);
  if (act.lastStructureKind) stats.push(`lastStructure=${act.lastStructureKind}`);
  if (Array.isArray(act.lastFarmCrops) && act.lastFarmCrops.length) stats.push(`lastFarmCrops=${act.lastFarmCrops.join("/")}`);
  if (stats.length) lines.push(`Progress memory: ${stats.join(", ")}`);

  return lines;
}

module.exports = {
  loadMemory,
  saveMemory,
  setBase,
  getBase,
  setBuildSite,
  getBuildSite,
  clearBuildSite,
  getStorageChest,
  setStorageChest,
  recordStructure,
  recordFarm,
  getWorldSummary,
};
