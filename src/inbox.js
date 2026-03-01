// src/inbox.js
const inbox = new Map(); // recipient -> [{ts, from, text}]

const MAX_PER_BOT = 20;

function pushMessage(to, from, text) {
  const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!msg) return;

  if (!inbox.has(to)) inbox.set(to, []);
  const arr = inbox.get(to);
  arr.push({ ts: Date.now(), from, text: msg });
  while (arr.length > MAX_PER_BOT) arr.shift();
}

function drainMessages(to, limit = 8) {
  const arr = inbox.get(to) || [];
  if (!arr.length) return [];
  const out = arr.slice(-limit);
  // Remove what we returned
  inbox.set(to, arr.slice(0, Math.max(0, arr.length - out.length)));
  return out;
}

module.exports = { pushMessage, drainMessages };
