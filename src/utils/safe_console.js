// src/utils/safe_console.js
//
// Prevents bot processes from crashing when stdout/stderr pipes are closed
// (common with PM2 log rotation or detached terminals).
//
// Enabled by default. Disable with SAFE_CONSOLE=0.

function parseBool(v, defVal = true) {
  if (v === undefined || v === null || v === "") return defVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defVal;
}

let installed = false;

function installSafeConsole() {
  if (installed) return;
  installed = true;

  if (!parseBool(process.env.SAFE_CONSOLE, true)) return;

  let outputDisabled = false;
  function isEpipe(err) {
    return !!err && (err.code === "EPIPE" || String(err.message || "").includes("EPIPE"));
  }

  function safeWrite(stream, chunk) {
    if (outputDisabled) return;
    try {
      stream.write(chunk);
    } catch (err) {
      if (isEpipe(err)) {
        outputDisabled = true;
        return;
      }
      outputDisabled = true;
    }
  }

  // Swallow EPIPE emitted as a stream error event.
  try {
    process.stdout?.on?.("error", (err) => {
      if (isEpipe(err)) outputDisabled = true;
    });
  } catch {}
  try {
    process.stderr?.on?.("error", (err) => {
      if (isEpipe(err)) outputDisabled = true;
    });
  } catch {}

  function formatArgs(args) {
    return args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  }

  console.log = (...args) => safeWrite(process.stdout, formatArgs(args) + "\n");
  console.info = (...args) => safeWrite(process.stdout, formatArgs(args) + "\n");
  console.warn = (...args) => safeWrite(process.stderr, formatArgs(args) + "\n");
  console.error = (...args) => safeWrite(process.stderr, formatArgs(args) + "\n");
  console.debug = (...args) => safeWrite(process.stdout, formatArgs(args) + "\n");
}

module.exports = { installSafeConsole };
