/**
 * BS9 - Daemon Manager & Ensure Running Helper
 *
 * Guarantees the persistent BS9 Controller / State Hub Daemon is running
 * before workers are spawned or cluster operations execute:
 * - Probes responsiveness via ControllerAdminClient.ping().
 * - If inactive, launches daemon under platform supervisor (systemd, launchd, or Windows watchdog).
 * - Bounded polling until controller and hub are ready.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { ControllerAdminClient } from "../cluster/admin-client.js";
import { generateSystemdUnit, startUserSystemdUnit } from "../utils/systemd.js";

export interface EnsureDaemonOptions {
  timeoutMs?: number;
  socketPath?: string;
  adminToken?: string;
}

/**
 * Checks if the daemon is alive and responsive by sending an authenticated ADMIN_PING.
 */
export async function isDaemonResponsive(options: EnsureDaemonOptions = {}): Promise<boolean> {
  const client = new ControllerAdminClient({
    socketPath: options.socketPath,
    adminToken: options.adminToken,
  });

  try {
    const connected = await client.connect(1000);
    if (!connected) return false;

    const ping = await client.ping();
    client.disconnect();
    return ping.status === "ok" || ping.status === "degraded";
  } catch {
    client.disconnect();
    return false;
  }
}

/**
 * Launches daemon under platform supervisor (systemd, launchd, or Windows watchdog).
 */
export async function launchSupervisedDaemon(): Promise<void> {
  const platformInfo = getPlatformInfo();
  const daemonTs = join(dirname(import.meta.path), "daemon.ts");
  const daemonJs = join(dirname(import.meta.path), "daemon.js");
  const daemonFile = existsSync(daemonTs) ? daemonTs : daemonJs;

  if (platformInfo.isWindows) {
    try {
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();
      await manager.createService({
        name: "BS9_DAEMON",
        displayName: "BS9 Persistent Daemon",
        description: "BS9 Controller and State Hub Persistent Daemon",
        executable: process.execPath,
        arguments: ["run", daemonFile],
        workingDirectory: process.cwd(),
        environment: {
          ...(process.env as Record<string, string>),
          BS9_DAEMON: "true",
        },
        scriptFile: daemonFile,
        noAutorestart: false,
      });
      await manager.startService("BS9_DAEMON");
      return;
    } catch {
      // Fallback to detached spawn
    }
  } else if (platformInfo.isLinux) {
    try {
      const serviceFile = join(platformInfo.serviceDir, "bs9-daemon.service");
      const daemonEnv: Record<string, string> = { BS9_DAEMON: "true" };
      for (const key of ["BS9_HOME", "BS9_CONTROLLER_SOCKET", "BS9_HUB_SOCKET"]) {
        const value = process.env[key];
        if (value) daemonEnv[key] = value;
      }
      mkdirSync(platformInfo.serviceDir, { recursive: true });
      const unitContent = generateSystemdUnit({
        description: "BS9 Unified Persistent Controller and State Hub Daemon",
        workingDir: process.cwd(),
        executable: process.execPath,
        args: ["run", daemonFile],
        env: daemonEnv,
        restartSec: 2,
      });
      writeFileSync(serviceFile, unitContent, "utf-8");
      startUserSystemdUnit(serviceFile, "bs9-daemon.service");
      return;
    } catch {
      // Fallback to detached spawn
    }
  } else if (platformInfo.isMacOS) {
    try {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand("create", {
        name: "com.bs9.daemon",
        file: process.execPath,
        args: ["run", daemonFile],
        env: JSON.stringify({ BS9_DAEMON: "true" }),
      });
      await launchdCommand("start", { name: "com.bs9.daemon" });
      return;
    } catch {
      // Fallback to detached spawn
    }
  }

  // Fallback if platform supervisor is not active
  spawnDetachedDaemon();
}

/**
 * Spawns the daemon process detached, persisting in the background.
 */
export function spawnDetachedDaemon(): void {
  const platformInfo = getPlatformInfo();
  const daemonTs = join(dirname(import.meta.path), "daemon.ts");
  const daemonJs = join(dirname(import.meta.path), "daemon.js");
  const daemonFile = existsSync(daemonTs) ? daemonTs : daemonJs;

  const logsDir = platformInfo.logDir;
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const daemonOut = openSync(join(logsDir, "bs9-daemon.log"), "a");

  const child = spawn(process.execPath, ["run", daemonFile], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", daemonOut, daemonOut],
    env: { ...process.env },
  });

  child.unref();
}

/**
 * Ensures the BS9 persistent daemon is actively running and responsive.
 */
export async function ensureDaemonRunning(options: EnsureDaemonOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs || 8000;

  // 1. Check if already alive
  if (await isDaemonResponsive(options)) {
    return;
  }

  // 2. Launch daemon under platform supervisor
  await launchSupervisedDaemon();

  // 3. Poll with bounded timeout until responsive
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isDaemonResponsive(options)) {
      return;
    }
  }

  throw new Error(`BS9 Daemon failed to start and respond to ping within ${timeoutMs}ms`);
}
