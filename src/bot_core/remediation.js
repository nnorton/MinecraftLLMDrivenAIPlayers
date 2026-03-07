// src/bot_core/remediation.js

function mineTargetForMaterial(material) {
  if (material === "cobblestone") return "stone";
  if (material.endsWith("_planks")) return null;
  return material;
}

function wantsWoodForMaterial(material) {
  return typeof material === "string" && material.endsWith("_planks");
}

function chooseFallbackMaterialForKind(kind) {
  const k = String(kind || "FORT").toUpperCase();
  if (k === "HOUSE" || k === "HUT" || k === "CABIN") return "oak_planks";
  return "cobblestone";
}

function queueGatherForDoor(step) {
  step._doorRetries = (step._doorRetries || 0) + 1;
  if (step._doorRetries > 2) {
    return {
      ok: false,
      reason: "door_retry_exhausted",
      newQueue: [
        { type: "SAY", text: "I still don't have what I need for a door, so I'm switching to other useful work." },
        { type: "GATHER_WOOD", count: 12, radius: 80 },
        { type: "CRAFT_TOOLS" },
      ],
    };
  }

  return {
    ok: true,
    reason: `gather_door_materials_${step._doorRetries}`,
    newQueue: [
      { type: "GATHER_WOOD", count: 12, radius: 80 },
      { type: "CRAFT_TOOLS" },
      step,
    ],
  };
}

function remediateMissingBuildComponent({ step, parsed }) {
  const component = String(parsed?.component || "").toLowerCase();

  if (component === "door") {
    return queueGatherForDoor(step);
  }

  return {
    ok: false,
    reason: `unknown_missing_component:${component || "unknown"}`,
    newQueue: [],
  };
}

function remediateNoPlaceableMaterial({ step, parsed }) {
  const requested = String(step?.material || "").toLowerCase();
  const material = requested || chooseFallbackMaterialForKind(parsed?.kind || step?.kind);

  return remediateInsufficientMaterial({
    step,
    parsed: { material, have: 0, need: requested.endsWith("_planks") ? 48 : 96 },
  });
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

  const buffer = wantsWoodForMaterial(material) ? 12 : 24;
  const wantExtra = Math.max(16, Math.min(128, deficit + buffer));
  const mineTarget = mineTargetForMaterial(material);

  if (wantsWoodForMaterial(material)) {
    return {
      ok: true,
      reason: `gather_wood_for_${material}`,
      newQueue: [
        { type: "GATHER_WOOD", count: Math.max(12, Math.ceil(wantExtra / 4)), radius: 80 },
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
        { type: "WANDER", radius: 18, maxMs: 12000 },
        step,
      ],
    };
  }

  return {
    ok: true,
    reason: `stockpile_${material}`,
    newQueue: [
      { type: "CRAFT_TOOLS" },
      { type: "MINE_BLOCKS", targets: [mineTarget, "coal_ore"], count: wantExtra, radius: 72 },
      step,
    ],
  };
}

module.exports = {
  remediateInsufficientMaterial,
  remediateMissingBuildComponent,
  remediateNoPlaceableMaterial,
};
