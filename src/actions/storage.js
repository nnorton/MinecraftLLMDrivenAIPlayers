// src/actions/storage.js
// Inventory storage + retrieval (chest-based).
//
// Design goals:
// - Best effort, never chat directly (callers decide).
// - Persist the chosen chest position in mem/<bot>.json (via actions/memory).
// - Automatically craft+place a chest if none exists nearby.

const { Vec3 } = require("vec3");
const { getBase } = require("./memory");
const { getStorageChest, setStorageChest } = require("./memory");

function isValuable(itemName) {
  // Keep essentials on-hand.
  const keep = [
    "iron_pickaxe",
    "stone_pickaxe",
    "diamond_pickaxe",
    "netherite_pickaxe",
    "iron_axe",
    "stone_axe",
    "diamond_axe",
    "netherite_axe",
    "iron_sword",
    "stone_sword",
    "diamond_sword",
    "netherite_sword",
    "shield",
    "torch",
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "carrot",
    "potato",
    "wheat_seeds",
    "crafting_table",
    "furnace",
  ];
  return keep.includes(String(itemName || ""));
}

function toVec3(p) {
  if (!p) return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return new Vec3(p.x, p.y, p.z);
}

function findNearbyChest(bot, maxDistance) {
  try {
    return bot.findBlock({
      matching: (block) => block && block.name === "chest",
      maxDistance,
      count: 1,
    });
  } catch {
    return null;
  }
}

async function gotoNear(bot, pos, radius = 2) {
  if (!bot?.pathfinder) return;
  const { goals } = require("mineflayer-pathfinder");
  await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, radius));
}

async function ensureStorage(bot, opts = {}) {
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 16;

  // 1) If memory points to a chest and it still exists, keep using it.
  const remembered = getStorageChest(bot);
  if (remembered) {
    const b = bot.blockAt(toVec3(remembered));
    if (b && b.name === "chest") return remembered;
  }

  // 2) Look for a nearby chest.
  const found = findNearbyChest(bot, maxDistance);
  if (found?.position) {
    setStorageChest(bot, found.position);
    return { x: found.position.x, y: found.position.y, z: found.position.z };
  }

  // 3) Look near base (if we have one) and remember it.
  const base = getBase(bot);
  if (base) {
    const baseBlock = bot.blockAt(new Vec3(base.x, base.y, base.z));
    if (baseBlock) {
      const chestNearBase = findNearbyChest(bot, Math.max(maxDistance, 24));
      if (chestNearBase?.position) {
        setStorageChest(bot, chestNearBase.position);
        return { x: chestNearBase.position.x, y: chestNearBase.position.y, z: chestNearBase.position.z };
      }
    }
  }

  // 4) None found -> craft + place a chest.
  const craft = require("./storage_craft");
  const placed = await craft.craftAndPlaceChest(bot, { nearBase: true });
  if (placed) {
    setStorageChest(bot, placed);
    return placed;
  }

  return null;
}

async function storeInventory(bot, opts = {}) {
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 16;
  const chestPos = await ensureStorage(bot, { maxDistance });
  if (!chestPos) return { ok: false, reason: "no_storage" };

  const chestBlock = bot.blockAt(toVec3(chestPos));
  if (!chestBlock || chestBlock.name !== "chest") return { ok: false, reason: "chest_missing" };

  try {
    await gotoNear(bot, chestBlock.position, 2);
    const chest = await bot.openChest(chestBlock);

    const items = bot.inventory.items();
    let deposited = 0;

    for (const item of items) {
      if (!item) continue;
      if (isValuable(item.name)) continue;
      try {
        await chest.deposit(item.type, null, item.count);
        deposited += item.count;
      } catch {
        // If chest fills or deposit fails, keep going.
        continue;
      }
    }

    try {
      chest.close();
    } catch {}

    return { ok: true, deposited };
  } catch (e) {
    return { ok: false, reason: `store_failed:${e?.message || e}` };
  }
}

async function retrieveItem(bot, itemName, count = 1, opts = {}) {
  const want = Math.max(1, parseInt(count, 10) || 1);
  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 16;

  const chestPos = await ensureStorage(bot, { maxDistance });
  if (!chestPos) return { ok: false, got: 0, reason: "no_storage" };

  const chestBlock = bot.blockAt(toVec3(chestPos));
  if (!chestBlock || chestBlock.name !== "chest") return { ok: false, got: 0, reason: "chest_missing" };

  try {
    await gotoNear(bot, chestBlock.position, 2);
    const chest = await bot.openChest(chestBlock);

    const items = chest.containerItems();
    const matches = items.filter((i) => i && i.name === itemName);
    const total = matches.reduce((s, i) => s + (i.count || 0), 0);

    if (!matches.length || total <= 0) {
      try {
        chest.close();
      } catch {}
      return { ok: false, got: 0, reason: "not_found" };
    }

    const take = Math.min(want, total);
    // Withdraw across stacks if needed.
    let remaining = take;
    for (const it of matches) {
      if (remaining <= 0) break;
      const amt = Math.min(remaining, it.count || 0);
      if (amt <= 0) continue;
      try {
        await chest.withdraw(it.type, null, amt);
        remaining -= amt;
      } catch {
        continue;
      }
    }

    try {
      chest.close();
    } catch {}

    return { ok: true, got: take - remaining, reason: "withdrew" };
  } catch (e) {
    return { ok: false, got: 0, reason: `withdraw_failed:${e?.message || e}` };
  }
}

module.exports = {
  ensureStorage,
  storeInventory,
  retrieveItem,
};
