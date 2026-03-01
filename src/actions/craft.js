// src/actions/craft.js
const { Vec3 } = require("vec3");

function hasItem(bot, name, count = 1) {
  return bot.inventory.count(bot.registry.itemsByName[name]?.id || -1) >= count;
}

async function craftIfPossible(bot, itemName, count = 1) {
  const item = bot.registry.itemsByName[itemName];
  if (!item) throw new Error(`Unknown item ${itemName}`);
  const recipe = bot.recipesFor(item.id, null, 1, bot.inventory)[0];
  if (!recipe) throw new Error(`No recipe for ${itemName}`);
  await bot.craft(recipe, count, null);
}

async function craftTools(bot) {
  // Make planks + sticks if possible
  try {
    if (hasItem(bot, "oak_log", 1) || hasItem(bot, "spruce_log", 1) || hasItem(bot, "birch_log", 1)) {
      // any log -> planks (simplify by crafting oak planks if possible)
      // crafting system uses whatever logs available
      await craftIfPossible(bot, "oak_planks", 4);
    }
  } catch {}

  try {
    if (hasItem(bot, "oak_planks", 2)) await craftIfPossible(bot, "stick", 4);
  } catch {}

  // Prefer stone tools if cobblestone exists, else wooden
  const canStone = hasItem(bot, "cobblestone", 3) && hasItem(bot, "stick", 2);
  const canWood = hasItem(bot, "oak_planks", 3) && hasItem(bot, "stick", 2);

  try {
    if (canStone && !hasItem(bot, "stone_pickaxe", 1)) await craftIfPossible(bot, "stone_pickaxe", 1);
    else if (canWood && !hasItem(bot, "wooden_pickaxe", 1)) await craftIfPossible(bot, "wooden_pickaxe", 1);
  } catch {}

  try {
    if (canStone && !hasItem(bot, "stone_axe", 1)) await craftIfPossible(bot, "stone_axe", 1);
    else if (canWood && !hasItem(bot, "wooden_axe", 1)) await craftIfPossible(bot, "wooden_axe", 1);
  } catch {}

  bot.chat("Crafted what I could.");
}

async function smeltOre(bot) {
  // Minimal: if furnace + fuel + iron_ore present, smelt 1 batch.
  if (!hasItem(bot, "furnace", 1)) {
    bot.chat("I need a furnace to smelt.");
    return;
  }
  if (!(hasItem(bot, "coal", 1) || hasItem(bot, "charcoal", 1))) {
    bot.chat("I need fuel (coal/charcoal) to smelt.");
    return;
  }
  if (!hasItem(bot, "iron_ore", 1)) {
    bot.chat("No iron ore to smelt.");
    return;
  }

  // Place furnace near feet if air
  const base = bot.entity.position.floored();
  const placePos = base.offset(1, 0, 0);
  const below = bot.blockAt(placePos.offset(0, -1, 0));
  const at = bot.blockAt(placePos);
  if (!below || !at || at.name !== "air") {
    bot.chat("No space to place furnace.");
    return;
  }

  await bot.equip(bot.inventory.items().find(i => i.name === "furnace"), "hand");
  await bot.placeBlock(below, new Vec3(0, 1, 0));
  const furnaceBlock = bot.blockAt(placePos);
  const furnace = await bot.openFurnace(furnaceBlock);

  const fuel = bot.inventory.items().find(i => i.name === "coal" || i.name === "charcoal");
  const ore = bot.inventory.items().find(i => i.name === "iron_ore");

  await furnace.putFuel(fuel.type, null, 1);
  await furnace.putInput(ore.type, null, Math.min(8, ore.count));

  // Wait a bit, then take output if any
  await new Promise(r => setTimeout(r, 25000));
  try { await furnace.takeOutput(); } catch {}
  furnace.close();

  bot.chat("Smelting started.");
}

module.exports = { craftTools, smeltOre };
