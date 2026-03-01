// src/actions/build.js
const { Vec3 } = require("vec3");

function safeChat(bot, msg) {
  try { bot.chat(String(msg || "").slice(0, 220)); } catch {}
}

// Small cooperative yield so Mineflayer can process network packets.
// Tune delayMs up slightly (20–40ms) if you still see timeouts during large builds.
async function yieldEvery(i, every = 20, delayMs = 15) {
  if (i % every === 0) {
    await new Promise(r => setTimeout(r, delayMs));
  }
}

function findBlockItem(bot, preferred = []) {
  const items = bot.inventory.items();
  for (const name of preferred) {
    const it = items.find(i => i.name === name);
    if (it) return it;
  }
  return (
    items.find(i => i.name.endsWith("_planks")) ||
    items.find(i => i.name.includes("stone")) ||
    items.find(i => i.name === "cobblestone") ||
    items.find(i => i.name === "dirt") ||
    null
  );
}

async function equipBlock(bot, preferred) {
  const it = findBlockItem(bot, preferred);
  if (!it) return null;
  await bot.equip(it, "hand");
  return it;
}

async function placeIfAir(bot, targetPos) {
  const at = bot.blockAt(targetPos);
  if (!at || at.name !== "air") return false;

  const below = bot.blockAt(targetPos.offset(0, -1, 0));
  if (!below) return false;

  try {
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    return true;
  } catch {
    return false;
  }
}

async function buildFort(bot) {
  const it = await equipBlock(bot, ["cobblestone", "oak_planks", "spruce_planks", "dirt"]);
  if (!it) return safeChat(bot, "I don't have blocks to build with.");

  const base = bot.entity.position.floored().offset(2, 0, 2);

  // 5x5 floor + 1-high wall ring
  let k = 0;
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      await placeIfAir(bot, base.offset(x, 0, z));
      await yieldEvery(++k, 12, 10);
    }
  }

  for (let i = 0; i < 5; i++) {
    await placeIfAir(bot, base.offset(i, 1, 0));
    await placeIfAir(bot, base.offset(i, 1, 4));
    await placeIfAir(bot, base.offset(0, 1, i));
    await placeIfAir(bot, base.offset(4, 1, i));
    await yieldEvery(++k, 10, 10);
  }

  safeChat(bot, "Built a small fort pad.");
}

async function buildMonument(bot) {
  const it = await equipBlock(bot, ["red_wool", "white_wool", "red_concrete", "white_concrete", "cobblestone"]);
  if (!it) return safeChat(bot, "I need building blocks for a monument.");

  const base = bot.entity.position.floored().offset(3, 0, 3);

  for (let h = 0; h < 6; h++) {
    await placeIfAir(bot, base.offset(0, h, 0));
    await yieldEvery(h, 3, 10);
  }
  safeChat(bot, "A monument rises.");
}

async function buildMonumentComplex(bot, kind = "OBELISK") {
  kind = String(kind || "").toUpperCase();

  const DARK = ["black_concrete", "black_wool", "deepslate", "cobbled_deepslate", "polished_blackstone", "coal_block", "stone", "cobblestone"];
  const LIGHT = ["white_concrete", "white_wool", "quartz_block", "smooth_quartz", "bone_block", "calcite"];
  const RED = ["red_concrete", "red_wool", "nether_bricks", "red_nether_bricks"];

  const mainItem = await equipBlock(bot, DARK) || await equipBlock(bot, ["cobblestone", "stone"]);
  if (!mainItem) return safeChat(bot, "I don't have blocks to build a monument.");

  const base = bot.entity.position.floored().offset(4, 0, 4);

  async function equipAccent(preferred) {
    const it = findBlockItem(bot, preferred);
    if (!it) return null;
    await bot.equip(it, "hand");
    return it;
  }

  if (kind === "OBELISK") {
    let k = 0;
    // 3x3 base
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      await placeIfAir(bot, base.offset(x, 0, z));
      await yieldEvery(++k, 10, 10);
    }
    // pillar
    for (let h = 1; h <= 10; h++) {
      await placeIfAir(bot, base.offset(0, h, 0));
      await yieldEvery(++k, 8, 10);
    }
    // crown
    for (const [x, z] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
      await placeIfAir(bot, base.offset(x, 11, z));
      await yieldEvery(++k, 6, 10);
    }
    // “eye” accent
    const accent = await equipAccent(RED);
    if (accent) await placeIfAir(bot, base.offset(0, 6, 1));

    safeChat(bot, "Built an obelisk.");
    return;
  }

  if (kind === "ARCH") {
    let k = 0;
    // pillars
    for (let h = 0; h <= 6; h++) {
      await placeIfAir(bot, base.offset(-3, h, 0));
      await placeIfAir(bot, base.offset(3, h, 0));
      await yieldEvery(++k, 6, 10);
    }
    // top curve
    const topY = 7;
    const curve = [
      [-3, topY, 0],
      [-2, topY+1, 0],
      [-1, topY+2, 0],
      [ 0, topY+2, 0],
      [ 1, topY+2, 0],
      [ 2, topY+1, 0],
      [ 3, topY, 0],
    ];
    for (const [x,y,z] of curve) {
      await placeIfAir(bot, base.offset(x, y, z));
      await yieldEvery(++k, 4, 10);
    }

    const accent = await equipAccent(RED) || await equipAccent(LIGHT);
    if (accent) {
      await placeIfAir(bot, base.offset(-4, 4, 0));
      await placeIfAir(bot, base.offset(4, 4, 0));
    }

    safeChat(bot, "Built an arch.");
    return;
  }

  if (kind === "SPIRAL_TOWER") {
    let k = 0;
    // shell corners
    for (let y = 0; y <= 10; y++) {
      for (const [x,z] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
        await placeIfAir(bot, base.offset(x, y, z));
        await yieldEvery(++k, 10, 10);
      }
    }
    // spiral steps
    const spiral = [
      [0, 0, -1],
      [1, 1, 0],
      [0, 2, 1],
      [-1,3, 0],
      [0, 4, -1],
      [1, 5, 0],
      [0, 6, 1],
      [-1,7, 0],
      [0, 8, -1],
      [1, 9, 0],
      [0,10, 1],
    ];
    for (const [x,y,z] of spiral) {
      await placeIfAir(bot, base.offset(x, y, z));
      await yieldEvery(++k, 6, 10);
    }

    const accent = await equipAccent(LIGHT);
    if (accent) await placeIfAir(bot, base.offset(0, 11, 0));

    safeChat(bot, "Built a spiral tower.");
    return;
  }

  if (kind === "SHRINE") {
    let k = 0;
    // 7x7 ring
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
      const edge = (Math.abs(x) === 3 || Math.abs(z) === 3);
      if (edge) {
        await placeIfAir(bot, base.offset(x, 0, z));
        await yieldEvery(++k, 14, 10);
      }
    }
    // altar
    for (let y = 1; y <= 3; y++) {
      await placeIfAir(bot, base.offset(0, y, 0));
      await yieldEvery(++k, 3, 10);
    }
    // eye motif
    const accent = await equipAccent(RED) || await equipAccent(LIGHT);
    if (accent) {
      await placeIfAir(bot, base.offset(0, 2, 1));
      await placeIfAir(bot, base.offset(1, 2, 1));
      await placeIfAir(bot, base.offset(-1,2, 1));
    }

    safeChat(bot, "Built a shrine.");
    return;
  }

  // fallback
  await buildMonument(bot);
}

module.exports = {
  buildFort,
  buildMonument,
  buildMonumentComplex
};
