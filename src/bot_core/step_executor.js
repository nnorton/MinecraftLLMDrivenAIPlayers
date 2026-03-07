// src/bot_core/step_executor.js

const { wander, follow, goto } = require("../actions/movement");
const { getBase, setBase, recordStructure, recordFarm } = require("../actions/memory");
const { buildFort, buildMonument, buildMonumentComplex } = require("../actions/build");
const { craftTools, smeltOre } = require("../actions/craft");
const { fightMobs } = require("../actions/combat");
const gather = require("../actions/gather");
const { simpleFarm } = require("../actions/farm");

const { normalizeType } = require("./utils");

function isMovementType(type) {
  return type === "WANDER" || type === "GOTO" || type === "FOLLOW";
}

function requestedUtilities(step) {
  const out = [];
  if (step?.includeBed) out.push("bed");
  if (step?.includeStorage) out.push("storage");
  if (step?.includeCrafting) out.push("crafting");
  if (step?.includeFurnace) out.push("furnace");
  return out;
}

async function executeStep({ bot, step, safeChat, config }) {
  const type = normalizeType(step?.type);
  if (!type) return { status: "done" };

  if (type === "SAY") {
    if (step.text) safeChat(step.text);
    return { status: "done" };
  }

  if (type === "PAUSE") {
    const ms = parseInt(step.ms, 10) || 250;
    await new Promise((r) => setTimeout(r, ms));
    return { status: "done" };
  }

  if (type === "RESET_PATHFINDER") {
    try {
      bot.pathfinder.setGoal(null);
    } catch {}
    try {
      bot.clearControlStates();
    } catch {}
    return { status: "done" };
  }

  if (type === "SET_BASE") {
    const p = bot?.entity?.position;
    if (p) setBase(bot, { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
    return { status: "done" };
  }

  if (type === "WANDER") {
    const r = parseInt(step.radius, 10) || config.WANDER_RADIUS;
    const maxMs = parseInt(step.maxMs, 10) || config.WANDER_MAX_MS;
    wander(bot, r, maxMs);
    return { status: "wait" };
  }

  if (type === "FOLLOW") {
    follow(bot, step.player);
    return { status: "wait" };
  }

  if (type === "GOTO") {
    goto(bot, step.x, step.y, step.z);
    return { status: "wait" };
  }

  if (type === "RETURN_BASE") {
    const b = getBase(bot);
    if (!b) {
      safeChat("I don't have a base saved yet.");
      return { status: "done" };
    }
    goto(bot, b.x, b.y, b.z);
    return { status: "wait" };
  }

  if (type === "GATHER_WOOD") {
    const got = await gather.gatherWood(bot, step.count ?? 8, step.radius ?? 64);
    if (!got || got <= 0) {
      return {
        status: "requeue",
        newQueue: [
          { type: "WANDER", radius: 24, maxMs: 12000 },
          { type: "GATHER_WOOD", count: step.count ?? 8, radius: (step.radius ?? 64) + 32 },
        ],
      };
    }
    return { status: "done" };
  }

  if (type === "MINE_BLOCKS") {
    await gather.mineTargets(
      bot,
      step.targets ?? ["coal_ore", "iron_ore", "stone"],
      step.count ?? 10,
      step.radius ?? undefined
    );
    return { status: "done" };
  }

  if (type === "FARM_HARVEST_REPLANT") {
    await gather.farmHarvestReplant(
      bot,
      step.crops ?? ["wheat", "carrots", "potatoes"],
      step.max ?? 12,
      step.radius ?? undefined
    );

    try {
      recordFarm(bot, {
        mode: "harvest",
        crops: step.crops ?? ["wheat", "carrots", "potatoes"],
        size: step.size,
      });
    } catch {}

    return { status: "done" };
  }

  if (type === "FARM") {
    const res = await simpleFarm(bot, step);

    if (res?.ok) {
      try {
        recordFarm(bot, {
          mode: res.mode || "farm",
          crops: step.crops ?? (res.crop ? [res.crop] : []),
          size: step.size,
        });
      } catch {}
      return { status: "done" };
    }

    bot._cooldowns = bot._cooldowns || {};
    bot._cooldowns.FARM = Date.now() + 60 * 1000;

    return {
      status: "requeue",
      newQueue: [
        { type: "PAUSE", ms: 1200 },
        { type: "WANDER", radius: 18, maxMs: 9000 },
        { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 10 },
      ],
    };
  }

  if (type === "BUILD_STRUCTURE") {
    const res = await buildFort(bot, step);

    try {
      recordStructure(bot, {
        kind: res?.kind || step.kind || "FORT",
        material: res?.material || step.material,
        size: step.size,
        height: step.height,
        utilities: requestedUtilities(step),
      });
    } catch {}

    return { status: "done" };
  }

  if (type === "BUILD_MONUMENT") {
    const res = await buildMonument(bot, step);

    try {
      recordStructure(bot, {
        kind: "MONUMENT",
        material: step.material || res?.material,
        height: step.height,
        size: 7,
      });
    } catch {}

    return { status: "done" };
  }

  if (type === "BUILD_MONUMENT_COMPLEX") {
    const res = await buildMonumentComplex(bot, step.kind || "OBELISK", step);

    try {
      recordStructure(bot, {
        kind: step.kind || "OBELISK",
        material: step.material || res?.material,
        height: step.height,
        size: 7,
      });
    } catch {}

    return { status: "done" };
  }

  if (type === "CRAFT_TOOLS") {
    const res = await craftTools(bot);

    if (!res?.ok) {
      const reason = String(res?.reason || "");
      const missing = Array.isArray(res?.missing) ? res.missing.map(String) : [];

      const needsLogs =
        reason === "no_logs" ||
        missing.includes("*_log") ||
        missing.includes("_log") ||
        missing.some((m) => m.includes("log"));

      if (needsLogs) {
        return {
          status: "requeue",
          newQueue: [
            { type: "GATHER_WOOD", count: 12, radius: 64 },
            { type: "CRAFT_TOOLS" },
          ],
        };
      }

      return {
        status: "requeue",
        newQueue: [
          { type: "WANDER", radius: 18, maxMs: 9000 },
          { type: "CRAFT_TOOLS" },
        ],
      };
    }

    return { status: "done" };
  }

  if (type === "SMELT_ORE") {
    await smeltOre(bot);
    return { status: "done" };
  }

  if (type === "FIGHT_MOBS") {
    await fightMobs(bot, step.seconds ?? 20);
    return { status: "done" };
  }

  return { status: "done" };
}

module.exports = { executeStep, isMovementType };
