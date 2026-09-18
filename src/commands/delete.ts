#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, confirmAction, displayBatchResults, escapeRegExp } from "../utils/array-parser.js";
import { listServices, parseWorkerSlot, type ServiceMetrics } from "../utils/service-discovery.js";

interface DeleteOptions {
  all?: boolean;
  force?: boolean;
  remove?: boolean;
  timeout?: string;
}

// Security: Service name validation
export function isValidServiceName(name: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, and dots
  // Prevent command injection and path traversal
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export function shouldUseMultiServiceDelete(names: string[]): boolean {
  return names.length > 1 || (
    names.length === 1 &&
    (names[0].includes('[') || names[0].includes('*') || names[0] === 'all')
  );
}

/**
 * Returns HA cluster names for which the requested targets cover every
 * currently discovered worker. Retiring those clusters' desired-state
 * manifests before stopping workers prevents the reconciler from immediately
 * creating replacement generations during a delete operation.
 */
export function findFullyCoveredClusters(
  targets: string[],
  services: Pick<ServiceMetrics, "name">[],
): string[] {
  const cleanTargets = new Set(targets.map(name => name.replace(/^(BS9_|bs9\.)/, "")));
  const workersByCluster = new Map<string, ReturnType<typeof parseWorkerSlot>[]>();

  for (const service of services) {
    const worker = parseWorkerSlot(service.name);
    if (!worker) continue;
    const workers = workersByCluster.get(worker.appName) || [];
    workers.push(worker);
    workersByCluster.set(worker.appName, workers);
  }

  const coveredClusters: string[] = [];
  for (const [clusterName, workers] of workersByCluster) {
    const fullyCovered = workers.every(worker => worker !== null && (
      cleanTargets.has(clusterName) ||
      cleanTargets.has(worker.logicalSlot) ||
      cleanTargets.has(worker.physicalName)
    ));
    if (fullyCovered) coveredClusters.push(clusterName);
  }

  return coveredClusters;
}

export async function deleteCommand(names: string[], options: DeleteOptions): Promise<void> {
  const platformInfo = getPlatformInfo();

  try {
    // Handle multi-service if: multiple args, single arg with array syntax, or 'all' keyword
    if (shouldUseMultiServiceDelete(names)) {
      await handleMultiServiceDelete(names, options);
      return;
    }

    // Handle delete all services (legacy)
    if (options.all) {
      await deleteAllServices(platformInfo, options);
      return;
    }

    // Single service operation
    await handleSingleServiceDelete(names[0] || '', platformInfo, options);
  } catch {
    process.exitCode = 1;
  }
}

async function handleMultiServiceDelete(name: string | string[], options: DeleteOptions): Promise<void> {
  let services = await parseServiceArray(name);
  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }

  // Safety confirmation for bulk operations
  if (!options.force) {
    console.log(`⚠️  About to delete ${services.length} services:`);
    services.forEach(service => console.log(`   - ${service}`));

    const confirmed = await confirmAction('Are you sure? This action cannot be undone. (y/N): ');
    if (!confirmed) {
      console.log('❌ Delete operation cancelled');
      return;
    }
  }

  console.log(`🗑️  Deleting ${services.length} services...`);

  const platformInfo = getPlatformInfo();
  const discoveredServices = await listServices();
  const retiredClusters = await retireFullyCoveredClusterManifests(
    services,
    discoveredServices,
    platformInfo,
  );

  // A reconciliation may already have been in flight when its manifest was
  // retired. Re-discover once and include every physical generation belonging
  // to a retired cluster so no orphan worker can survive the delete.
  if (retiredClusters.length > 0) {
    const refreshedServices = await listServices();
    const retired = new Set(retiredClusters);
    const physicalWorkers = refreshedServices
      .map(service => parseWorkerSlot(service.name))
      .filter(worker => worker !== null && retired.has(worker.appName))
      .map(worker => worker!.physicalName);
    services = [...new Set([...services, ...physicalWorkers])];
  }

  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        await handleSingleServiceDelete(serviceName, platformInfo, { ...options, force: true });
        return { service: serviceName, status: 'success', error: null };
      } catch (error) {
        return { service: serviceName, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  await deleteResidualRetiredClusterWorkers(retiredClusters, platformInfo, options);

  displayBatchResults(results, 'delete');
}

async function handleSingleServiceDelete(name: string, platformInfo: any, options: DeleteOptions): Promise<void> {
  // Security: Validate service name
  if (!isValidServiceName(name)) {
    throw new Error(`Security: Invalid service name: ${name}`);
  }

  const clean = name.replace(/^(BS9_|bs9\.)/, "");
  const escapedClean = escapeRegExp(clean);
  let allServices: ServiceMetrics[] = [];
  try {
    allServices = await listServices();
  } catch {
    // Fall back to a direct delete when service discovery is unavailable.
  }

  const retiredClusters = await retireFullyCoveredClusterManifests(
    [clean],
    allServices,
    platformInfo,
  );
  if (retiredClusters.length > 0) {
    allServices = await listServices();
  }

  // 1. Logical slot match (e.g. "api-0" matching "api-0-g1", "api-0-g2")
  const slotWorkers = allServices.filter(s => {
    const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return new RegExp(`^${escapedClean}-g\\d+$`).test(sClean);
  });

  if (slotWorkers.length > 0) {
    for (const w of slotWorkers) {
      const wClean = w.name.replace(/^(BS9_|bs9\.)/, "");
      await deleteDirectService(wClean, platformInfo, options);
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
      await deleteDirectService(wClean, platformInfo, options);
    }
    await deleteResidualRetiredClusterWorkers(retiredClusters, platformInfo, options);
    return;
  }

  await deleteDirectService(name, platformInfo, options);
}

async function deleteResidualRetiredClusterWorkers(
  retiredClusters: string[],
  platformInfo: any,
  options: DeleteOptions,
): Promise<void> {
  if (retiredClusters.length === 0) return;
  const retired = new Set(retiredClusters);

  // A reconciler callback that was already in flight when the manifest was
  // retired can finish spawning one last generation. Sweep for a bounded
  // interval so those late workers cannot become invisible orphans.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 100));
    const remaining = (await listServices())
      .map(service => parseWorkerSlot(service.name))
      .filter(worker => worker !== null && retired.has(worker.appName));

    if (remaining.length === 0) return;
    for (const worker of remaining) {
      await deleteDirectService(worker!.physicalName, platformInfo, options);
    }
  }
}

async function retireFullyCoveredClusterManifests(
  targets: string[],
  services: ServiceMetrics[],
  platformInfo: any,
): Promise<string[]> {
  const candidates = findFullyCoveredClusters(targets, services);
  const retired: string[] = [];

  for (const clusterName of candidates) {
    if (await retireClusterManifest(clusterName, platformInfo)) {
      retired.push(clusterName);
    }
  }

  return retired;
}

async function retireClusterManifest(clusterName: string, platformInfo: any): Promise<boolean> {
  if (!isValidServiceName(clusterName)) return false;

  const manifestPath = join(platformInfo.clusterDir, `${clusterName}.manifest.json`);
  let found = existsSync(manifestPath);
  let client: import("../cluster/admin-client.js").ControllerAdminClient | null = null;
  let connected = false;

  try {
    const { ControllerAdminClient } = await import("../cluster/admin-client.js");
    client = new ControllerAdminClient();
    connected = await client.connect(1000);
    if (connected) {
      const manifest = await client.getManifest(clusterName);
      if (manifest) {
        found = true;
        if (!await client.deleteManifest(clusterName)) {
          throw new Error(`Daemon refused to retire desired-state manifest for '${clusterName}'`);
        }
      }
    }
  } catch (error) {
    if (connected) throw error;
    // The daemon may be stopped. Removing the persisted manifest below is
    // still required so a future daemon start cannot resurrect the cluster.
  } finally {
    client?.disconnect();
  }

  if (existsSync(manifestPath)) {
    try {
      unlinkSync(manifestPath);
      found = true;
    } catch (error) {
      throw new Error(`Failed to remove desired-state manifest for '${clusterName}': ${error}`);
    }
  }

  if (found) {
    console.log(`🧹 Retired desired-state manifest for cluster '${clusterName}'`);
  }
  return found;
}

async function deleteDirectService(name: string, platformInfo: any, options: DeleteOptions): Promise<void> {
  try {
    if (platformInfo.isLinux) {
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      try { execSync(`systemctl --user stop "${escapedName}"`, { stdio: "inherit" }); } catch { }
      try { execSync(`systemctl --user disable "${escapedName}"`, { stdio: "inherit" }); } catch { }

      if (options.remove) {
        const serviceFile = join(platformInfo.serviceDir, `${escapedName}.service`);
        try { unlinkSync(serviceFile); } catch { }
        try { execSync(`systemctl --user daemon-reload`, { stdio: "ignore" }); } catch { }
      }
      console.log(`🗑️ Service '${name}' deleted successfully`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('delete', { name: name.startsWith('bs9.') ? name : `bs9.${name}` });
    } else if (platformInfo.isWindows) {
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();
      const fullName = name.startsWith('BS9_') ? name : `BS9_${name}`;
      await manager.deleteService(fullName);
    }
  } catch (err) {
    console.error(`❌ Failed to delete service '${name}': ${err}`);
    throw err;
  }
}

async function deleteAllServices(platformInfo: any, options: DeleteOptions): Promise<void> {
  try {
    console.log("🗑️ Deleting all BS9 services...");

    if (platformInfo.isLinux) {
      await handleMultiServiceDelete('all', { ...options, force: true });
    } else if (platformInfo.isMacOS) {
      console.log("📝 Bulk delete on macOS: manually remove from LaunchAgents directory.");
    } else if (platformInfo.isWindows) {
      await handleMultiServiceDelete('all', { ...options, force: true });
    }

    console.log(`✅ All BS9 services deletion process completed`);
  } catch (err) {
    console.error(`❌ Failed to delete all services: ${err}`);
    if (!options.force) {
      process.exitCode = 1;
      return;
    }
  }
}
