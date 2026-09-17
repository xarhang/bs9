/**
 * BS9 - Daemon Management Command
 * Manages the persistent BS9 Controller & Hub Daemon
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getPlatformInfo } from "../platform/detect.js";
import { ensureDaemonRunning, isDaemonResponsive } from "../daemon/ensure.js";
import { Bs9Daemon } from "../daemon/daemon.js";
import { ControllerAdminClient } from "../cluster/admin-client.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface DaemonCommandOptions {
  foreground?: boolean;
}

export async function daemonCommand(
  action = "status",
  options: DaemonCommandOptions = {}
): Promise<void> {
  const platformInfo = getPlatformInfo();
  const pidFile = join(platformInfo.runtimeDir, "bs9-daemon.pid");

  switch (action) {
    case "start": {
      if (options.foreground) {
        console.log("🚀 Starting BS9 Persistent Daemon in foreground...");
        const daemon = new Bs9Daemon();
        await daemon.start();
        return;
      }

      console.log("⏳ Ensuring BS9 Persistent Daemon is active...");
      try {
        await ensureDaemonRunning();
        console.log("✅ BS9 Persistent Daemon is running in background.");
      } catch (err) {
        console.error(`❌ Failed to start BS9 Persistent Daemon: ${err}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      console.log("🛑 Stopping BS9 Persistent Daemon...");

      if (platformInfo.isWindows) {
        try {
          const { WindowsServiceManager } = await import("../windows/service.js");
          const manager = new WindowsServiceManager();
          await manager.stopService("BS9_DAEMON");
        } catch {}
      } else if (platformInfo.isLinux) {
        try {
          const { execSync } = await import("node:child_process");
          execSync("systemctl --user stop bs9-daemon", { stdio: "ignore" });
        } catch {}
      } else if (platformInfo.isMacOS) {
        try {
          const { launchdCommand } = await import("../macos/launchd.js");
          await launchdCommand("stop", { name: "com.bs9.daemon" });
        } catch {}
      }

      if (existsSync(pidFile)) {
        try {
          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          if (pid && !isNaN(pid)) {
            process.kill(pid, "SIGTERM");
            console.log(`   Sent SIGTERM to daemon PID ${pid}`);
            let running = true;
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 100));
              try {
                process.kill(pid, 0);
              } catch {
                running = false;
                break;
              }
            }
            if (!running) {
              console.log("✅ BS9 Persistent Daemon stopped.");
              return;
            }
          }
        } catch (e) {
          console.warn(`⚠️ Error reading PID file: ${e}`);
        }
      }

      if (existsSync(pidFile)) {
        try { unlinkSync(pidFile); } catch {}
      }
      console.log("ℹ️ Daemon stopped or not running.");
      break;
    }

    case "status":
    default: {
      const active = await isDaemonResponsive();
      if (!active) {
        console.log("❌ BS9 Persistent Daemon is NOT running.");
        return;
      }

      console.log("✅ BS9 Persistent Daemon is running.");
      const adminClient = new ControllerAdminClient();
      if (await adminClient.connect()) {
        try {
          const report = await adminClient.ping();
          console.log(`\n🩺 Health & Component Status:`);
          console.log(`   Controller: ${report.controller.listening ? "listening" : "stopped"} (${report.controller.connectedWorkersCount} connected workers)`);
          console.log(`   State Hub:  ${report.hub.listening ? "listening" : "stopped"} (${report.hub.namespacesCount} namespaces, ${report.hub.walRecordsCount} WAL records)`);
          console.log(`   WAL Status: ${report.hub.walRecovered ? "recovered" : "recovering"}`);
          console.log(`   Reconciler: ${report.reconciler.active ? "active" : "idle"} (${report.reconciler.managedClustersCount} clusters managed, locked: [${report.reconciler.lockedClusters.join(", ") || "none"}])`);
        } catch (e) {
          console.error(`   Error querying ping: ${e}`);
        } finally {
          adminClient.disconnect();
        }
      }
      break;
    }
  }
}
