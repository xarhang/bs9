#!/usr/bin/env bun

/**
 * BS9 (Bun Sentinel 9)
 * High-performance, non-root process manager for Bun
 *
 * Programmatic Entry Point & Core API Exports
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

// Command implementations
export { startCommand } from "./commands/start.js";
export { stopCommand } from "./commands/stop.js";
export { restartCommand } from "./commands/restart.js";
export { reloadCommand } from "./commands/reload.js";
export { statusCommand } from "./commands/status.js";
export { scaleCommand } from "./commands/scale.js";
export { deleteCommand } from "./commands/delete.js";
export { logsCommand } from "./commands/logs.js";
export { monitCommand } from "./commands/monit.js";
export { webCommand } from "./commands/web.js";
export { sendSignalCommand } from "./commands/send-signal.js";
export { pingCommand } from "./commands/ping.js";
export { resetCommand } from "./commands/reset.js";
export { flushCommand } from "./commands/flush.js";
export { doctorCommand } from "./commands/doctor.js";
export { inspectCommand } from "./commands/inspect.js";
export { mcpCommand } from "./commands/mcp.js";
export { issuesCommand } from "./commands/issues.js";
export { ecosystemInitCommand } from "./commands/ecosystem-init.js";

// Platform & Discovery Utilities
export { getPlatformInfo, initializePlatformDirectories } from "./platform/detect.js";
export { listServices, type ServiceMetrics } from "./utils/service-discovery.js";
export { getCrashState, forceResetCircuit, formatCrashState } from "./utils/crash-tracker.js";

// If executed directly, run the CLI
if (import.meta.main) {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const binPath = resolve(import.meta.dir, "../bin/bs9");
  const child = spawn("bun", ["run", binPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
