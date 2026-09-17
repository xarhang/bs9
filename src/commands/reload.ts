#!/usr/bin/env bun

/**
 * BS9 - Zero-Downtime Reload Command
 * Performs rolling reload on clustered services or smooth restart, mirroring `pm2 reload`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { restartCommand } from "./restart.js";
import { stopCommand } from "./stop.js";
import { deleteCommand } from "./delete.js";
import { listServices, parseWorkerSlot, type ServiceMetrics } from "../utils/service-discovery.js";
import { ClusterController } from "../cluster/controller.js";
import { ControllerAdminClient, ClusterLockSession } from "../cluster/admin-client.js";
import { ensureDaemonRunning } from "../daemon/ensure.js";
import { getPlatformInfo } from "../platform/detect.js";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { startUserSystemdUnit } from "../utils/systemd.js";


export interface ReloadOptions {
  force?: boolean;
  controller?: ClusterController;
  adminClient?: ControllerAdminClient;
  readyTimeoutMs?: number;
  drainTimeoutMs?: number;
  minimumReady?: number;
  spawnWorker?: (slot: number, nextGen: number, appName: string, physicalName: string) => Promise<{ pid?: number; stop?: () => Promise<void> } | void>;
  stopWorker?: (slot: number, currentGen: number, appName: string, physicalName: string) => Promise<void>;
}

export const READY_TIMEOUT_MS = 15000;
export const DRAIN_TIMEOUT_MS = 10000;

export async function reloadCommand(names: string[] = [], options: ReloadOptions = {}): Promise<void> {
  const target = names[0] || "all";
  const allServices = await listServices();

  // If target is 'all', find all cluster apps or reload all
  if (target === "all") {
    const clusterApps = new Set<string>();
    for (const s of allServices) {
      const info = parseWorkerSlot(s.name);
      if (info) clusterApps.add(info.appName);
    }
    if (clusterApps.size > 0) {
      for (const app of clusterApps) {
        await reloadClusterApp(app, options);
      }
      return;
    }
    console.log(`🔄 Reloading all services...`);
    await restartCommand(names, options);
    return;
  }

  // Check if target is a cluster parent (workers named target-0, target-0-g1, etc.)
  let clusterWorkers = allServices.filter(s => {
    const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return new RegExp(`^${target}-\\d+(-g\\d+)?$`).test(clean);
  });

  // Also check if controller has connected workers for this cluster
  if (clusterWorkers.length === 0 && options.controller) {
    const connected = options.controller.getClusterWorkers(target);
    if (connected.length > 0) {
      clusterWorkers = connected.map(w => ({
        name: `${target}-${w.slot}-g${w.generation}`,
        loaded: "loaded",
        active: w.status === "ready" ? "active" : "inactive",
        sub: w.status === "ready" ? "running" : "stopped",
        state: w.status,
        cpu: "-",
        memory: "-",
        uptime: "-",
        tasks: "-",
        pid: String(w.pid),
        description: `BS9 Cluster Worker ${target}-${w.slot}-g${w.generation}`,
        slot: w.slot,
        generation: w.generation,
        appName: target,
        logicalSlot: `${target}-${w.slot}`,
      }));
    }
  }

  if (clusterWorkers.length >= 1) {
    await reloadClusterApp(target, options, clusterWorkers);
    return;
  }

  // Fallback to smooth restart if not a cluster
  console.log(`🔄 Reloading service '${target}'...`);
  await restartCommand(names, options);
}

async function reloadClusterApp(
  appName: string,
  options: ReloadOptions = {},
  initialWorkers?: ServiceMetrics[]
): Promise<void> {
  let clusterWorkers = initialWorkers;
  if (!clusterWorkers) {
    const allServices = await listServices();
    clusterWorkers = allServices.filter(s => {
      const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
      return new RegExp(`^${appName}-\\d+(-g\\d+)?$`).test(clean);
    });

    if (clusterWorkers.length === 0 && options.controller) {
      const connected = options.controller.getClusterWorkers(appName);
      if (connected.length > 0) {
        clusterWorkers = connected.map(w => ({
          name: `${appName}-${w.slot}-g${w.generation}`,
          loaded: "loaded",
          active: w.status === "ready" ? "active" : "inactive",
          sub: w.status === "ready" ? "running" : "stopped",
          state: w.status,
          cpu: "-",
          memory: "-",
          uptime: "-",
          tasks: "-",
          pid: String(w.pid),
          description: `BS9 Cluster Worker ${appName}-${w.slot}-g${w.generation}`,
          slot: w.slot,
          generation: w.generation,
          appName: appName,
          logicalSlot: `${appName}-${w.slot}`,
        }));
      }
    }
  }


  // Group workers by slot
  const slotMap = new Map<number, ServiceMetrics[]>();
  for (const w of clusterWorkers) {
    const info = parseWorkerSlot(w.name);
    if (info) {
      const list = slotMap.get(info.slot) || [];
      list.push(w);
      slotMap.set(info.slot, list);
    }
  }

  const sortedSlots = Array.from(slotMap.keys()).sort((a, b) => a - b);
  const totalSlots = sortedSlots.length;
  const readyTimeoutMs = options.readyTimeoutMs || READY_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs || DRAIN_TIMEOUT_MS;
  const minimumReady = options.minimumReady !== undefined ? options.minimumReady : Math.max(1, totalSlots);

  console.log(`🔄 Performing Replace-First Rolling Reload for cluster '${appName}' (${totalSlots} slots, minimumReady: ${minimumReady})...`);

  let adminClient: ControllerAdminClient | null = null;
  let ownAdminClient = false;

  if (options.adminClient) {
    adminClient = options.adminClient;
  } else if (!options.controller) {
    await ensureDaemonRunning();
    adminClient = new ControllerAdminClient();
    await adminClient.connect();
    ownAdminClient = true;
  }

  // Acquire operation lock on reconciler during reload transition with renewal heartbeat
  let lockSession: ClusterLockSession | null = null;
  if (adminClient) {
    const lockResult = await adminClient.lockCluster(appName, "reload", 60000, "reload-command");
    if (!lockResult.locked || !lockResult.lockToken) {
      if (ownAdminClient) adminClient.disconnect();
      throw new Error(`Cluster '${appName}' is locked for '${lockResult.reason}' by ${lockResult.currentOwner || "another operation"}`);
    }
    lockSession = new ClusterLockSession(adminClient, appName, lockResult.lockToken, {
      renewIntervalMs: 15000,
      extendMs: 60000,
      onLost: (err) => console.error(`❌ [ClusterLock] ${err.message}`),
    });
    lockSession.start();
  }

  try {
    for (const slot of sortedSlots) {
      if (lockSession) {
        await lockSession.assertActive();
      }
      const workersForSlot = slotMap.get(slot) || [];
      // Identify current worker: running worker, or worker with highest generation
      const currentWorker =
        workersForSlot.find(w => w.active === "active") ||
        workersForSlot.sort((a, b) => (b.generation || 0) - (a.generation || 0))[0];

      const currentGen = currentWorker?.generation || 1;
      const nextGen = currentGen + 1;
      const currentPhysicalName = currentWorker
        ? currentWorker.name.replace(/^(BS9_|bs9\.)/, "")
        : `${appName}-${slot}-g${currentGen}`;
      const nextPhysicalName = `${appName}-${slot}-g${nextGen}`;

      console.log(`   ⏳ Slot ${slot}: Spawning replacement worker generation g${nextGen} (${nextPhysicalName})...`);

      // 1. Spawn replacement worker physical unit with generation g<nextGen>
      await spawnReplacementWorker(appName, slot, currentGen, nextGen, currentWorker, options, options.controller);
      await lockSession?.assertActive();

      // 2. Wait up to READY_TIMEOUT_MS (15s) for replacement to emit READY via lifecycle controller
      const isReady = await waitForSlotReady(options.controller, adminClient, appName, slot, nextGen, readyTimeoutMs, lockSession);
      await lockSession?.assertActive();

      // 3. If replacement fails readiness: abort reload, tear down replacement, keep old worker active
      if (!isReady) {
        console.error(`   ❌ Replacement worker '${nextPhysicalName}' failed readiness within ${readyTimeoutMs}ms!`);
        console.warn(`   ⚠️  Aborting reload: tearing down replacement '${nextPhysicalName}', keeping old worker active.`);

        await teardownReplacementWorker(appName, slot, nextGen, nextPhysicalName, options);

        let activeReadyCount = 0;
        if (options.controller) {
          activeReadyCount = options.controller.getClusterWorkers(appName).filter(w => w.status === "ready").length;
        } else if (adminClient) {
          const workers = await adminClient.getClusterWorkers(appName);
          activeReadyCount = workers.filter(w => w.status === "ready").length;
        }
        console.warn(`   🔒 Capacity preserved: ${activeReadyCount} ready worker(s) online (minimumReady: ${minimumReady}).`);

        throw new Error(`Rolling reload aborted: replacement worker '${nextPhysicalName}' failed readiness check`);
      }

      // 4. Replacement reports READY: trigger two-phase drain on old worker
      console.log(`   ✅ Replacement worker '${nextPhysicalName}' is READY.`);
      console.log(`   ⏳ Triggering two-phase drain on old worker '${currentPhysicalName}' (gen ${currentGen})...`);

      let inFlightRemaining = 0;
      if (options.controller) {
        const drainResult = await options.controller.drainWorker(appName, slot, currentGen, drainTimeoutMs);
        inFlightRemaining = drainResult.inFlightRemaining;
      } else if (adminClient) {
        const drainResult = await adminClient.drainWorker(appName, slot, currentGen, drainTimeoutMs);
        inFlightRemaining = drainResult.inFlightRemaining;
      }
      await lockSession?.assertActive();
      console.log(`   📦 Drained old worker '${currentPhysicalName}' (inFlightRemaining: ${inFlightRemaining}).`);

      // 5. Stop and delete old physical service unit
      console.log(`   🛑 Stopping old physical service unit '${currentPhysicalName}'...`);
      await stopAndCleanupOldWorker(appName, slot, currentGen, currentPhysicalName, options);
      await lockSession?.assertActive();
      console.log(`   ✨ Slot ${slot} successfully upgraded to generation g${nextGen}!`);
    }

    // Update desired-state manifest generation
    if (adminClient) {
      await lockSession?.assertActive();
      try {
        const manifest = await adminClient.getManifest(appName);
        if (manifest) {
          manifest.currentGeneration = (manifest.currentGeneration || 1) + 1;
          await adminClient.setManifest(manifest);
        }
      } catch {}
    }

    console.log(`✅ Rolling reload completed with zero downtime for '${appName}'!`);
  } finally {
    if (lockSession) {
      await lockSession.release();
    }
    if (adminClient && ownAdminClient) {
      adminClient.disconnect();
    }
  }
}

async function waitForSlotReady(
  controller: ClusterController | undefined,
  adminClient: ControllerAdminClient | null,
  appName: string,
  slot: number,
  gen: number,
  timeoutMs: number,
  lockSession?: ClusterLockSession | null
): Promise<boolean> {
  const startTime = Date.now();

  if (controller) {
    if (controller.isSlotReady(appName, slot, gen)) {
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      let resolved = false;
      let pollTimer: any = null;

      const cleanup = () => {
        resolved = true;
        if (pollTimer) clearInterval(pollTimer);
        clearTimeout(timer);
        controller.off("worker:ready", onReady);
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          cleanup();
          resolve(controller.isSlotReady(appName, slot, gen));
        }
      }, timeoutMs);

      const onReady = (worker: any) => {
        if (
          worker.clusterName === appName &&
          worker.slot === slot &&
          worker.generation === gen
        ) {
          if (!resolved) {
            cleanup();
            resolve(true);
          }
        }
      };

      controller.on("worker:ready", onReady);

      pollTimer = setInterval(() => {
        try {
          lockSession?.checkActive();
        } catch (error) {
          if (!resolved) {
            cleanup();
            reject(error);
          }
          return;
        }
        if (controller.isSlotReady(appName, slot, gen)) {
          if (!resolved) {
            cleanup();
            resolve(true);
          }
        }
      }, 100);
    });
  }

  if (adminClient) {
    while (Date.now() - startTime < timeoutMs) {
      await lockSession?.assertActive();
      try {
        const ready = await adminClient.isSlotReady(appName, slot, gen);
        if (ready) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await lockSession?.assertActive();
    try {
      return await adminClient.isSlotReady(appName, slot, gen);
    } catch {
      return false;
    }
  }

  return false;
}

async function spawnReplacementWorker(
  appName: string,
  slot: number,
  currentGen: number,
  nextGen: number,
  currentWorker: ServiceMetrics | undefined,
  options: ReloadOptions,
  controller?: ClusterController
): Promise<void> {
  const nextPhysicalName = `${appName}-${slot}-g${nextGen}`;

  if (options.spawnWorker) {
    await options.spawnWorker(slot, nextGen, appName, nextPhysicalName);
    return;
  }

  const platformInfo = getPlatformInfo();
  const currentPhysicalName = currentWorker
    ? currentWorker.name.replace(/^(BS9_|bs9\.)/, "")
    : `${appName}-${slot}-g${currentGen}`;

  if (platformInfo.isWindows) {
    const { WindowsServiceManager } = await import("../windows/service.js");
    const manager = new WindowsServiceManager();
    const currentConfig =
      manager.getProcessMetadata(`BS9_${currentPhysicalName}`) ||
      manager.getProcessMetadata(currentPhysicalName);

    if (currentConfig) {
      const tokenFilePath = join(platformInfo.runtimeDir, "tokens", `${appName}.token`);
      const newEnv = {
        ...(currentConfig.environment || {}),
        BS9_CLUSTER: "true",
        BS9_REUSE_PORT: "true",
        BS9_CLUSTER_NAME: appName,
        BS9_CLUSTER_ID: String(slot),
        NODE_APP_INSTANCE: String(slot),
        BS9_CLUSTER_GENERATION: String(nextGen),
        SERVICE_NAME: nextPhysicalName,
        BS9_AUTH_TOKEN_FILE: tokenFilePath,
        BS9_CONTROLLER_SOCKET: controller ? controller.getSocketPath() : platformInfo.socketPath,
      };

      const newConfig = {
        ...currentConfig,
        name: `BS9_${nextPhysicalName}`,
        displayName: `BS9 Service: ${nextPhysicalName}`,
        description: `BS9 managed service: ${nextPhysicalName} (gen ${nextGen})`,
        environment: newEnv,
        status: 'stopped',
        pid: undefined,
      };

      await manager.createService(newConfig);
      await manager.startService(newConfig.name);
    }
  } else if (platformInfo.isLinux) {
    const serviceFile = join(platformInfo.serviceDir, `${currentPhysicalName}.service`);
    if (existsSync(serviceFile)) {
      let content = readFileSync(serviceFile, "utf-8");
      content = content.replace(new RegExp(currentPhysicalName, "g"), nextPhysicalName);
      content = content.replace(
        new RegExp(`BS9_CLUSTER_GENERATION=${currentGen}`, "g"),
        `BS9_CLUSTER_GENERATION=${nextGen}`
      );
      const newServiceFile = join(platformInfo.serviceDir, `${nextPhysicalName}.service`);
      writeFileSync(newServiceFile, content, "utf-8");
      try { startUserSystemdUnit(newServiceFile, `${nextPhysicalName}.service`); } catch {}

    }
  } else if (platformInfo.isMacOS) {
    const { launchdCommand } = await import("../macos/launchd.js");
    const configPath = join(platformInfo.configDir, 'launchd-services.json');
    if (existsSync(configPath)) {
      try {
        const configs = JSON.parse(readFileSync(configPath, 'utf-8'));
        const oldLabel = `bs9.${currentPhysicalName}`;
        if (configs[oldLabel]) {
          const newLabel = `bs9.${nextPhysicalName}`;
          const newCfg = { ...configs[oldLabel], name: newLabel };
          if (newCfg.env) {
            const parsedEnv = JSON.parse(newCfg.env);
            parsedEnv.BS9_CLUSTER_GENERATION = String(nextGen);
            parsedEnv.SERVICE_NAME = nextPhysicalName;
            newCfg.env = JSON.stringify(parsedEnv);
          }
          await launchdCommand('create', newCfg);
          await launchdCommand('start', { name: newLabel });
        }
      } catch {}
    }
  }
}

async function teardownReplacementWorker(
  appName: string,
  slot: number,
  nextGen: number,
  nextPhysicalName: string,
  options: ReloadOptions
): Promise<void> {
  if (options.stopWorker) {
    await options.stopWorker(slot, nextGen, appName, nextPhysicalName);
    return;
  }

  try {
    await stopCommand([nextPhysicalName], { force: true });
    await deleteCommand([nextPhysicalName], { force: true, remove: true });
  } catch {}
}

async function stopAndCleanupOldWorker(
  appName: string,
  slot: number,
  currentGen: number,
  currentPhysicalName: string,
  options: ReloadOptions
): Promise<void> {
  if (options.stopWorker) {
    await options.stopWorker(slot, currentGen, appName, currentPhysicalName);
    return;
  }

  try {
    await stopCommand([currentPhysicalName], { force: true });
    await deleteCommand([currentPhysicalName], { force: true, remove: true });
  } catch {}
}
