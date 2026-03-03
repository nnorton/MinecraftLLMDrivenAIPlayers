// src/planner_core/utils.js

function clampChat(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function shortErr(e) {
  return String(e?.message || e || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function summarizeInventory(bot, limit = 12) {
  const inv = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of inv) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}x${count}`)
    .join(", ");
}

function inventoryCounts(bot) {
  const inv = bot.inventory?.items?.() || [];
  const counts = {};
  for (const it of inv) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  return counts;
}

function hasAnyTool(counts, names) {
  for (const n of names) if ((counts[n] || 0) > 0) return true;
  return false;
}

module.exports = { clampChat, shortErr, summarizeInventory, inventoryCounts, hasAnyTool };
