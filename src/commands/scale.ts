#!/usr/bin/env bun

/**
 * BS9 - Scale Command
 * Dynamically scales cluster workers up or down without full application downtime.
 * Mirrors `pm2 scale <app> <N|+N|-N>`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { listServices } from "../utils/service-discovery.js";
import { stopCommand } from "./stop.js";
import { deleteCommand } from "./delete.js";
import { getPlatformInfo } from "../platform/detect.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export async function scaleCommand(name: string, countStr: string): Promise<void> {
  if (!name || !countStr) {
    console.error("❌ Usage: bs9 scale <app-name> <instances|+N|-N>");
    process.exit(1);
  }

  const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
  const allServices = await listServices();

  // Find all current workers
  const workers = allServices
    .filter(s => {
      const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
      return clean === cleanName || (clean.startsWith(`${cleanName}-`) && !isNaN(Number(clean.split("-").pop())));
    })
    .sort((a, b) => {
      const idxA = Number(a.name.split("-").pop()) || 0;
      const idxB = Number(b.name.split("-").pop()) || 0;
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

  if (targetCount > currentCount) {
    // Scaling UP: add workers
    const toAdd = targetCount - currentCount;
    console.log(`📈 Scaling up '${cleanName}' from ${currentCount} to ${targetCount} workers (+${toAdd})...`);

    // Retrieve base configuration from existing worker
    const baseWorker = workers[0];
    const baseClean = baseWorker.name.replace(/^(BS9_|bs9\.)/, "");

    if (platformInfo.isWindows) {
      const servicesDir = join(homedir(), ".bs9", "services");
      const baseMetaPath = join(servicesDir, `BS9_${baseClean}.json`);

      if (!existsSync(baseMetaPath)) {
        console.error(`❌ Cannot find base configuration for '${baseWorker.name}' in ${servicesDir}`);
        process.exit(1);
      }

      const baseMeta = JSON.parse(readFileSync(baseMetaPath, "utf-8"));
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();

      for (let i = currentCount; i < targetCount; i++) {
        const workerName = `${cleanName}-${i}`;
        const newMeta = {
          ...baseMeta,
          name: `BS9_${workerName}`,
          description: `BS9 managed cluster worker: ${workerName}`,
          environment: {
            ...baseMeta.environment,
            BS9_CLUSTER: "true",
            BS9_CLUSTER_ID: String(i),
            BS9_CLUSTER_TOTAL: String(targetCount),
            BS9_REUSE_PORT: "true",
            SERVICE_NAME: workerName
          },
          status: "stopped",
          pid: null,
          watchdogPid: null
        };

        const targetMetaPath = join(servicesDir, `BS9_${workerName}.json`);
        writeFileSync(targetMetaPath, JSON.stringify(newMeta, null, 2));

        console.log(`   ➕ Starting worker ${workerName}...`);
        await manager.startService(`BS9_${workerName}`);
      }
    } else if (platformInfo.isLinux) {
      // Linux systemd unit scaling
      const userUnitDir = join(homedir(), ".config", "systemd", "user");
      const baseUnitPath = join(userUnitDir, `${baseClean}.service`);

      if (!existsSync(baseUnitPath)) {
        console.error(`❌ Base systemd unit '${baseClean}.service' not found`);
        process.exit(1);
      }

      const baseContent = readFileSync(baseUnitPath, "utf-8");

      for (let i = currentCount; i < targetCount; i++) {
        const workerName = `${cleanName}-${i}`;
        const newUnitPath = join(userUnitDir, `${workerName}.service`);
        const newContent = baseContent
          .replace(new RegExp(baseClean, "g"), workerName)
          .replace(/BS9_CLUSTER_ID=\d+/, `BS9_CLUSTER_ID=${i}`)
          .replace(/BS9_CLUSTER_TOTAL=\d+/, `BS9_CLUSTER_TOTAL=${targetCount}`);

        writeFileSync(newUnitPath, newContent);
        const { execSync } = await import("node:child_process");
        execSync(`systemctl --user daemon-reload`, { stdio: "ignore" });
        execSync(`systemctl --user enable --now ${workerName}.service`, { stdio: "ignore" });
        console.log(`   ➕ Started worker ${workerName}`);
      }
    }

    console.log(`✅ Successfully scaled up '${cleanName}' to ${targetCount} worker(s)!`);
  } else {
    // Scaling DOWN: remove workers from the top
    const toRemove = currentCount - targetCount;
    console.log(`📉 Scaling down '${cleanName}' from ${currentCount} to ${targetCount} workers (-${toRemove})...`);

    for (let i = currentCount - 1; i >= targetCount; i--) {
      const worker = workers[i];
      console.log(`   ➖ Stopping and removing worker ${worker.name}...`);
      try {
        await stopCommand([worker.name], { force: true });
        await deleteCommand([worker.name], { force: true, remove: true });
      } catch (err) {
        console.warn(`   ⚠️ Warning while stopping ${worker.name}: ${err}`);
      }
    }

    console.log(`✅ Successfully scaled down '${cleanName}' to ${targetCount} worker(s)!`);
  }
}
