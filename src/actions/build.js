// src/actions/build.js
// Blueprint-based builder for recognizable structures.
//
// Key changes:
// - Forts/monuments are generated from blueprints (repeatable, sized).
// - Enforces minimum size/height so builds are recognizable.
// - Selects/validates materials (won't "complete" after placing 2 blocks).
// - Validates completion ratio at end; throws on poor completion so planner can recover.

const { goals } = require("mineflayer-pathfinder");
const GoalNear = goals.GoalNear;

// IMPORTANT FIX:
// Mineflayer expects Vec3 instances for positions passed to bot.blockAt() / placeBlock faces.
// The vec3 package exports a factory function that returns a Vec3 with methods like .floored().
const vec3 = require("vec3");
const { getBuildSite, setBuildSite } = require("./memory");

function clampInt(n, lo, hi, fallback) {
  const x = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(lo, Math.min(hi, x));
}

function invCounts(bot) {
  const items = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of items) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return counts;
}

function chooseMaterialFromInventory(bot, preferredList) {
  const counts = invCounts(bot);
  for (const m of preferredList) {
    if ((counts[m] || 0) > 0) return m;
  }
  // If none, pick any placeable "block" item heuristic
  const candidates = Object.entries(counts)
    .filter(([name, count]) => count > 0 && !name.includes("pickaxe") && !name.includes("axe") && !name.includes("shovel"))
    .map(([name]) => name);
  // Try common planks/cobble-ish
  const common =
    candidates.find((n) => n.includes("planks")) ||
    candidates.find((n) => n.includes("stone")) ||
    candidates[0];
  return common || null;
}

function countItem(bot, itemName) {
  const items = bot.inventory?.items?.() || [];
  let c = 0;
  for (const it of items) if (it.name === itemName) c += it.count || 0;
  return c;
}

async function equipBlock(bot, itemName) {
  if (!itemName) throw new Error("No build material available");
  const item = (bot.inventory?.items?.() || []).find((it) => it.name === itemName);
  if (!item) throw new Error(`Missing material: ${itemName}`);
  await bot.equip(item, "hand");
}

function getBaseOrCurrent(bot) {
  // If bot has a known base on bot._base use it; else use current position.
  const p = bot.entity?.position;
  if (!p) return null;
  // Return a REAL Vec3 (not a plain object)
  return vec3(Math.round(p.x), Math.round(p.y), Math.round(p.z));
}

function isSolid(block) {
  if (!block) return false;
  // Mineflayer block shapes vary; "boundingBox" is "block" for solid blocks, "empty" for air.
  return block.boundingBox === "block";
}

function isAir(block) {
  if (!block) return false;
  return block.name === "air" || block.boundingBox === "empty";
}

// Return real Vec3 everywhere
function v(x, y, z) {
  return vec3(x, y, z);
}

function add(a, b) {
  return v(a.x + b.x, a.y + b.y, a.z + b.z);
}

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`;
}

/**
 * Find a build origin near base/current:
 * - expects solid ground and 2 blocks of headroom in footprint
 * - not perfect, but good enough to avoid building inside trees/water most of the time.
 */
function findBuildOrigin(bot, size, maxRadius = 18) {
  const center = getBaseOrCurrent(bot);
  if (!center) throw new Error("Cannot determine build origin (no position)");
  const half = Math.floor(size / 2);
  const yStart = center.y;

  // Scan a small area around the bot for a patch of solid ground with headroom.
  for (let r = 2; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ox = center.x + dx;
        const oz = center.z + dz;

        // Use ground y = highest solid under starting y within small range
        let gy = yStart;
        for (let dy = 0; dy <= 6; dy++) {
          const below = bot.blockAt(v(ox, yStart - dy - 1, oz));
          const feet = bot.blockAt(v(ox, yStart - dy, oz));
          if (isSolid(below) && isAir(feet)) {
            gy = yStart - dy;
            break;
          }
        }

        // Validate footprint
        let ok = true;
        for (let fx = -half; fx <= half && ok; fx++) {
          for (let fz = -half; fz <= half && ok; fz++) {
            const ground = bot.blockAt(v(ox + fx, gy - 1, oz + fz));
            const a1 = bot.blockAt(v(ox + fx, gy, oz + fz));
            const a2 = bot.blockAt(v(ox + fx, gy + 1, oz + fz));
            if (!isSolid(ground) || !isAir(a1) || !isAir(a2)) ok = false;
          }
        }
        if (ok) return v(ox, gy, oz);
      }
    }
  }

  // Fallback: build where the bot is (may be messy)
  return v(center.x, center.y, center.z);
}

/**
 * Validate that an origin is still buildable for a footprint of `size`.
 * If the area is obstructed (trees, water, terrain changes), we recompute.
 */
function isOriginValid(bot, origin, size) {
  if (!origin) return false;
  const half = Math.floor(size / 2);
  // require solid ground and 2 blocks of headroom across footprint
  for (let fx = -half; fx <= half; fx++) {
    for (let fz = -half; fz <= half; fz++) {
      const ground = bot.blockAt(v(origin.x + fx, origin.y - 1, origin.z + fz));
      const a1 = bot.blockAt(v(origin.x + fx, origin.y, origin.z + fz));
      const a2 = bot.blockAt(v(origin.x + fx, origin.y + 1, origin.z + fz));
      if (!isSolid(ground) || !isAir(a1) || !isAir(a2)) return false;
    }
  }
  return true;
}

/**
 * Resolve a fixed build site for a structure kind.
 * - If a site is already stored in memory, use it (if still valid).
 * - Otherwise, compute a site near the bot, store it, and use it consistently across retries and restarts.
 */
function resolveBuildOrigin(bot, siteKey, size) {
  const key = String(siteKey || "FORT").toUpperCase();
  const saved = getBuildSite(bot, key);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z)) {
    const o = v(saved.x, saved.y, saved.z);
    if (isOriginValid(bot, o, size)) return o;
  }

  const computed = findBuildOrigin(bot, size);
  try {
    setBuildSite(bot, key, { x: computed.x, y: computed.y, z: computed.z });
  } catch {}
  return computed;
}

/**
 * Movement helper: get within range of a target block position.
 */
async function moveNear(bot, pos, range = 3) {
  if (!bot.pathfinder) return;
  const goal = new GoalNear(pos.x, pos.y, pos.z, range);
  bot.pathfinder.setGoal(goal);

  // Wait until close enough or timeout
  const timeoutMs = 18000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = bot.entity?.position;
    if (!p) break;
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= range + 0.5) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // don't throw; placement may still work
}

/**
 * Choose an "attach face" for placing a block at target pos.
 * Mineflayer placeBlock requires clicking a neighbor block face.
 */
function findPlaceReference(bot, target) {
  const below = bot.blockAt(v(target.x, target.y - 1, target.z));
  if (isSolid(below)) return { ref: below, face: v(0, 1, 0) };

  // Try 4 sides
  const neighbors = [
    { dx: 1, dz: 0, face: v(-1, 0, 0) },
    { dx: -1, dz: 0, face: v(1, 0, 0) },
    { dx: 0, dz: 1, face: v(0, 0, -1) },
    { dx: 0, dz: -1, face: v(0, 0, 1) },
  ];
  for (const n of neighbors) {
    const b = bot.blockAt(v(target.x + n.dx, target.y, target.z + n.dz));
    if (isSolid(b)) return { ref: b, face: n.face };
  }

  // As a last resort, try the block below-diagonal
  const diag = bot.blockAt(v(target.x + 1, target.y - 1, target.z));
  if (isSolid(diag)) return { ref: diag, face: v(-1, 1, 0) };

  return null;
}

async function placeOne(bot, pos) {
  const existing = bot.blockAt(pos);
  if (existing && !isAir(existing)) return false;

  const ref = findPlaceReference(bot, pos);
  if (!ref) return false;

  await moveNear(bot, pos, 3);
  await bot.placeBlock(ref.ref, ref.face);
  return true;
}

// --- Blueprints ---
function blueprintFort(size, wallH, towerH) {
  const half = Math.floor(size / 2);
  const out = [];

  // floor
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) out.push(v(x, 0, z));
  }

  // walls
  for (let y = 1; y <= wallH; y++) {
    for (let x = -half; x <= half; x++) {
      out.push(v(x, y, -half));
      out.push(v(x, y, half));
    }
    for (let z = -half; z <= half; z++) {
      out.push(v(-half, y, z));
      out.push(v(half, y, z));
    }
  }

  // corner towers
  const corners = [
    v(-half, 1, -half),
    v(-half, 1, half),
    v(half, 1, -half),
    v(half, 1, half),
  ];
  for (const c of corners) {
    for (let y = 1; y <= towerH; y++) out.push(v(c.x, y, c.z));
  }

  // battlements
  const battY = wallH + 1;
  for (let x = -half; x <= half; x += 2) {
    out.push(v(x, battY, -half));
    out.push(v(x, battY, half));
  }
  for (let z = -half; z <= half; z += 2) {
    out.push(v(-half, battY, z));
    out.push(v(half, battY, z));
  }

  // door gap (2 blocks high) on one side
  // Remove door blocks from blueprint (front side z=-half)
  const door = new Set([keyOf(v(0, 1, -half)), keyOf(v(0, 2, -half))]);
  return out.filter((p) => !door.has(keyOf(p)));
}

function blueprintObelisk(height) {
  const out = [];
  for (let y = 0; y < height; y++) out.push(v(0, y, 0));
  // base ring for visibility
  out.push(v(1, 0, 0));
  out.push(v(-1, 0, 0));
  out.push(v(0, 0, 1));
  out.push(v(0, 0, -1));
  return out;
}

async function runBlueprint(bot, origin, blueprint, material, opts = {}) {
  const minComplete = typeof opts.minComplete === "number" ? opts.minComplete : 0.8;
  const minRequiredBlocks = typeof opts.minRequiredBlocks === "number" ? opts.minRequiredBlocks : 80;

  // Pre-check inventory (avoid "placing 2 blocks then claiming done")
  const have = countItem(bot, material);
  const need = blueprint.length;
  const mustHave = Math.min(need, Math.max(minRequiredBlocks, Math.floor(need * 0.6)));
  if (have < mustHave) {
    throw new Error(`Insufficient ${material}: have ${have}, need at least ${mustHave}`);
  }

  await equipBlock(bot, material);

  let placed = 0;
  const total = blueprint.length;

  // Place blocks in a stable order: low->high, near->far
  const sorted = blueprint
    .slice()
    .sort((a, b) => (a.y - b.y) || (Math.abs(a.x) + Math.abs(a.z) - (Math.abs(b.x) + Math.abs(b.z))));

  for (let i = 0; i < sorted.length; i++) {
    const rel = sorted[i];
    const target = add(origin, rel);

    try {
      const ok = await placeOne(bot, target);
      if (ok) placed++;
    } catch {
      // ignore individual failures; we'll validate completion ratio at end
    }

    // small yield
    if (i % 18 === 0) await new Promise((r) => setTimeout(r, 25));
  }

  const ratio = total > 0 ? placed / total : 0;
  if (placed < minRequiredBlocks || ratio < minComplete) {
    throw new Error(`Build incomplete: completion ${Math.round(ratio * 100)}% (placed=${placed}/${total})`);
  }

  return { placed, total, ratio };
}

async function buildFort(bot, params = {}) {
  // Enforce recognizable minimums
  const size = clampInt(params.size, 9, 13, 9);
  const wallH = clampInt(params.height, 4, 8, 4);
  const towerH = clampInt(params.towerHeight, 6, 12, Math.max(6, wallH + 2));

  // Prefer stone-ish materials for forts
  const requested = params.material ? String(params.material) : null;
  const material =
    requested ||
    chooseMaterialFromInventory(bot, ["cobblestone", "stone_bricks", "deepslate", "cobbled_deepslate", "stone", "oak_planks"]);
  if (!material) throw new Error("No placeable material found for fort");

  // ✅ Fixed site:
  // - if params.origin provided, use it
  // - else reuse stored "FORT" site from memory (or compute+store once)
  const origin = params.origin ? v(params.origin.x, params.origin.y, params.origin.z) : resolveBuildOrigin(bot, "FORT", size);

  const blueprint = blueprintFort(size, wallH, towerH);

  // Rough min blocks: ensure it can't "finish" tiny
  const minRequiredBlocks = Math.max(120, Math.floor(blueprint.length * 0.6));
  return runBlueprint(bot, origin, blueprint, material, { minComplete: 0.8, minRequiredBlocks });
}

async function buildMonument(bot, params = {}) {
  // Recognizable minimum height
  const height = clampInt(params.height, 9, 21, 11);

  // Prefer clean blocks
  const requested = params.material ? String(params.material) : null;
  const material =
    requested || chooseMaterialFromInventory(bot, ["stone_bricks", "smooth_stone", "quartz_block", "cobblestone", "stone", "oak_planks"]);
  if (!material) throw new Error("No placeable material found for monument");

  // ✅ Fixed site for monuments too (separate key from fort)
  const origin = params.origin ? v(params.origin.x, params.origin.y, params.origin.z) : resolveBuildOrigin(bot, "MONUMENT", 7); // fixed footprint site

  const blueprint = blueprintObelisk(height);
  const minRequiredBlocks = Math.max(40, Math.floor(blueprint.length * 0.7));
  return runBlueprint(bot, origin, blueprint, material, { minComplete: 0.85, minRequiredBlocks });
}

async function buildMonumentComplex(bot, kind, params = {}) {
  // For now, only OBELISK is implemented with complex wrapper; can add more kinds later.
  const k = String(kind || "OBELISK").toUpperCase();
  if (k !== "OBELISK") {
    // Fall back to obelisk with slightly larger default
    return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
  }
  return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
}

module.exports = { buildFort, buildMonument, buildMonumentComplex };
