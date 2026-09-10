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
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, confirmAction, displayBatchResults } from "../utils/array-parser.js";

interface RestartOptions {
  force?: boolean;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function restartCommand(names: string[], options: RestartOptions = {}): Promise<void> {
  // Handle multi-service if: multiple args, single arg with array syntax, or 'all' keyword
  if (names.length > 1 || (names.length === 1 && (names[0].includes('[') || names[0] === 'all'))) {
    await handleMultiServiceRestart(names, options);
    return;
  }

  // Single service operation
  await handleSingleServiceRestart(names[0] || '');
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

  const platformInfo = getPlatformInfo();

  try {
    if (platformInfo.isLinux) {
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      execSync(`systemctl --user restart "${escapedName}"`, { stdio: "inherit" });
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
  } catch (err) {
    console.error(`❌ Failed to restart service '${name}': ${err}`);
    process.exit(1);
  }
}

