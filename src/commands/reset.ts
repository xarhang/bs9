#!/usr/bin/env bun

/**
 * BS9 - Reset Command
 * Resets restart counters, crash loop histories, and circuit breaker states for a service.
 * Mirrors `pm2 reset <app>`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { forceResetCircuit } from "../utils/crash-tracker.js";
import { listServices } from "../utils/service-discovery.js";

export async function resetCommand(names: string[] = []): Promise<void> {
  const target = names[0] || "all";

  const allServices = await listServices();

  let targetServices: string[] = [];

  if (target === "all") {
    targetServices = allServices.map(s => s.name);
  } else {
    const cleanTarget = target.replace(/^(BS9_|bs9\.)/, "");
    // Find matching services or cluster workers
    targetServices = allServices
      .map(s => s.name)
      .filter(name => {
        const clean = name.replace(/^(BS9_|bs9\.)/, "");
        return clean === cleanTarget || clean.startsWith(`${cleanTarget}-`);
      });

    if (targetServices.length === 0) {
      // Direct reset attempt anyway
      targetServices = [cleanTarget];
    }
  }

  for (const service of targetServices) {
    const clean = service.replace(/^(BS9_|bs9\.)/, "");
    forceResetCircuit(clean);
    forceResetCircuit(`BS9_${clean}`);
    console.log(`🔄 Restart counters and crash loop history reset for '${clean}'`);
  }

  console.log(`✅ Reset complete for ${targetServices.length} service(s)`);
}
