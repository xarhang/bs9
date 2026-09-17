#!/usr/bin/env bun

/**
 * BS9 - Unified Persistent Daemon
 *
 * Hosts the persistent core services for BS9:
 * 1. State Hub (In-Memory KV, Leases, Queues, WAL)
 * 2. Cluster Lifecycle Controller (Worker registration, readiness, two-phase drain, admin IPC)
 * 3. Desired-State Cluster Reconciler (generation-aware, operation-locked)
 *
 * Managed across platforms by:
 * - Linux: systemd user service (~/.config/systemd/user/bs9-daemon.service)
 * - macOS: launchd agent (~/Library/LaunchAgents/com.bs9.daemon.plist)
 * - Windows: Windows watchdog background process (BS9_DAEMON)
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { HubServer, getDefaultHubSocketPath } from "../hub/server.js";
import { ClusterController } from "../cluster/controller.js";
import { ClusterReconciler } from "./reconciler.js";
import { getPlatformInfo } from "../platform/detect.js";
import { resolveRuntime } from "../utils/runtime-resolver.js";
import { generateSystemdUnit, startUserSystemdUnit } from "../utils/systemd.js";
import type { ClusterManifestData } from "../hub/protocol.js";

export interface DaemonOptions {
  controllerSocketPath?: string;
  hubSocketPath?: string;
  adminToken?: string;
  reconcilerIntervalMs?: number;
  onResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;
}

export class Bs9Daemon {
  public readonly hub: HubServer;
  public readonly controller: ClusterController;
  public readonly reconciler: ClusterReconciler;
  private pidFilePath: string;
  private isRunning = false;
  private customResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;

  constructor(options: DaemonOptions = {}) {
    const platformInfo = getPlatformInfo();
    const runtimeDir = platformInfo.runtimeDir;
    if (!existsSync(runtimeDir)) {
      mkdirSync(runtimeDir, { recursive: true });
    }

    this.pidFilePath = join(runtimeDir, "bs9-daemon.pid");
    this.customResurrectSlot = options.onResurrectSlot;

    this.hub = new HubServer({
      socketPath: options.hubSocketPath || process.env.BS9_HUB_SOCKET || getDefaultHubSocketPath(),
      autoRecover: true,
    });

    this.controller = new ClusterController({
      socketPath: options.controllerSocketPath || process.env.BS9_CONTROLLER_SOCKET || platformInfo.socketPath,
      adminToken: options.adminToken,
    });

    // Wire Hub health provider into Controller for ADMIN_PING
    this.controller.setHubProvider(() => ({
      listening: this.hub.isListening(),
      namespacesCount: Math.max(this.hub.getSessionCount(), this.hub.getRecoveredNamespacesCount()),
      walRecovered: this.hub.isRecovered(),
      walRecordsCount: this.hub.wal.getTotalWalRecordsCount(),
    }));

    this.reconciler = new ClusterReconciler(this.controller, {
      intervalMs: options.reconcilerIntervalMs || 2000,
      onResurrectSlot: async (manifest, slot, nextGen) => {
        if (this.customResurrectSlot) {
          await this.customResurrectSlot(manifest, slot, nextGen);
          return;
        }
        await this.resurrectSlot(manifest, slot, nextGen);
      },
    });
  }

  public async resurrectSlot(
    manifest: ClusterManifestData,
    slot: number,
    nextGen: number
  ): Promise<void> {
    const platformInfo = getPlatformInfo();
    const clusterName = manifest.clusterName;
    const physicalName = `${clusterName}-${slot}-g${nextGen}`;
    const tokenFilePath = join(platformInfo.runtimeDir, "tokens", `${clusterName}.token`);

    const preloadPath = resolve(join(dirname(import.meta.path), "..", "utils", "cluster-preload.ts"));
    const preloadArgs = existsSync(preloadPath) ? ["--preload", preloadPath] : [];
    const runtime = resolveRuntime(manifest.appFile, manifest.options?.interpreter, preloadArgs);

    const envVars: Record<string, string> = {
      PORT: String(manifest.port),
      HOST: manifest.host || "localhost",
      NODE_ENV: "production",
      SERVICE_NAME: physicalName,
      BS9_CLUSTER: "true",
      BS9_REUSE_PORT: "true",
      BS9_CLUSTER_NAME: clusterName,
      BS9_CLUSTER_ID: String(slot),
      NODE_APP_INSTANCE: String(slot),
      BS9_CLUSTER_TOTAL: String(manifest.instances),
      BS9_CLUSTER_GENERATION: String(nextGen),
      BS9_AUTH_TOKEN_FILE: tokenFilePath,
      BS9_CONTROLLER_SOCKET: this.controller.getSocketPath(),
      ...(manifest.env || {}),
    };

    if (platformInfo.isWindows) {
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();
      await manager.createService({
        name: `BS9_${physicalName}`,
        displayName: `BS9 Service: ${physicalName}`,
        description: `BS9 managed cluster worker: ${physicalName} (gen ${nextGen})`,
        executable: runtime.executable,
        arguments: runtime.args,
        workingDirectory: resolve(dirname(manifest.appFile)),
        environment: envVars,
        scriptFile: manifest.appFile,
        watch: manifest.options?.watch,
        maxMemoryRestart: manifest.options?.maxMemoryRestart,
      });
      await manager.startService(`BS9_${physicalName}`);
    } else if (platformInfo.isLinux) {
      const unitPath = join(platformInfo.serviceDir, `${physicalName}.service`);
      const unitContent = generateSystemdUnit({
        description: `BS9 Cluster Worker ${physicalName}`,
        workingDir: dirname(manifest.appFile),
        executable: runtime.executable,
        args: runtime.args,
        env: envVars,
        restartSec: 2,
      });
      writeFileSync(unitPath, unitContent, "utf-8");
      startUserSystemdUnit(unitPath, `${physicalName}.service`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand("create", {
        name: `bs9.${physicalName}`,
        file: runtime.executable,
        args: runtime.args,
        env: JSON.stringify(envVars),
      });
      await launchdCommand("start", { name: `bs9.${physicalName}` });
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    // Start Hub
    await this.hub.start();

    // Start Controller
    await this.controller.start();

    // Start Reconciler
    this.reconciler.start();

    this.isRunning = true;

    // Record PID
    writeFileSync(this.pidFilePath, String(process.pid), { encoding: "utf-8" });

    console.log(`🚀 BS9 Unified Daemon running (PID: ${process.pid})`);
    console.log(`   Controller Socket: ${this.controller.getSocketPath()}`);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.reconciler.stop();
    await this.controller.stop();
    await this.hub.stop();

    if (existsSync(this.pidFilePath)) {
      try {
        unlinkSync(this.pidFilePath);
      } catch {}
    }

    console.log(`🛑 BS9 Unified Daemon stopped cleanly.`);
  }
}

// Auto-run if executed as main script
if (import.meta.main) {
  const daemon = new Bs9Daemon();

  const handleSignal = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down daemon...`);
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  daemon.start().catch((err) => {
    console.error(`❌ Failed to start BS9 Unified Daemon:`, err);
    process.exit(1);
  });
}
