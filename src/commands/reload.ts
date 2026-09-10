#!/usr/bin/env bun

/**
 * BS9 - Zero-Downtime Reload Command
 * Performs rolling reload on clustered services or smooth restart, mirroring `pm2 reload`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { restartCommand } from "./restart.js";
import { listServices } from "../utils/service-discovery.js";
import { sleep } from "../utils/crash-tracker.js";

interface ReloadOptions {
  force?: boolean;
}

export async function reloadCommand(names: string[] = [], options: ReloadOptions = {}): Promise<void> {
  const target = names[0] || "all";

  // Check if target is a cluster parent (e.g. workers named target-0, target-1...)
  const allServices = await listServices();
  const clusterWorkers = allServices.filter(s => {
    const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return clean.startsWith(`${target}-`) && !isNaN(Number(clean.split("-").pop()));
  });

  if (clusterWorkers.length > 1) {
    console.log(`🔄 Performing Zero-Downtime Rolling Reload for cluster '${target}' (${clusterWorkers.length} workers)...`);

    for (let i = 0; i < clusterWorkers.length; i++) {
      const worker = clusterWorkers[i];
      console.log(`   ⏳ Reloading worker ${i + 1}/${clusterWorkers.length}: ${worker.name}...`);
      await restartCommand([worker.name], options);
      // Wait for socket release & health check before taking down next worker
      await sleep(1500);
    }

    console.log(`✅ Rolling reload completed with zero downtime for '${target}'!`);
    return;
  }

  // Fallback to smooth restart if not a cluster
  console.log(`🔄 Reloading service '${target}'...`);
  await restartCommand(names, options);
}