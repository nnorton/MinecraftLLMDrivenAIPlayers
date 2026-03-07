// src/bot_core/engine.js

const { planActions } = require("../planner");
const { postEvent } = require("../team_bus");
const { pickNextTask } = require("../task_picker");

const { deterministicPlan } = require("./deterministic_plan");
const {
  remediateInsufficientMaterial,
  remediateMissingBuildComponent,
  remediateNoPlaceableMaterial,
} = require("./remediation");
const { executeStep } = require("./step_executor");
const {
  dbg,
  shortErr,
  normalizeType,
  isMajorStepType,
  parseInsufficientMaterial,
  parseMissingBuildComponent,
  parseNoPlaceableMaterial,
  parseBuildIncomplete,
  isPathfinderPlanningError,
  posObj,
} = require("./utils");

function withTimeout(promise, ms, onTimeout) {
  const timeoutMs = Math.max(0, parseInt(ms, 10) || 0);
  if (!timeoutMs) return promise;

  let t;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {}
      reject(new Error(`step timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    t.unref?.();
  });

  return Promise.race([
    promise.finally(() => {
      try {
        clearTimeout(t);
      } catch {}
    }),
    timeoutPromise,
  ]);
}

function attachEngine({ bot, persona, config }) {
  function safeChat(msg) {
    try {
      bot.chat(String(msg || "").slice(0, 220));
    } catch {}
  }

  function scheduleEnsureWork() {
    if (bot._ensureScheduled) return;
    bot._ensureScheduled = true;

    const now = Date.now();
    const nextAt = bot._nextWorkAt || 0;
    const delay = Math.max(0, nextAt - now);

    setTimeout(() => {
      bot._ensureScheduled = false;
      ensureWork();
    }, delay).unref?.();
  }

  function ensureWork() {
    if (!bot.entity) return;
    if (bot._planning) return;
    if (bot._executing) return;

    const now = Date.now();
    if (bot._nextWorkAt && now < bot._nextWorkAt) return;

    // If we are currently in a movement step, don't restart work.
    const curType = normalizeType(bot._current?.type);
    if (curType === "WANDER" || curType === "GOTO" || curType === "FOLLOW") return;

    const hasWork = bot._planQueue.length > 0;

    if (!hasWork) {
      if (bot._pendingHuman && !bot._planning) {
        const pending = bot._pendingHuman;
        bot._pendingHuman = null;
        bot._lastHumanAt = Date.now();
        bot._planning = true;

        const personaPrompt = persona?.systemPrompt || "";

        const planPromise = config.LLM_ENABLED
          ? planActions({
              systemPrompt: personaPrompt,
              bot,
              humanMessage: pending.text,
              trigger: "human_deferred",
            })
          : Promise.resolve({ say: "", plan: deterministicPlan(bot, pending.text) });

        planPromise
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) bot._planQueue = res.plan;
          })
          .catch((e) => {
            console.error(`[${bot.username}] deferred planning failed`, e?.message || e);
            bot._planQueue = deterministicPlan(bot, pending.text);
          })
          .finally(() => {
            bot._planning = false;
            scheduleEnsureWork();
          });
        return;
      }

      if (now - bot._lastHumanAt < config.COOLDOWN_ON_HUMAN_MS) return;

      if (now - bot._lastAutonomyAt > config.AUTONOMY_INTERVAL_MS) {
        bot._lastAutonomyAt = now;
        bot._planning = true;

        const personaPrompt = persona?.systemPrompt || "";

        const planPromise = config.LLM_ENABLED
          ? planActions({ systemPrompt: personaPrompt, bot, humanMessage: null, trigger: "autonomy" })
          : Promise.resolve({
              say: "",
              plan: pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }],
            });

        planPromise
          .then((res) => {
            if (res?.say) safeChat(res.say);
            if (Array.isArray(res?.plan)) bot._planQueue = res.plan;
          })
          .catch((e) => {
            console.error(`[${bot.username}] planning failed`, e?.message || e);
            bot._planQueue = pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }];
          })
          .finally(() => {
            bot._planning = false;
            scheduleEnsureWork();
          });
        return;
      }

      bot._planQueue = pickNextTask(bot) ? [pickNextTask(bot)] : [{ type: "WANDER" }];
    }

    const nextType = normalizeType(bot._planQueue?.[0]?.type);
    if (config.DEBUG_BOT && nextType && nextType !== bot._lastStepLogType) {
      bot._lastStepLogType = nextType;
      dbg(bot, `next step -> ${nextType}`, true);
    }

    executeNextStep().catch(() => {});
  }

  function applyStepPacing(type, ms) {
    const now = Date.now();

    // Always enforce a minimum gap after "done" steps to avoid tight loops.
    const baseGap = Math.max(0, config.MIN_STEP_GAP_MS || 0);
    bot._nextWorkAt = Math.max(bot._nextWorkAt || 0, now + baseGap);

    // Track fast-step streaks (typical of “no-op” actions like FARM when no crops/seed/ground exist).
    const thresh = Math.max(1, config.FAST_STEP_MS_THRESHOLD || 25);

    const isFast = typeof ms === "number" && ms <= thresh;
    const sameType = type && bot._lastDoneType === type;

    if (isFast && sameType) bot._fastStreak = (bot._fastStreak || 0) + 1;
    else if (isFast) bot._fastStreak = 1;
    else bot._fastStreak = 0;

    bot._lastDoneType = type;

    const maxStreak = Math.max(1, config.FAST_STEP_MAX_STREAK || 8);
    if (bot._fastStreak >= maxStreak) {
      const over = bot._fastStreak - maxStreak;
      const base = Math.max(50, config.FAST_STEP_BACKOFF_BASE_MS || 250);
      const cap = Math.max(base, config.FAST_STEP_BACKOFF_MAX_MS || 5000);

      const backoff = Math.min(cap, Math.floor(base * Math.pow(2, Math.min(6, over))));
      bot._nextWorkAt = Math.max(bot._nextWorkAt || 0, now + backoff);

      try {
        console.warn(
          `[${bot.username}] [pacing] fast-loop detected type=${type} streak=${bot._fastStreak} -> backoff=${backoff}ms`
        );
      } catch {}
    }
  }

  async function executeNextStep() {
    if (bot._executing) return;
    if (!bot._planQueue.length) return;

    bot._executing = true;
    const startedAt = Date.now();
    const step = bot._planQueue[0];
    bot._current = step;
    bot._currentStartedAt = Date.now();

    const type = normalizeType(step?.type);

    try {
      console.log(`[${bot.username}] [job] start ${type || "UNKNOWN"} q=${bot._planQueue.length}`);
    } catch {}

    if (isMajorStepType(type)) {
      bot._commitUntil = Math.max(bot._commitUntil || 0, Date.now() + config.PLAN_COMMIT_MS);
    }

    const stepPos = posObj(bot);

    try {
      const res = await withTimeout(
        executeStep({ bot, step, safeChat, config }),
        config.STEP_TIMEOUT_MS,
        () => {
          try {
            bot.stopDigging?.();
          } catch {}
          try {
            bot.pathfinder?.setGoal?.(null);
          } catch {}
          try {
            bot.clearControlStates?.();
          } catch {}
        }
      );

      if (res?.status === "requeue" && Array.isArray(res.newQueue) && res.newQueue.length) {
        bot._planQueue = [...res.newQueue, ...bot._planQueue.slice(1)];
        bot._current = null;
        return;
      }

      if (res?.status === "wait") {
        // Movement step; tickMovement() will shift when done.
        return;
      }

      // done => shift
      bot._planQueue.shift();

      const ms = Date.now() - startedAt;
      try {
        console.log(`[${bot.username}] [job] done ${type || "UNKNOWN"} ms=${ms} q=${bot._planQueue.length}`);
      } catch {}

      applyStepPacing(type, ms);

      if (
        type !== "SAY" &&
        type !== "WANDER" &&
        type !== "FOLLOW" &&
        type !== "GOTO" &&
        type !== "RETURN_BASE"
      ) {
        postEvent(bot.username, `${config.TEAM_PREFIX} ok ${type}`, "action_ok", {
          type,
          ms,
          pos: stepPos,
          pos2: posObj(bot),
        });
      }
    } catch (e) {
      const ms = Date.now() - startedAt;
      const reason = shortErr(e);

      console.error(`[${bot.username}] step failed`, e?.message || e);
      try {
        console.log(`[${bot.username}] [job] fail ${type || "UNKNOWN"} ms=${ms} reason=${reason}`);
      } catch {}

      applyStepPacing(type, ms);

      const parsed = parseInsufficientMaterial(reason);
      if (parsed && bot._current) {
        const remediation = remediateInsufficientMaterial({ step: bot._current, parsed });
        if (remediation?.ok && Array.isArray(remediation.newQueue) && remediation.newQueue.length) {
          postEvent(bot.username, `${config.TEAM_PREFIX} recover ${type}: ${remediation.reason}`, "action_recover", {
            type,
            reason: remediation.reason,
            err: reason,
            ms,
            pos: stepPos,
            pos2: posObj(bot),
          });
          bot._planQueue = [...remediation.newQueue, ...bot._planQueue.slice(1)];
          bot._current = null;
          return;
        }
      }

      const missingComponent = parseMissingBuildComponent(reason);
      if (missingComponent && bot._current) {
        const remediation = remediateMissingBuildComponent({
          step: bot._current,
          parsed: missingComponent,
        });
        if (remediation?.ok && Array.isArray(remediation.newQueue) && remediation.newQueue.length) {
          postEvent(bot.username, `${config.TEAM_PREFIX} recover ${type}: ${remediation.reason}`, "action_recover", {
            type,
            reason: remediation.reason,
            err: reason,
            ms,
            pos: stepPos,
            pos2: posObj(bot),
            component: missingComponent.component,
          });
          bot._planQueue = [...remediation.newQueue, ...bot._planQueue.slice(1)];
          bot._current = null;
          return;
        }
      }

      const noMaterial = parseNoPlaceableMaterial(reason);
      if (noMaterial && bot._current) {
        const remediation = remediateNoPlaceableMaterial({
          step: bot._current,
          parsed: noMaterial,
        });
        if (remediation?.ok && Array.isArray(remediation.newQueue) && remediation.newQueue.length) {
          postEvent(bot.username, `${config.TEAM_PREFIX} recover ${type}: ${remediation.reason}`, "action_recover", {
            type,
            reason: remediation.reason,
            err: reason,
            ms,
            pos: stepPos,
            pos2: posObj(bot),
            buildKind: noMaterial.kind,
          });
          bot._planQueue = [...remediation.newQueue, ...bot._planQueue.slice(1)];
          bot._current = null;
          return;
        }
      }

      const incomplete = parseBuildIncomplete(reason);
      if (incomplete && bot._current && normalizeType(bot._current.type) === "BUILD_STRUCTURE") {
        bot._current._buildRetries = (bot._current._buildRetries || 0) + 1;
        const tries = bot._current._buildRetries;
        if (tries <= 6) {
          postEvent(bot.username, `${config.TEAM_PREFIX} recover ${type}: build_incomplete_${tries}`, "action_recover", {
            type,
            reason: `build_incomplete_${tries}`,
            err: reason,
            ms,
            pos: stepPos,
            pos2: posObj(bot),
            completionPct: incomplete.completionPct,
            placed: incomplete.placed,
            total: incomplete.total,
          });
          bot._planQueue = [
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 4, maxMs: 3500 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }
      }

      if (isPathfinderPlanningError(reason) && bot._current) {
        bot._current._pathRetries = (bot._current._pathRetries || 0) + 1;
        const tries = bot._current._pathRetries;

        if (tries <= config.PATHFINDER_ERROR_RETRY_LIMIT) {
          postEvent(bot.username, `${config.TEAM_PREFIX} recover ${type}: pathfinder_retry_${tries}`, "action_recover", {
            type,
            reason: `pathfinder_retry_${tries}`,
            err: reason,
            ms,
            pos: stepPos,
            pos2: posObj(bot),
          });

          bot._planQueue = [
            { type: "RESET_PATHFINDER" },
            { type: "PAUSE", ms: 250 },
            { type: "WANDER", radius: 6, maxMs: 6000 },
            bot._current,
            ...bot._planQueue.slice(1),
          ];
          bot._current = null;
          return;
        }
      }

      postEvent(bot.username, `${config.TEAM_PREFIX} fail ${type}: ${reason}`, "action_fail", {
        type,
        reason,
        ms,
        pos: stepPos,
        pos2: posObj(bot),
      });
      bot._planQueue.shift();
      bot._current = null;
    } finally {
      bot._executing = false;
      if (!bot._current) bot._currentStartedAt = null;
      scheduleEnsureWork();
    }
  }

  return { safeChat, scheduleEnsureWork, ensureWork };
}

module.exports = { attachEngine };
