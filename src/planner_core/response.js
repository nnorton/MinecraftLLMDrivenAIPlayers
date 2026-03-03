// src/planner_core/response.js

const { clampChat } = require("./utils");
const { ensurePlanNonEmpty } = require("./non_llm");

function extractText(resp) {
  const t1 = (resp?.output_text || "").trim();
  if (t1) return t1;

  const outs = resp?.output || [];
  const chunks = [];
  for (const o of outs) {
    const content = o?.content || [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) chunks.push(c.text.trim());
      if (typeof c?.content === "string" && c.content.trim()) chunks.push(c.content.trim());
      if (typeof c?.output_text === "string" && c.output_text.trim()) chunks.push(c.output_text.trim());
    }
  }
  return chunks.join("\n").trim();
}

function parsePlanFromJson({ bot, text, humanMessage }) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }

  const say = obj?.say ? clampChat(obj.say) : (humanMessage ? "Okay — I’ll work on that." : "");
  const plan = ensurePlanNonEmpty(bot, Array.isArray(obj?.plan) ? obj.plan : null);

  // Don't allow "SAY only" plans (they idle). Force a useful fallback if that happens.
  const nonSay = plan.filter((p) => String(p?.type || "").toUpperCase() !== "SAY");
  if (nonSay.length === 0) return { say, plan: null, intent: typeof obj?.intent === "string" ? obj.intent : "" };

  return { say, plan, intent: typeof obj?.intent === "string" ? obj.intent : "" };
}

module.exports = { extractText, parsePlanFromJson };
