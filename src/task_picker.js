// src/task_picker.js
// Deterministic, non-LLM task selection for keeping bots productive.
// ✅ Key upgrade: if a recent build failed due to insufficient materials or incomplete build,
// the bot will STOCKPILE building blocks (mine stone -> cobblestone) before retrying the build.

const { recentFailuresFor } = require("./team_bus");

function normalizeType(t) {
  return String(t || "").trim().toUpperCase();
}

function invCounts(bot) {
  const items = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of items) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return counts;
}

function countOf(counts, name) {
  return counts[name] || 0;
}

function hasAny(counts, names) {
  for (const n of names) if ((counts[n] || 0) > 0) return true;
  return false;
}

function hasPickaxe(counts) {
  return hasAny(counts, ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"]);
}

function hasAxe(counts) {
  return hasAny(counts, ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe"]);
}

function hasFood(counts) {
  // lightweight heuristic
  return Object.keys(counts).some(
    (k) =>
      k.includes("bread") ||
      k.includes("cooked") ||
      k.includes("apple") ||
      k.includes("carrot") ||
      k.includes("potato")
  );
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function lastBuildFailure(bot) {
  // Look back 15 minutes for failures
  let fails = [];
  try {
    fails = recentFailuresFor(bot.username, 15 * 60 * 1000, 10) || [];
  } catch {
    return null;
  }
  if (!fails.length) return null;

  // Find the most recent build-related failure
  for (let i = fails.length - 1; i >= 0; i--) {
    const f = fails[i];
    const d = f?.data && typeof f.data === "object" ? f.data : null;
    const type = normalizeType(d?.type || f?.type || "");
    const reason = String(d?.reason || f?.reason || "").toLowerCase();

    const isBuildType =
      type.includes("BUILD") ||
      type === "BUILD_STRUCTURE" ||
      type === "BUILD_MONUMENT" ||
      type === "BUILD_MONUMENT_COMPLEX";

    if (!isBuildType) continue;

    const insufficient =
      reason.includes("insufficient") ||
      reason.includes("missing material") ||
      reason.includes("no build material") ||
      reason.includes("no placeable material") ||
      reason.includes("need at least");

    const incomplete =
      reason.includes("incomplete") ||
      reason.includes("completion") ||
      reason.includes("no_reference_face");

    return {
      ts: f.ts,
      type,
      reason,
      insufficient,
      incomplete,
    };
  }

  return null;
}

function shouldStockpileForBuild(failure) {
  if (!failure) return false;
  // If build failed for lack of materials OR incomplete structure, stockpile to stabilize the retry.
  return Boolean(failure.insufficient || failure.incomplete);
}

function buildRetryTask(bot, counts) {
  // If we have enough blocks, retry a recognizable build.
  // Our build.js uses minimums; for forts it needs a lot of blocks to look good.
  const cobble = countOf(counts, "cobblestone");
  const stoneBricks = countOf(counts, "stone_bricks");
  const planks =
    Object.entries(counts)
      .filter(([k]) => k.endsWith("_planks"))
      .reduce((a, [, v]) => a + v, 0) || 0;

  const bestMaterial =
    stoneBricks >= 160 ? "stone_bricks" : cobble >= 160 ? "cobblestone" : planks >= 200 ? "oak_planks" : null;

  if (!bestMaterial) return null;

  // Retry a standard fort. (You can tune size/height defaults here.)
  return { type: "BUILD_STRUCTURE", kind: "FORT", size: 9, height: 4, material: bestMaterial };
}

function stockpileBuildingBlocksTask(bot, counts) {
  // Mine stone to get cobblestone (and optionally coal for torches/smelting).
  // If no pickaxe, craft first.
  if (!hasPickaxe(counts)) return { type: "CRAFT_TOOLS" };

  // If we already have decent cobble, mine iron/coal instead for progression.
  const cobble = countOf(counts, "cobblestone");
  if (cobble >= 160) {
    return { type: "MINE_BLOCKS", targets: ["iron_ore", "coal_ore", "stone"], count: 18 };
  }

  // Stockpile aggressively
  return { type: "MINE_BLOCKS", targets: ["stone", "coal_ore"], count: 36 };
}

function generalProductiveTask(bot, counts) {
  // Basic survival / progression heuristics.

  // If hungry and not holding food, regroup / do safe work
  if (bot.food != null && bot.food <= 8 && !hasFood(counts)) {
    return { type: "RETURN_BASE" };
  }

  // If missing tools, craft then gather wood
  if (!hasPickaxe(counts) || !hasAxe(counts)) {
    return hasAxe(counts) ? { type: "CRAFT_TOOLS" } : { type: "GATHER_WOOD", count: 12 };
  }

  // Prefer mining -> smelt loop
  const ironOre = countOf(counts, "iron_ore");
  const rawIron = countOf(counts, "raw_iron");
  const coal = countOf(counts, "coal");

  if (ironOre + rawIron >= 10 || coal >= 8) {
    // If we already have ore/coal, try smelting
    return { type: "SMELT_ORE" };
  }

  // Otherwise mine for coal/iron/stone
  return { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 14 };
}

function pickNextTask(bot) {
  const counts = invCounts(bot);

  // ✅ NEW: if a build recently failed, prioritize stockpiling & retrying
  const buildFail = lastBuildFailure(bot);
  if (shouldStockpileForBuild(buildFail)) {
    // If we have enough blocks now, retry the build first
    const retry = buildRetryTask(bot, counts);
    if (retry) return retry;

    // Otherwise stockpile blocks (mine stone -> cobble)
    return stockpileBuildingBlocksTask(bot, counts);
  }

  // Lightweight variety to avoid identical behavior across bots
  // (still productive; just picks between a couple good defaults)
  const productive = generalProductiveTask(bot, counts);

  // Occasionally do farm/build monuments to keep world lively (optional)
  // Only when conditions are decent (tools + not starving).
  const okToDoExtras = hasPickaxe(counts) && (bot.food == null || bot.food > 10);
  if (okToDoExtras && Math.random() < 0.08) {
    return randChoice([
      { type: "FARM_HARVEST_REPLANT", crops: ["wheat", "carrots", "potatoes"], max: 10 },
      // Small monuments are now actually tall via build.js minimums
      { type: "BUILD_MONUMENT", height: 11, material: "stone_bricks" },
    ]);
  }

  return productive;
}

module.exports = { pickNextTask };
