const { Vec3 } = require('vec3')

function isValuable(itemName) {
  const keep = [
    'iron_pickaxe', 'stone_pickaxe', 'diamond_pickaxe',
    'iron_axe', 'stone_axe', 'diamond_axe',
    'iron_sword', 'stone_sword', 'diamond_sword',
    'shield', 'torch', 'bread'
  ]
  return keep.includes(itemName)
}

async function ensureStorage(bot) {
  if (bot.memory.storageChest) return

  const chest = bot.findBlock({
    matching: block => block.name === 'chest',
    maxDistance: 16
  })

  if (chest) {
    bot.memory.storageChest = chest.position
    bot.saveMemory()
    return
  }

  const craft = require('./storage_craft')
  await craft.craftAndPlaceChest(bot)
}

async function storeInventory(bot) {
  await ensureStorage(bot)
  const pos = bot.memory.storageChest
  if (!pos) return

  const chestBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!chestBlock) return

  await bot.pathfinder.goto(new bot.pathfinder.goals.GoalNear(pos.x, pos.y, pos.z, 2))
  const chest = await bot.openChest(chestBlock)

  for (const item of bot.inventory.items()) {
    if (isValuable(item.name)) continue
    await chest.deposit(item.type, null, item.count)
  }

  chest.close()
}

async function retrieveItem(bot, itemName, count) {
  await ensureStorage(bot)
  const pos = bot.memory.storageChest
  if (!pos) return false

  const chestBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!chestBlock) return false

  await bot.pathfinder.goto(new bot.pathfinder.goals.GoalNear(pos.x, pos.y, pos.z, 2))
  const chest = await bot.openChest(chestBlock)

  const item = chest.containerItems().find(i => i.name === itemName)
  if (!item) {
    chest.close()
    return false
  }

  await chest.withdraw(item.type, null, Math.min(count, item.count))
  chest.close()
  return true
}

module.exports = {
  ensureStorage,
  storeInventory,
  retrieveItem
}
