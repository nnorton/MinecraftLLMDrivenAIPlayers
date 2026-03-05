// src/bot_core/remediation.js

function mineTargetForMaterial(material) {
  if (material === "cobblestone") return "stone";
  if (material.endsWith("_planks")) return null;
  return material;
}

function remediateInsufficientMaterial({ step, parsed }) {
  const { material, have, need } = parsed;
  const deficit = Math.max(0, need - have);

  step._resourceRetries = (step._resourceRetries || 0) + 1;
  if (step._resourceRetries > 2) {
    return {
      ok: false,
      reason: `resource_retry_exhausted:${material}`,
      newQueue: [
        { type: "SAY", text: `I keep coming up short on ${material}. Switching to other useful work for now.` },
        { type: "MINE_BLOCKS", targets: ["coal_ore", "iron_ore", "stone"], count: 12, radius: 48 },
        { type: "SMELT_ORE" },
      ],
    };
  }

  const buffer = 24;
  const wantExtra = Math.max(16, Math.min(96, deficit + buffer));
  const mineTarget = mineTargetForMaterial(material);

  // First attempt: try pulling from storage.
  // This is cheap compared to re-mining, and helps when bots already stockpiled.
  // Skip wildcard/unknown materials.
  const canTryRetrieve =
    material &&
    typeof material === "string" &&
    !material.includes("*") &&
    !material.includes(" ") &&
    material.length > 0;

  if (material.endsWith("_planks")) {
    return {
      ok: true,
      reason: `gather_wood_for_${material}`,
      newQueue: [
        ...(canTryRetrieve ? [{ type: "STORAGE_RETRIEVE", item: material, count: wantExtra }] : []),
        { type: "GATHER_WOOD", count: 12, radius: 80 },
        { type: "CRAFT_TOOLS" },
        step,
      ],
    };
  }

  if (!mineTarget) {
    return {
      ok: true,
      reason: `fallback_wander_for_${material}`,
      newQueue: [
        ...(canTryRetrieve ? [{ type: "STORAGE_RETRIEVE", item: material, count: wantExtra }] : []),
        { type: "WANDER", radius: 18, maxMs: 12000 },
        step,
      ],
    };
  }

  return {
    ok: true,
    reason: `stockpile_${material}`,
    newQueue: [
      ...(canTryRetrieve ? [{ type: "STORAGE_RETRIEVE", item: material, count: wantExtra }] : []),
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: [mineTarget, "coal_ore"], count: wantExtra, radius: 72 },
      step,
    ],
  };
}

module.exports = { remediateInsufficientMaterial };
