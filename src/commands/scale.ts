#!/usr/bin/env bun

/**
 * BS9 - Scale Command
 * Dynamically scales cluster workers up or down without full application downtime.
 * Mirrors `pm2 scale <app> <N|+N|-N>`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { listServices } from "../utils/service-discovery.js";
import { stopCommand } from "./stop.js";
import { deleteCommand } from "./delete.js";
import { getPlatformInfo } from "../platform/detect.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escapeRegExp } from "../utils/array-parser.js";

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function scaleCommand(name: string, countStr: string): Promise<void> {
  if (!name || !countStr) {
    console.error("❌ Usage: bs9 scale <app-name> <instances|+N|-N>");
    process.exit(1);
  }

  const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
  if (!isValidServiceName(cleanName)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const allServices = await listServices();

  // Find all current workers
  const safeClean = escapeRegExp(cleanName);
  const workers = allServices
    .filter(s => {
      const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
      const isWorker = new RegExp(`^${safeClean}-\\d+(-g\\d+)?$`).test(clean);
      return clean === cleanName || isWorker;
    })
    .sort((a, b) => {
      if (a.slot !== undefined && b.slot !== undefined) {
        return a.slot - b.slot;
      }
      const matchA = a.name.match(/-(\d+)(?:-g\d+)?$/);
      const matchB = b.name.match(/-(\d+)(?:-g\d+)?$/);
      const idxA = matchA ? Number(matchA[1]) : 0;
      const idxB = matchB ? Number(matchB[1]) : 0;
      return idxA - idxB;
    });

  if (workers.length === 0) {
    console.error(`❌ Service '${name}' not found. Start it first with: bs9 start <file> -n ${name} -i 1`);
    process.exit(1);
  }

  const currentCount = workers.length;
  let targetCount: number;

  if (countStr.startsWith("+")) {
    targetCount = currentCount + parseInt(countStr.slice(1), 10);
  } else if (countStr.startsWith("-")) {
    targetCount = currentCount - parseInt(countStr.slice(1), 10);
  } else {
    targetCount = parseInt(countStr, 10);
  }

  if (isNaN(targetCount) || targetCount < 1) {
    console.error(`❌ Invalid instance target '${countStr}'. Must be a positive integer or relative +/- offset.`);
    process.exit(1);
  }

  if (targetCount === currentCount) {
    console.log(`ℹ️  Cluster '${cleanName}' is already at ${targetCount} worker(s). No change needed.`);
    return;
  }

  const platformInfo = getPlatformInfo();

  let adminClient: any = null;
  let lockSession: any = null;
  let operationCompleted = false;
  const { ensureDaemonRunning } = await import("../daemon/ensure.js");
  await ensureDaemonRunning();
  const { ControllerAdminClient, ClusterLockSession } = await import("../cluster/admin-client.js");
  const client = new ControllerAdminClient();
  if (!(await client.connect())) {
    throw new Error(`Cannot scale '${cleanName}': BS9 daemon lock authority is unavailable`);
  }
  adminClient = client;
  const lockResult = await adminClient.lockCluster(cleanName, "scale", 60000, "scale-command");
  if (!lockResult.locked || !lockResult.lockToken) {
    adminClient.disconnect();
    throw new Error(`Cluster '${cleanName}' is locked for '${lockResult.reason}' by ${lockResult.currentOwner || "another operation"}`);
  }
  lockSession = new ClusterLockSession(adminClient, cleanName, lockResult.lockToken, {
    renewIntervalMs: 15000,
    extendMs: 60000,
    onLost: (err: any) => console.error(`❌ [ClusterLock] ${err.message}`),
  });
  lockSession.start();

  try {
    if (lockSession) {
      await lockSession.assertActive();
    }
    if (targetCount > currentCount) {
    // Scaling UP: add workers
    const toAdd = targetCount - currentCount;
    console.log(`📈 Scaling up '${cleanName}' from ${currentCount} to ${targetCount} workers (+${toAdd})...`);

    // Retrieve base configuration from existing worker
    const baseWorker = workers[0];
    const baseClean = baseWorker.name.replace(/^(BS9_|bs9\.)/, "");
    const generation = baseWorker.generation || 1;

    if (platformInfo.isWindows) {
      const servicesDir = platformInfo.serviceDir;
      const baseMetaPath = join(servicesDir, `BS9_${baseClean}.json`);

      if (!existsSync(baseMetaPath)) {
        throw new Error(`Cannot find base configuration for '${baseWorker.name}' in ${servicesDir}`);
      }

      const baseMeta = JSON.parse(readFileSync(baseMetaPath, "utf-8"));
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();

      for (let i = currentCount; i < targetCount; i++) {
        await lockSession.assertActive();
        const workerName = `${cleanName}-${i}-g${generation}`;
        const newMeta = {
          ...baseMeta,
          name: `BS9_${workerName}`,
          description: `BS9 managed cluster worker: ${workerName}`,
          environment: {
            ...baseMeta.environment,
            BS9_CLUSTER: "true",
            BS9_CLUSTER_NAME: cleanName,
            BS9_CLUSTER_ID: String(i),
            NODE_APP_INSTANCE: String(i),
            BS9_CLUSTER_TOTAL: String(targetCount),
            BS9_CLUSTER_GENERATION: baseMeta.environment?.BS9_CLUSTER_GENERATION || "1",
            BS9_REUSE_PORT: "true",
            BS9_AUTH_TOKEN_FILE: baseMeta.environment?.BS9_AUTH_TOKEN_FILE || "",
            SERVICE_NAME: workerName
          },
          status: "stopped",
          pid: null,
          watchdogPid: null
        };

        const targetMetaPath = join(servicesDir, `BS9_${workerName}.json`);
        writeFileSync(targetMetaPath, JSON.stringify(newMeta, null, 2));
        await lockSession.assertActive();

        console.log(`   ➕ Starting worker ${workerName}...`);
        await manager.startService(`BS9_${workerName}`);
        await lockSession.assertActive();
      }
    } else if (platformInfo.isLinux) {
      // Linux systemd unit scaling
      const userUnitDir = platformInfo.serviceDir;
      const baseUnitPath = join(userUnitDir, `${baseClean}.service`);

      if (!existsSync(baseUnitPath)) {
        throw new Error(`Base systemd unit '${baseClean}.service' not found`);
      }

      const baseContent = readFileSync(baseUnitPath, "utf-8");

      for (let i = currentCount; i < targetCount; i++) {
        await lockSession.assertActive();
        const workerName = `${cleanName}-${i}-g${generation}`;
        const newUnitPath = join(userUnitDir, `${workerName}.service`);
        const newContent = baseContent
          .replace(new RegExp(`Description=BS9 Service: ${baseClean}`, "g"), `Description=BS9 Service: ${workerName}`)
          .replace(new RegExp(`SERVICE_NAME=${baseClean}`, "g"), `SERVICE_NAME=${workerName}`)
          .replace(new RegExp(`SyslogIdentifier=${baseClean}`, "g"), `SyslogIdentifier=${workerName}`)
          .replace(/BS9_CLUSTER_ID=\d+/, `BS9_CLUSTER_ID=${i}\nEnvironment=NODE_APP_INSTANCE=${i}`)
          .replace(/BS9_CLUSTER_TOTAL=\d+/, `BS9_CLUSTER_TOTAL=${targetCount}`);

        writeFileSync(newUnitPath, newContent);
        await lockSession.assertActive();
        const { execSync } = await import("node:child_process");
        execSync(`systemctl --user daemon-reload`, { stdio: "ignore" });
        execSync(`systemctl --user enable --now ${workerName}.service`, { stdio: "ignore" });
        await lockSession.assertActive();
        console.log(`   ➕ Started worker ${workerName}`);
      }
    } else if (platformInfo.isMacOS) {
      // macOS launchd scaling through the manager so its config registry stays
      // consistent with the loaded plist files.
      const configPath = join(platformInfo.configDir, "launchd-services.json");
      if (!existsSync(configPath)) {
        throw new Error(`macOS launchd registry not found: ${configPath}`);
      }
      const configs = JSON.parse(readFileSync(configPath, "utf-8"));
      const baseConfig = configs[`bs9.${baseClean}`];
      if (!baseConfig) {
        throw new Error(`Base macOS launchd service 'bs9.${baseClean}' not found`);
      }
      const { launchdCommand } = await import("../macos/launchd.js");

      for (let i = currentCount; i < targetCount; i++) {
        await lockSession.assertActive();
        const workerName = `${cleanName}-${i}-g${generation}`;
        const environmentVariables = {
          ...(baseConfig.environmentVariables || {}),
          BS9_CLUSTER: "true",
          BS9_CLUSTER_NAME: cleanName,
          BS9_CLUSTER_ID: String(i),
          NODE_APP_INSTANCE: String(i),
          BS9_CLUSTER_TOTAL: String(targetCount),
          BS9_CLUSTER_GENERATION: String(generation),
          SERVICE_NAME: workerName,
        };
        await launchdCommand("create", {
          name: `bs9.${workerName}`,
          file: baseConfig.programArguments?.[0],
          args: baseConfig.programArguments?.slice(1) || [],
          workingDir: baseConfig.workingDirectory,
          env: JSON.stringify(environmentVariables),
          autoStart: baseConfig.runAtLoad,
          keepAlive: baseConfig.keepAlive,
          logOut: baseConfig.standardOutPath,
          logErr: baseConfig.standardErrorPath,
        });
        await lockSession.assertActive();
        console.log(`   ➕ Started worker ${workerName}`);
      }
    }

    console.log(`✅ Successfully scaled up '${cleanName}' to ${targetCount} worker(s)!`);
  } else {
    // Scaling DOWN: remove workers from the top
    const toRemove = currentCount - targetCount;
    console.log(`📉 Scaling down '${cleanName}' from ${currentCount} to ${targetCount} workers (-${toRemove})...`);

    for (let i = currentCount - 1; i >= targetCount; i--) {
      await lockSession.assertActive();
      const worker = workers[i];
      console.log(`   ➖ Stopping and removing worker ${worker.name}...`);
      try {
        await stopCommand([worker.name], { force: true });
        await lockSession.assertActive();
        await deleteCommand([worker.name], { force: true, remove: true });
        await lockSession.assertActive();
      } catch (err) {
        console.warn(`   ⚠️ Warning while stopping ${worker.name}: ${err}`);
      }
    }

    console.log(`✅ Successfully scaled down '${cleanName}' to ${targetCount} worker(s)!`);
  }
    await lockSession.assertActive();
    operationCompleted = true;
  } finally {
    if (adminClient) {
      try {
        if (operationCompleted && lockSession && !lockSession.isLost()) {
          await lockSession.assertActive();
          const manifest = await adminClient.getManifest(cleanName);
          if (manifest) {
            manifest.instances = targetCount;
            manifest.updatedAt = Date.now();
            await adminClient.setManifest(manifest);
            await lockSession.assertActive();
          }
        }
      } finally {
        if (lockSession) {
          await lockSession.release();
        }
        adminClient.disconnect();
      }
    }
  }
}
