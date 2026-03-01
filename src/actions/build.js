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

  // Try above (rarely useful)
  const above = bot.blockAt(v(target.x, target.y + 1, target.z));
  if (isSolid(above)) return { ref: above, face: v(0, -1, 0) };

  return null;
}

async function placeOne(bot, target, material) {
  const blockAtTarget = bot.blockAt(target);
  if (!blockAtTarget) return { ok: false, reason: "no_blockAt" };
  if (!isAir(blockAtTarget)) return { ok: true, skipped: true };

  const ref = findPlaceReference(bot, target);
  if (!ref) return { ok: false, reason: "no_reference_face" };

  // Move close so placeBlock succeeds
  await moveNear(bot, target, 3);

  // Ensure holding block
  await equipBlock(bot, material);

  try {
    await bot.placeBlock(ref.ref, ref.face);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * Blueprint generators
 * Return array of placements: { pos:{x,y,z}, material?:string, tag?:string }
 * Positions are relative to origin (origin is center at floor level y).
 */

// Fort: odd size (9/11/13). Walls height >=4. Corner towers height >=6.
// Includes:
// - perimeter walls
// - gate opening on +Z side (2-wide)
// - corner towers
// - optional floor (1 layer) for recognizability
function blueprintFort(size, wallH, towerH) {
  const half = Math.floor(size / 2);
  const placements = [];
  const floorY = 0; // origin y is floor level where bot stands (air). Ground is y-1.

  // Floor (optional but makes it readable)
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) {
      placements.push({ pos: v(x, floorY, z), tag: "floor" });
    }
  }

  // Walls
  for (let y = 1; y <= wallH; y++) {
    for (let x = -half; x <= half; x++) {
      // north/south
      placements.push({ pos: v(x, y, -half), tag: "wall" });
      placements.push({ pos: v(x, y, half), tag: "wall" });
    }
    for (let z = -half; z <= half; z++) {
      placements.push({ pos: v(-half, y, z), tag: "wall" });
      placements.push({ pos: v(half, y, z), tag: "wall" });
    }
  }

  // Gate opening on +Z wall (2-wide, 2-high)
  const gateX1 = -1;
  const gateX2 = 0;
  for (let y = 1; y <= 2; y++) {
    // remove placements at these coords by filtering later
    // We'll mark as "gate_void" and filter out.
    placements.push({ pos: v(gateX1, y, half), tag: "gate_void" });
    placements.push({ pos: v(gateX2, y, half), tag: "gate_void" });
  }

  // Towers (corners)
  const corners = [v(-half, 1, -half), v(half, 1, -half), v(-half, 1, half), v(half, 1, half)];
  for (const c of corners) {
    for (let y = 1; y <= towerH; y++) {
      // 2x2 tower footprint anchored at corner inward
      const sx = c.x === -half ? -half : half - 1;
      const sz = c.z === -half ? -half : half - 1;
      placements.push({ pos: v(sx, y, sz), tag: "tower" });
      placements.push({ pos: v(sx + 1, y, sz), tag: "tower" });
      placements.push({ pos: v(sx, y, sz + 1), tag: "tower" });
      placements.push({ pos: v(sx + 1, y, sz + 1), tag: "tower" });
    }
  }

  // Battlements (simple crenellation)
  const topY = wallH + 1;
  for (let x = -half; x <= half; x += 2) {
    placements.push({ pos: v(x, topY, -half), tag: "battlement" });
    placements.push({ pos: v(x, topY, half), tag: "battlement" });
  }
  for (let z = -half; z <= half; z += 2) {
    placements.push({ pos: v(-half, topY, z), tag: "battlement" });
    placements.push({ pos: v(half, topY, z), tag: "battlement" });
  }

  // Filter out gate voids from wall placements
  const voidKeys = new Set(placements.filter((p) => p.tag === "gate_void").map((p) => keyOf(p.pos)));
  const filtered = placements.filter((p) => p.tag !== "gate_void" && !voidKeys.has(keyOf(p.pos)));
  return filtered;
}

// Obelisk: 3x3 base pedestal + tall 1x1 pillar with cap
function blueprintObelisk(height) {
  const placements = [];

  // Pedestal 3x3 x 2 high
  for (let y = 0; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        placements.push({ pos: v(x, y, z), tag: "pedestal" });
      }
    }
  }

  // Pillar
  for (let y = 2; y < height + 2; y++) {
    placements.push({ pos: v(0, y, 0), tag: "pillar" });
  }

  // Cap (cross)
  const capY = height + 2;
  placements.push({ pos: v(0, capY, 0), tag: "cap" });
  placements.push({ pos: v(1, capY, 0), tag: "cap" });
  placements.push({ pos: v(-1, capY, 0), tag: "cap" });
  placements.push({ pos: v(0, capY, 1), tag: "cap" });
  placements.push({ pos: v(0, capY, -1), tag: "cap" });

  return placements;
}

/**
 * Build runner for any blueprint list.
 * - material: single material for all blocks (simple + recognizable)
 * - enforces min placed ratio, otherwise throws
 */
async function runBlueprint(bot, origin, placements, material, opts = {}) {
  const minComplete = Number.isFinite(opts.minComplete) ? opts.minComplete : 0.8;

  // Place from bottom to top, for stability
  const sorted = placements.slice().sort((a, b) => {
    if (a.pos.y !== b.pos.y) return a.pos.y - b.pos.y;
    if (a.pos.x !== b.pos.x) return a.pos.x - b.pos.x;
    return a.pos.z - b.pos.z;
  });

  const totalNeeded = sorted.length;
  const available = countItem(bot, material);
  if (available < Math.min(totalNeeded, opts.minRequiredBlocks || 0)) {
    throw new Error(`Insufficient ${material}: have ${available}, need at least ${opts.minRequiredBlocks || 0}`);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  // Walk to origin first (helps reduce scattered placements)
  await moveNear(bot, origin, 3);

  for (const p of sorted) {
    const abs = add(origin, p.pos);
    const res = await placeOne(bot, abs, material);
    if (res.ok) {
      if (res.skipped) skipped++;
      else ok++;
    } else {
      failed++;
      // If too many consecutive failures, bail early so planner can recover.
      if (failed >= 15) break;
      // Small delay to let pathfinder settle
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // Validate by checking world blocks at expected coordinates
  let present = 0;
  for (const p of sorted) {
    const abs = add(origin, p.pos);
    const b = bot.blockAt(abs);
    if (b && b.name === material) present++;
  }

  const completion = present / Math.max(1, totalNeeded);
  if (completion < minComplete) {
    throw new Error(
      `Build incomplete: completion ${(completion * 100).toFixed(0)}% (placed=${present}/${totalNeeded}, ok=${ok}, skipped=${skipped}, failed=${failed})`
    );
  }

  return { ok, skipped, failed, present, total: totalNeeded, completion };
}

/** Public build APIs used by bot.js */
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

  const origin = findBuildOrigin(bot, size);
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

  const origin = findBuildOrigin(bot, 7); // small footprint scan
  const blueprint = blueprintObelisk(height);
  const minRequiredBlocks = Math.max(30, Math.floor(blueprint.length * 0.8));
  return runBlueprint(bot, origin, blueprint, material, { minComplete: 0.85, minRequiredBlocks });
}

async function buildMonumentComplex(bot, kind = "OBELISK", params = {}) {
  // For now, OBELISK is the “complex” option; can add ARCH/SPIRAL_TOWER/SHRINE later.
  const k = String(kind || "OBELISK").toUpperCase();
  if (k !== "OBELISK") {
    // Fall back to obelisk with slightly larger default
    return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
  }
  return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
}

module.exports = { buildFort, buildMonument, buildMonumentComplex };
