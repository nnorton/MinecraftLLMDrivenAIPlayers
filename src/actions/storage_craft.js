const { Vec3 } = require('vec3')

async function craftAndPlaceChest(bot) {
  const planks = bot.inventory.count(bot.registry.itemsByName.oak_planks.id)
  if (planks < 8) {
    const logs = bot.inventory.items().find(i => i.name.includes('log'))
    if (!logs) return
    const recipe = bot.recipesFor(bot.registry.itemsByName.oak_planks.id)[0]
    await bot.craft(recipe, logs.count)
  }

  const chestRecipe = bot.recipesFor(bot.registry.itemsByName.chest.id)[0]
  if (!chestRecipe) return
  await bot.craft(chestRecipe, 1)

  const chestItem = bot.inventory.items().find(i => i.name === 'chest')
  if (!chestItem) return

  const pos = bot.entity.position.offset(1, 0, 0).floored()
  const refBlock = bot.blockAt(pos.offset(0, -1, 0))
  if (!refBlock) return

  await bot.equip(chestItem, 'hand')
  await bot.placeBlock(refBlock, new Vec3(0, 1, 0))

  bot.memory.storageChest = pos
  bot.saveMemory()
}

module.exports = {
  craftAndPlaceChest
}
