// src/actions/build.js
// Deterministic structure builder with simple, realistic blueprints.
//
// Goals:
// - Build repeatable structures that do not look random or misshapen.
// - Prefer simple "best practice" shelter layouts: foundation, walls, doorway, windows, roof.
// - Allow forts to optionally place interior utilities (bed, chest, crafting table, furnace).
// - Keep build sites stable across retries/restarts.

const { goals } = require("mineflayer-pathfinder");
const GoalNear = goals.GoalNear;
const vec3 = require("vec3");
const { getBuildSite, setBuildSite } = require("./memory");

function clampInt(n, lo, hi, fallback) {
  const x = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(lo, Math.min(hi, x));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function v(x, y, z) {
  return vec3(x, y, z);
}

function add(a, b) {
  return v(a.x + b.x, a.y + b.y, a.z + b.z);
}

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`;
}

function toBlockPos(pos) {
  if (!pos) return null;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
  return v(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

function getBaseOrCurrent(bot) {
  const p = bot.entity?.position;
  if (!p) return null;
  return v(Math.round(p.x), Math.round(p.y), Math.round(p.z));
}

function invItems(bot) {
  return bot.inventory?.items?.() || [];
}

function invCounts(bot) {
  const counts = {};
  for (const it of invItems(bot)) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return counts;
}

function countMatchingItems(bot, names) {
  const want = new Set((Array.isArray(names) ? names : [names]).map(String));
  let total = 0;
  for (const it of invItems(bot)) {
    if (want.has(it.name)) total += it.count || 0;
  }
  return total;
}

function hasAnyMatchingItem(bot, names) {
  return countMatchingItems(bot, names) > 0;
}

function findInventoryItem(bot, names) {
  const want = Array.isArray(names) ? names.map(String) : [String(names)];
  for (const name of want) {
    const item = invItems(bot).find((it) => it.name === name);
    if (item) return item;
  }
  return null;
}

async function equipNamedItem(bot, names) {
  const item = findInventoryItem(bot, names);
  if (!item) throw new Error(`Missing item: ${(Array.isArray(names) ? names.join(" or ") : names)}`);
  await bot.equip(item, "hand");
  return item;
}

function chooseMaterialFromInventory(bot, preferredList) {
  const counts = invCounts(bot);
  for (const m of preferredList) {
    if ((counts[m] || 0) > 0) return m;
  }

  const candidates = Object.entries(counts)
    .filter(([name, count]) => {
      if (count <= 0) return false;
      if (/(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(name)) return false;
      if (["stick", "coal", "charcoal", "torch", "wheat_seeds", "bucket"].includes(name)) return false;
      return true;
    })
    .map(([name]) => name);

  const common =
    candidates.find((n) => n.includes("planks")) ||
    candidates.find((n) => n.includes("cobblestone")) ||
    candidates.find((n) => n.includes("stone_bricks")) ||
    candidates.find((n) => n.includes("stone")) ||
    candidates[0];

  return common || null;
}

function isSolid(block) {
  if (!block) return false;
  return block.boundingBox === "block";
}

function isAir(block) {
  if (!block) return false;
  return block.name === "air" || block.boundingBox === "empty";
}

function isReplaceable(block) {
  if (!block) return false;
  return isAir(block) || ["grass", "tall_grass", "fern", "large_fern", "snow", "vine"].includes(block.name);
}

function isWaterLike(block) {
  if (!block) return false;
  return /water|lava/.test(block.name || "");
}

function isOriginValid(bot, origin, size) {
  if (!origin) return false;
  const half = Math.floor(size / 2);
  for (let fx = -half; fx <= half; fx++) {
    for (let fz = -half; fz <= half; fz++) {
      const ground = bot.blockAt(v(origin.x + fx, origin.y - 1, origin.z + fz));
      const a1 = bot.blockAt(v(origin.x + fx, origin.y, origin.z + fz));
      const a2 = bot.blockAt(v(origin.x + fx, origin.y + 1, origin.z + fz));
      if (!isSolid(ground) || isWaterLike(ground) || !isReplaceable(a1) || !isReplaceable(a2)) return false;
    }
  }
  return true;
}

function findBuildOrigin(bot, size, maxRadius = 18) {
  const center = getBaseOrCurrent(bot);
  if (!center) throw new Error("Cannot determine build origin (no position)");
  const half = Math.floor(size / 2);
  const yStart = center.y;

  for (let r = 2; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ox = center.x + dx;
        const oz = center.z + dz;

        let gy = yStart;
        let foundGround = false;
        for (let dy = -2; dy <= 6; dy++) {
          const feetY = yStart - dy;
          const below = bot.blockAt(v(ox, feetY - 1, oz));
          const feet = bot.blockAt(v(ox, feetY, oz));
          if (isSolid(below) && !isWaterLike(below) && isReplaceable(feet)) {
            gy = feetY;
            foundGround = true;
            break;
          }
        }
        if (!foundGround) continue;

        let ok = true;
        for (let fx = -half; fx <= half && ok; fx++) {
          for (let fz = -half; fz <= half && ok; fz++) {
            const ground = bot.blockAt(v(ox + fx, gy - 1, oz + fz));
            const a1 = bot.blockAt(v(ox + fx, gy, oz + fz));
            const a2 = bot.blockAt(v(ox + fx, gy + 1, oz + fz));
            if (!isSolid(ground) || isWaterLike(ground) || !isReplaceable(a1) || !isReplaceable(a2)) ok = false;
          }
        }
        if (ok) return v(ox, gy, oz);
      }
    }
  }

  return v(center.x, center.y, center.z);
}

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

async function moveNear(bot, pos, range = 3) {
  if (!bot.pathfinder) return;
  const goal = new GoalNear(pos.x, pos.y, pos.z, range);
  bot.pathfinder.setGoal(goal);

  const timeoutMs = 18000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = bot.entity?.position;
    if (!p) break;
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= range + 0.5) return;
    await sleep(250);
  }
}

function findPlaceReference(bot, target) {
  const below = bot.blockAt(v(target.x, target.y - 1, target.z));
  if (isSolid(below)) return { ref: below, face: v(0, 1, 0) };

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

  const diag = bot.blockAt(v(target.x + 1, target.y - 1, target.z));
  if (isSolid(diag)) return { ref: diag, face: v(-1, 1, 0) };

  return null;
}

async function placeOne(bot, pos) {
  const existing = bot.blockAt(pos);
  if (existing && !isReplaceable(existing)) return false;

  const ref = findPlaceReference(bot, pos);
  if (!ref) return false;

  await moveNear(bot, pos, 3);
  await bot.placeBlock(ref.ref, ref.face);
  return true;
}

function pushUnique(planSet, out, p) {
  const k = keyOf(p);
  if (planSet.has(k)) return;
  planSet.add(k);
  out.push(p);
}

function removePositions(out, removeSet) {
  return out.filter((p) => !removeSet.has(keyOf(p)));
}

function rectRing(halfX, halfZ, y, push) {
  for (let x = -halfX; x <= halfX; x++) {
    push(v(x, y, -halfZ));
    push(v(x, y, halfZ));
  }
  for (let z = -halfZ; z <= halfZ; z++) {
    push(v(-halfX, y, z));
    push(v(halfX, y, z));
  }
}

function blueprintFort(opts = {}) {
  const size = clampInt(opts.size, 9, 13, 9);
  const wallH = clampInt(opts.height, 4, 6, 4);
  const towerH = clampInt(opts.towerHeight, wallH + 1, wallH + 3, wallH + 2);
  const half = Math.floor(size / 2);
  const inner = Math.max(2, half - 1);
  const out = [];
  const seen = new Set();
  const push = (p) => pushUnique(seen, out, p);

  // Foundation + floor.
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) {
      push(v(x, -1, z));
      push(v(x, 0, z));
    }
  }

  // Main walls.
  for (let y = 1; y <= wallH; y++) rectRing(half, half, y, push);

  // Corner pillars/towers.
  const corners = [
    v(-half, 1, -half),
    v(-half, 1, half),
    v(half, 1, -half),
    v(half, 1, half),
  ];
  for (const c of corners) {
    for (let y = 1; y <= towerH; y++) push(v(c.x, y, c.z));
  }

  // Battlements.
  const battY = wallH + 1;
  for (let x = -half; x <= half; x += 2) {
    push(v(x, battY, -half));
    push(v(x, battY, half));
  }
  for (let z = -half; z <= half; z += 2) {
    push(v(-half, battY, z));
    push(v(half, battY, z));
  }

  // Small roof over the keep interior so the structure reads as intentional.
  for (let x = -inner; x <= inner; x++) {
    for (let z = -inner; z <= inner; z++) {
      if (Math.abs(x) === inner || Math.abs(z) === inner || (Math.abs(x) <= 1 && Math.abs(z) <= 1)) {
        push(v(x, wallH + 1, z));
      }
    }
  }

  // Doorway + arrow slit windows.
  const open = new Set([
    keyOf(v(0, 1, -half)),
    keyOf(v(0, 2, -half)),
    keyOf(v(-2, 2, -half)),
    keyOf(v(2, 2, -half)),
    keyOf(v(-half, 2, 0)),
    keyOf(v(half, 2, 0)),
    keyOf(v(0, 2, half)),
  ]);

  return {
    blocks: removePositions(out, open),
    utility: {
      anchor: v(0, 1, 0),
      bedHead: v(-inner + 1, 1, inner - 1),
      bedFoot: v(-inner + 1, 1, inner),
      chest: v(inner - 1, 1, inner - 1),
      crafting: v(inner - 1, 1, -inner + 1),
      furnace: v(inner - 1, 1, -inner + 2),
    },
    metadata: { size, wallH, towerH, footprint: size },
  };
}

function blueprintHouse(opts = {}) {
  const width = clampInt(opts.width ?? opts.size, 7, 9, 7);
  const depth = clampInt(opts.depth ?? opts.size, 7, 9, 7);
  const wallH = clampInt(opts.height, 3, 4, 3);
  const halfX = Math.floor(width / 2);
  const halfZ = Math.floor(depth / 2);
  const out = [];
  const seen = new Set();
  const push = (p) => pushUnique(seen, out, p);

  // Foundation + floor.
  for (let x = -halfX; x <= halfX; x++) {
    for (let z = -halfZ; z <= halfZ; z++) {
      push(v(x, -1, z));
      push(v(x, 0, z));
    }
  }

  for (let y = 1; y <= wallH; y++) rectRing(halfX, halfZ, y, push);

  // Simple gable-ish stepped roof.
  let roofY = wallH + 1;
  for (let inset = 0; inset <= Math.floor(Math.min(width, depth) / 4); inset++) {
    for (let x = -halfX + inset; x <= halfX - inset; x++) {
      push(v(x, roofY, -halfZ + inset));
      push(v(x, roofY, halfZ - inset));
    }
    for (let z = -halfZ + inset; z <= halfZ - inset; z++) {
      push(v(-halfX + inset, roofY, z));
      push(v(halfX - inset, roofY, z));
    }
    roofY++;
  }

  // Cap so the roof is closed.
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) push(v(x, roofY - 1, z));
  }

  const open = new Set([
    keyOf(v(0, 1, -halfZ)),
    keyOf(v(0, 2, -halfZ)),
    keyOf(v(-2, 2, 0)),
    keyOf(v(2, 2, 0)),
    keyOf(v(0, 2, halfZ)),
  ]);

  return {
    blocks: removePositions(out, open),
    utility: {
      anchor: v(0, 1, 0),
      bedHead: v(-halfX + 1, 1, halfZ - 1),
      bedFoot: v(-halfX + 2, 1, halfZ - 1),
      chest: v(halfX - 1, 1, halfZ - 1),
      crafting: v(halfX - 1, 1, -halfZ + 1),
      furnace: v(halfX - 1, 1, -halfZ + 2),
    },
    metadata: { width, depth, wallH, footprint: Math.max(width, depth) },
  };
}

function blueprintObelisk(height) {
  const out = [];
  for (let y = 0; y < height; y++) out.push(v(0, y, 0));
  out.push(v(1, 0, 0));
  out.push(v(-1, 0, 0));
  out.push(v(0, 0, 1));
  out.push(v(0, 0, -1));
  return out;
}

function getStructurePlan(kind, params = {}) {
  const k = String(kind || params.kind || "FORT").toUpperCase();
  if (k === "HOUSE" || k === "HUT" || k === "CABIN") return blueprintHouse(params);
  return blueprintFort(params);
}

function getUtilityOptions(params = {}) {
  const includeBed = params.includeBed ?? params.includeUtilities ?? false;
  const includeStorage = params.includeStorage ?? params.includeUtilities ?? false;
  const includeCrafting = params.includeCrafting ?? params.includeUtilities ?? false;
  const includeFurnace = params.includeFurnace ?? params.includeUtilities ?? false;

  return {
    includeBed: !!includeBed,
    includeStorage: !!includeStorage,
    includeCrafting: !!includeCrafting,
    includeFurnace: !!includeFurnace,
  };
}

async function runBlueprint(bot, origin, blueprint, material, opts = {}) {
  const minComplete = typeof opts.minComplete === "number" ? opts.minComplete : 0.8;
  const minRequiredBlocks = typeof opts.minRequiredBlocks === "number" ? opts.minRequiredBlocks : 80;

  const have = countMatchingItems(bot, [material]);
  const need = blueprint.length;
  const mustHave = Math.min(need, Math.max(minRequiredBlocks, Math.floor(need * 0.65)));
  if (have < mustHave) {
    throw new Error(`Insufficient ${material}: have ${have}, need at least ${mustHave}`);
  }

  await equipNamedItem(bot, [material]);

  let placed = 0;
  const sorted = blueprint
    .slice()
    .sort((a, b) => (a.y - b.y) || ((Math.abs(a.x) + Math.abs(a.z)) - (Math.abs(b.x) + Math.abs(b.z))));

  for (let i = 0; i < sorted.length; i++) {
    const target = add(origin, sorted[i]);
    try {
      const ok = await placeOne(bot, target);
      if (ok) placed++;
    } catch {}
    if (i % 18 === 0) await sleep(25);
  }

  const ratio = need > 0 ? placed / need : 0;
  if (placed < minRequiredBlocks || ratio < minComplete) {
    throw new Error(`Build incomplete: completion ${Math.round(ratio * 100)}% (placed=${placed}/${need})`);
  }

  return { placed, total: need, ratio };
}

async function orientAndPlaceUtility(bot, pos, itemNames, opts = {}) {
  const target = toBlockPos(pos);
  if (!target) return { ok: false, reason: "invalid_target" };

  const existing = bot.blockAt(target);
  if (existing && !isReplaceable(existing)) return { ok: true, reason: "already_filled", placed: false };

  try {
    await equipNamedItem(bot, itemNames);
  } catch {
    return { ok: false, reason: "missing_item" };
  }

  try {
    if (opts.lookAt) {
      try {
        await bot.lookAt(opts.lookAt, true);
        await sleep(50);
      } catch {}
    }
    const placed = await placeOne(bot, target);
    return { ok: placed, reason: placed ? "placed" : "blocked", placed };
  } catch {
    return { ok: false, reason: "place_failed" };
  }
}

async function placeUtilities(bot, origin, structurePlan, params = {}) {
  const util = structurePlan?.utility;
  if (!util) return { placed: [], skipped: [] };

  const options = getUtilityOptions(params);
  const placed = [];
  const skipped = [];

  if (options.includeBed) {
    const bedNames = [
      "white_bed", "red_bed", "blue_bed", "green_bed", "yellow_bed", "black_bed",
      "gray_bed", "light_gray_bed", "brown_bed", "purple_bed", "cyan_bed", "pink_bed",
      "orange_bed", "lime_bed", "light_blue_bed", "magenta_bed"
    ];
    // Beds place relative to facing direction; look toward bed foot so the head extends inward.
    const bedHead = add(origin, util.bedHead);
    const bedFoot = add(origin, util.bedFoot);
    const lookAtPos = v(bedHead.x + 0.5, bedHead.y, bedHead.z + 0.5);
    const res = await orientAndPlaceUtility(bot, bedFoot, bedNames, { lookAt: lookAtPos });
    (res.ok ? placed : skipped).push({ type: "bed", reason: res.reason });
  }

  if (options.includeStorage) {
    const res = await orientAndPlaceUtility(bot, add(origin, util.chest), ["chest"]);
    (res.ok ? placed : skipped).push({ type: "storage", reason: res.reason });
  }

  if (options.includeCrafting) {
    const res = await orientAndPlaceUtility(bot, add(origin, util.crafting), ["crafting_table"]);
    (res.ok ? placed : skipped).push({ type: "crafting", reason: res.reason });
  }

  if (options.includeFurnace) {
    const res = await orientAndPlaceUtility(bot, add(origin, util.furnace), ["furnace"]);
    (res.ok ? placed : skipped).push({ type: "furnace", reason: res.reason });
  }

  return { placed, skipped };
}

async function buildStructure(bot, params = {}) {
  const kind = String(params.kind || "FORT").toUpperCase();
  const structurePlan = getStructurePlan(kind, params);

  const requested = params.material ? String(params.material) : null;
  const preferredByKind =
    kind === "HOUSE" || kind === "HUT" || kind === "CABIN"
      ? ["oak_planks", "spruce_planks", "birch_planks", "cobblestone", "stone_bricks", "stone"]
      : ["cobblestone", "stone_bricks", "cobbled_deepslate", "deepslate", "stone", "oak_planks"];

  const material = requested || chooseMaterialFromInventory(bot, preferredByKind);
  if (!material) throw new Error(`No placeable material found for ${kind.toLowerCase()}`);

  const footprint = clampInt(structurePlan?.metadata?.footprint, 7, 15, 9);
  const siteKey = kind === "HOUSE" || kind === "HUT" || kind === "CABIN" ? "HOUSE" : kind;
  const origin = params.origin
    ? v(params.origin.x, params.origin.y, params.origin.z)
    : resolveBuildOrigin(bot, siteKey, footprint);

  const minRequiredBlocks = Math.max(kind === "FORT" ? 110 : 70, Math.floor(structurePlan.blocks.length * 0.62));
  const buildRes = await runBlueprint(bot, origin, structurePlan.blocks, material, {
    minComplete: kind === "FORT" ? 0.82 : 0.8,
    minRequiredBlocks,
  });

  const utilities = await placeUtilities(bot, origin, structurePlan, params);
  return { ...buildRes, kind, material, utilities };
}

async function buildFort(bot, params = {}) {
  return buildStructure(bot, { ...params, kind: params.kind || "FORT" });
}

async function buildMonument(bot, params = {}) {
  const height = clampInt(params.height, 9, 21, 11);
  const requested = params.material ? String(params.material) : null;
  const material =
    requested || chooseMaterialFromInventory(bot, ["stone_bricks", "smooth_stone", "quartz_block", "cobblestone", "stone", "oak_planks"]);
  if (!material) throw new Error("No placeable material found for monument");

  const origin = params.origin ? v(params.origin.x, params.origin.y, params.origin.z) : resolveBuildOrigin(bot, "MONUMENT", 7);
  const blueprint = blueprintObelisk(height);
  const minRequiredBlocks = Math.max(40, Math.floor(blueprint.length * 0.7));
  return runBlueprint(bot, origin, blueprint, material, { minComplete: 0.85, minRequiredBlocks });
}

async function buildMonumentComplex(bot, kind, params = {}) {
  const k = String(kind || "OBELISK").toUpperCase();
  if (k !== "OBELISK") {
    return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
  }
  return buildMonument(bot, { ...params, height: clampInt(params.height, 11, 25, 13) });
}

module.exports = {
  buildStructure,
  buildFort,
  buildMonument,
  buildMonumentComplex,
};
