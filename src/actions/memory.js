// src/actions/memory.js
const fs = require("fs");
const path = require("path");

const MEM_DIR = path.join(process.cwd(), "mem");
if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });

function memPath(botName) {
  return path.join(MEM_DIR, `${botName}.json`);
}

function loadMemory(botName) {
  const p = memPath(botName);
  if (!fs.existsSync(p)) return { base: null };
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { base: null }; }
}

function saveMemory(botName, mem) {
  fs.writeFileSync(memPath(botName), JSON.stringify(mem, null, 2));
}

function setBase(bot) {
  const mem = loadMemory(bot.username);
  const pos = bot.entity?.position;
  if (!pos) return;
  mem.base = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  saveMemory(bot.username, mem);
  return mem.base;
}

function getBase(bot) {
  const mem = loadMemory(bot.username);
  return mem.base;
}

module.exports = { loadMemory, saveMemory, setBase, getBase };
