#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";
import { parseServiceArray, confirmAction, displayBatchResults } from "../utils/array-parser.js";
import { listServices } from "../utils/service-discovery.js";

interface RestartOptions {
  force?: boolean;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return (
    validPattern.test(name) &&
    name.length > 0 &&
    name.length <= 64 &&
    !name.startsWith("-") &&
    name !== "." &&
    !name.includes('..') &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

export async function restartCommand(names: string[], options: RestartOptions = {}): Promise<void> {
  const { recordAuditEvent } = await import("../utils/audit-log.js");
  const targetLabel = names.join(",") || "unknown";
  try {
    // Handle multi-service if: multiple args, single arg with array/wildcard syntax, or 'all' keyword
    if (names.length > 1 || (names.length === 1 && (names[0].includes('[') || names[0].includes('*') || names[0] === 'all'))) {
      await handleMultiServiceRestart(names, options);
      recordAuditEvent({ action: "restart", target: targetLabel, status: "success" });
      return;
    }

    // Single service operation
    await handleSingleServiceRestart(names[0] || '');
    recordAuditEvent({ action: "restart", target: targetLabel, status: "success" });
  } catch (err: any) {
    recordAuditEvent({ action: "restart", target: targetLabel, status: "failure", details: err?.message ? String(err.message) : "error" });
    throw err;
  }
}

async function handleMultiServiceRestart(name: string | string[], options: RestartOptions): Promise<void> {
  const services = await parseServiceArray(name);

  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }

  // Safety confirmation for bulk operations
  if (services.length > 1 && !options.force) {
    console.log(`⚠️  About to restart ${services.length} services:`);
    services.forEach(service => console.log(`   - ${service}`));

    const confirmed = await confirmAction('Are you sure? (y/N): ');
    if (!confirmed) {
      console.log('❌ Restart operation cancelled');
      return;
    }
  }

  console.log(`🔄 Restarting ${services.length} services...`);

  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        await handleSingleServiceRestart(serviceName);
        return { service: serviceName, status: 'success', error: null };
      } catch (error) {
        return { service: serviceName, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  displayBatchResults(results, 'restart');
}

async function handleSingleServiceRestart(name: string): Promise<void> {
  // Security: Validate service name
  if (!isValidServiceName(name)) {
    throw new Error(`Security: Invalid service name: ${name}`);
  }

  const clean = name.replace(/^(BS9_|bs9\.)/, "");
  const escapedClean = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allServices = await listServices();

  // 1. Logical slot match (e.g. "api-0" matching "api-0-g1", "api-0-g2")
  const slotWorkers = allServices.filter(s => {
    const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return new RegExp(`^${escapedClean}-g\\d+$`).test(sClean);
  });

  if (slotWorkers.length > 0) {
    for (const w of slotWorkers) {
      const wClean = w.name.replace(/^(BS9_|bs9\.)/, "");
      await restartDirectService(wClean);
    }
    return;
  }

  // 2. Cluster app match (e.g. "api" matching "api-0-g1", "api-1-g1")
  const clusterWorkers = allServices.filter(s => {
    const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return new RegExp(`^${escapedClean}-\\d+(-g\\d+)?$`).test(sClean);
  });

  if (clusterWorkers.length > 0) {
    for (const w of clusterWorkers) {
      const wClean = w.name.replace(/^(BS9_|bs9\.)/, "");
      await restartDirectService(wClean);
    }
    return;
  }

  await restartDirectService(name);
}

async function restartDirectService(name: string): Promise<void> {
  const platformInfo = getPlatformInfo();

  if (platformInfo.isLinux) {
    const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
    const unitPath = join(platformInfo.serviceDir, `${escapedName}.service`);
    if (existsSync(unitPath)) {
      ensurePrivateDirectory(platformInfo.serviceDir);
      securePrivateFile(unitPath);
    }
    const res = spawnSync("systemctl", ["--user", "restart", escapedName], { stdio: "inherit" });
    if (res.status !== 0) {
      throw new Error(`systemctl --user restart failed with exit code ${res.status ?? 1}`);
    }
    console.log(`🔄 User service '${name}' restarted`);
  } else if (platformInfo.isMacOS) {
    const { launchdCommand } = await import("../macos/launchd.js");
    await launchdCommand('restart', { name: name.startsWith('bs9.') ? name : `bs9.${name}` });
  } else if (platformInfo.isWindows) {
    const { WindowsServiceManager } = await import("../windows/service.js");
    const manager = new WindowsServiceManager();
    const fullName = name.startsWith('BS9_') ? name : `BS9_${name}`;
    // Stop first (ignore error if already stopped), then always attempt start
    try {
      await manager.stopService(fullName);
    } catch {
      // Service may already be stopped — proceed to start
    }
    try {
      await manager.startService(fullName);
    } catch (startErr) {
      throw new Error(`Restart failed: service stopped but could not start: ${startErr}`);
    }
  }
}

