#!/usr/bin/env bun

/**
 * BS9 (Bun Sentinel 9)
 * High-performance, non-root process manager for Bun
 *
 * Programmatic Entry Point & Core API Exports
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
export { inspectHaCommand, inspectApplicationHa, type HaInspectionReport, type HaPitfall } from "./commands/inspect-ha.js";
export { verifyHaCommand, type VerifyHaOptions, type VerifyHaResult } from "./commands/verify-ha.js";
export { mcpCommand } from "./commands/mcp.js";
export { issuesCommand } from "./commands/issues.js";
export { ecosystemInitCommand } from "./commands/ecosystem-init.js";
export { daemonCommand } from "./commands/daemon.js";
export { Bs9Daemon, type DaemonOptions } from "./daemon/daemon.js";
export { ensureDaemonRunning, isDaemonResponsive } from "./daemon/ensure.js";
export { ControllerAdminClient } from "./cluster/admin-client.js";
export { ClusterReconciler, type ReconcilerOptions } from "./daemon/reconciler.js";

// Platform & Discovery Utilities
export { getPlatformInfo, initializePlatformDirectories } from "./platform/detect.js";
export {
  listServices,
  parseWorkerSlot,
  findClusterWorkers,
  resolveActiveWorkerForSlot,
  type ServiceMetrics,
  type WorkerSlotInfo,
} from "./utils/service-discovery.js";
export { getCrashState, forceResetCircuit, formatCrashState } from "./utils/crash-tracker.js";

// Cluster Lifecycle & Protocol
export {
  ClusterController,
  type ConnectedWorker,
  getDefaultClusterController,
  setDefaultClusterController,
  getOrStartClusterController,
} from "./cluster/controller.js";
export { LifecycleClient } from "./cluster/lifecycle-client.js";
export {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  generateNonce,
  computeHmac,
  verifyHmac,
  type Bs9Envelope,
} from "./hub/protocol.js";

// State Hub Core
export { HubServer, getDefaultHubSocketPath, type HubServerOptions } from "./hub/server.js";
export { HubClient, type HubClientOptions } from "./hub/client.js";
export { KvEngine, type KvEngineOptions, type KvEntry, type CasResult } from "./hub/engine.js";
export { WalManager, type WalManagerOptions, type WalRecord, type SnapshotData, type RecoveryResult } from "./hub/wal.js";
export {
  MAX_VALUE_SIZE,
  MAX_NAMESPACE_MEMORY,
  type HubKvMessageType,
} from "./hub/protocol.js";

// Runtime Client
export * from "./runtime/index.js";

// If executed directly, run the CLI
if (import.meta.main) {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const binPath = resolve(import.meta.dir, "../bin/bs9");
  const child = spawn("bun", ["run", binPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
