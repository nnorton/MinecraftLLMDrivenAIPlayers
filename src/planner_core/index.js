// src/planner_core/index.js
require("dotenv").config();

const { logPlan } = require("../llm_logger");
const { saveLastLLMPlan, loadLastLLMPlan } = require("../state_store");

const { LLM_ENABLED, MODEL, MAX_OUTPUT_TOKENS } = require("./config");
const { getClient } = require("./openai_client");
const { shortErr, clampChat } = require("./utils");
const { ensurePlanNonEmpty, chooseHelpfulPlanNonLLM } = require("./non_llm");
const { buildMenuPrompt } = require("./prompt");
const { extractText, parsePlanFromJson } = require("./response");
const { reserveLLMCall, markLLMSuccess } = require("./rate_limiter");

function humanCooldownMessage({ waitMs }) {
  const mins = Math.ceil(waitMs / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return "I’m throttling LLM calls right now—continuing with deterministic work.";
  if (mins === 1) return "I’m throttling LLM calls for ~1 more minute—continuing with deterministic work.";
  return `I’m throttling LLM calls for ~${mins} more minutes—continuing with deterministic work.`;
}

async function planActions({ systemPrompt, bot, humanMessage, trigger = "autonomy" }) {
  // Hard off-switch: never call OpenAI when LLM_ENABLED=false.
  if (!LLM_ENABLED) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({
      bot: bot.username,
      trigger,
      non_llm_fallback: true,
      why: "llm_disabled",
    });
    return {
      say: humanMessage ? clampChat("Got it — I’ll handle this with deterministic logic.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  // ---- Rate limit: enforce LLM_MIN_INTERVAL_MINUTES per bot (across restarts) ----
  try {
    const gate = await reserveLLMCall({ username: bot?.username });
    if (!gate.allowed) {
      // Prefer reusing the last known-good LLM plan (free) to avoid idling.
      const last = await loadLastLLMPlan(bot?.username);
      if (last?.plan?.length) {
        logPlan({
          bot: bot.username,
          trigger,
          non_llm_fallback: true,
          why: "rate_limited_reuse_last_plan",
          wait_ms: gate.wait_ms,
          interval_ms: gate.interval_ms,
        });
        return {
          say: humanMessage ? clampChat(humanCooldownMessage({ waitMs: gate.wait_ms })) : "",
          plan: ensurePlanNonEmpty(bot, last.plan),
        };
      }

      const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
      logPlan({
        bot: bot.username,
        trigger,
        non_llm_fallback: true,
        why: "rate_limited_no_last_plan",
        wait_ms: gate.wait_ms,
        interval_ms: gate.interval_ms,
      });
      return {
        say: humanMessage ? clampChat(humanCooldownMessage({ waitMs: gate.wait_ms })) : "",
        plan: ensurePlanNonEmpty(bot, nonLLMPlan),
      };
    }
  } catch (err) {
    // If limiter fails, we do NOT want to spam the API—fall back to non-LLM work.
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({
      bot: bot?.username,
      trigger,
      non_llm_fallback: true,
      why: `rate_limiter_error:${shortErr(err)}`,
    });
    return {
      say: humanMessage ? clampChat("I’m having trouble with my planner—continuing helpful work while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  const systemStr = String(systemPrompt || "").trim();
  const menuStr = buildMenuPrompt({ bot, humanMessage });

  let client;
  try {
    client = await getClient();
  } catch (err) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `client_init_failed:${shortErr(err)}` });
    return {
      say: humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  async function doCall(extraNudge) {
    return client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: systemStr },
        { role: "user", content: extraNudge ? `${menuStr}\n\n${extraNudge}` : menuStr },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
  }

  let text = "";
  try {
    const resp1 = await doCall(null);
    text = extractText(resp1);

    if (!text) {
      const resp2 = await doCall("IMPORTANT: Your last response was empty. Return VALID JSON matching the schema now.");
      text = extractText(resp2);
    }

    if (!text) {
      const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
      logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: "empty_llm_response" });
      return {
        say: humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry.") : "",
        plan: ensurePlanNonEmpty(bot, nonLLMPlan),
      };
    }
  } catch (err) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: `llm_call_error:${shortErr(err)}` });
    return {
      say: humanMessage ? clampChat("I hit a thinking error—continuing useful tasks while you retry.") : "",
        plan: ensurePlanNonEmpty(bot, nonLLMPlan),
      };
  }

  const parsed = parsePlanFromJson({ bot, text, humanMessage });
  if (!parsed || !parsed.plan) {
    const nonLLMPlan = chooseHelpfulPlanNonLLM({ bot, humanMessage });
    logPlan({ bot: bot.username, trigger, non_llm_fallback: true, why: "parse_or_say_only_plan" });
    return {
      say: humanMessage ? clampChat("I’m having trouble thinking—continuing helpful work while you retry.") : "",
      plan: ensurePlanNonEmpty(bot, nonLLMPlan),
    };
  }

  // Persist last successful LLM instruction for restart-resume.
  try {
    await saveLastLLMPlan(bot.username, {
      say: parsed.say,
      intent: parsed.intent || "",
      trigger,
      plan: parsed.plan,
    });
  } catch {
    // ignore
  }

  // Mark success for limiter bookkeeping (best-effort).
  try {
    await markLLMSuccess({ username: bot?.username });
  } catch {
    // ignore
  }

  return { say: parsed.say, plan: parsed.plan };
}

module.exports = { planActions };
