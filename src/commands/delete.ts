#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, confirmAction, displayBatchResults } from "../utils/array-parser.js";

interface DeleteOptions {
  all?: boolean;
  force?: boolean;
  remove?: boolean;
  timeout?: string;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, and dots
  // Prevent command injection and path traversal
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function deleteCommand(names: string[], options: DeleteOptions): Promise<void> {
  const platformInfo = getPlatformInfo();

  // Handle multi-service if: multiple args, single arg with array syntax, or 'all' keyword
  if (names.length > 1 || (names.length === 1 && (names[0].includes('[') || names[0] === 'all'))) {
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
}

async function handleMultiServiceDelete(name: string | string[], options: DeleteOptions): Promise<void> {
  const services = await parseServiceArray(name);

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

  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        const platformInfo = getPlatformInfo();
        await handleSingleServiceDelete(serviceName, platformInfo, { ...options, force: true });
        return { service: serviceName, status: 'success', error: null };
      } catch (error) {
        return { service: serviceName, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  displayBatchResults(results, 'delete');
}

async function handleSingleServiceDelete(name: string, platformInfo: any, options: DeleteOptions): Promise<void> {
  // Security: Validate service name
  if (!isValidServiceName(name)) {
    throw new Error(`Security: Invalid service name: ${name}`);
  }

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
    if (!options.force) {
      process.exit(1);
    }
  }
}

async function deleteAllServices(platformInfo: any, options: DeleteOptions): Promise<void> {
  try {
    console.log("🗑️ Deleting all BS9 services...");

    if (platformInfo.isLinux) {
      const services = await parseServiceArray('all');
      for (const s of services) {
        try { await handleSingleServiceDelete(s, platformInfo, options); } catch { }
      }
    } else if (platformInfo.isMacOS) {
      console.log("📝 Bulk delete on macOS: manually remove from LaunchAgents directory.");
    } else if (platformInfo.isWindows) {
      const services = await parseServiceArray('all');
      for (const s of services) {
        try { await handleSingleServiceDelete(s, platformInfo, options); } catch { }
      }
    }

    console.log(`✅ All BS9 services deletion process completed`);
  } catch (err) {
    console.error(`❌ Failed to delete all services: ${err}`);
    if (!options.force) {
      process.exit(1);
    }
  }
}

