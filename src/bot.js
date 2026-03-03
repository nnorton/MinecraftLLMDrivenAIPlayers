// src/bot.js
//
// Thin wrapper for backwards compatibility.
// The implementation lives in src/bot_core/* so future changes don't require
// editing this large file.
module.exports = require("./bot_core/create_agent");
