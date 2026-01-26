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
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, confirmAction } from "../utils/array-parser.js";

interface StopOptions {
  force?: boolean;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function stopCommand(names: string[], options: StopOptions): Promise<void> {
  // Handle multi-service if: multiple args, single arg with array syntax, or 'all' keyword
  if (names.length > 1 || (names.length === 1 && (names[0].includes('[') || names[0] === 'all'))) {
    await handleMultiServiceStop(names, options);
    return;
  }

  // Single service operation
  await handleSingleServiceStop(names[0] || '');
}

async function handleMultiServiceStop(name: string | string[], options: StopOptions): Promise<void> {
  const services = await parseServiceArray(name);

  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }

  // Safety confirmation for bulk operations
  if (services.length > 1 && !options.force) {
    console.log(`⚠️  About to stop ${services.length} services:`);
    services.forEach(service => console.log(`   - ${service}`));

    const confirmed = await confirmAction('Are you sure? (y/N): ');
    if (!confirmed) {
      console.log('❌ Stop operation cancelled');
      return;
    }
  }

  console.log(`🛑 Stopping ${services.length} services...`);

  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        await handleSingleServiceStop(serviceName);
        return { service: serviceName, status: 'success', error: null };
      } catch (error) {
        return { service: serviceName, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  displayBatchResults(results, 'stop');
}

async function handleSingleServiceStop(name: string): Promise<void> {
  // Security: Validate service name
  if (!isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const platformInfo = getPlatformInfo();

  try {
    if (platformInfo.isLinux) {
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      // Standardize prefix: if it doesn't have it, add it. 
      // But unified discovery handles this now. 
      // Actually, standardizing on the manager's expectation.
      execSync(`systemctl --user stop "${escapedName}"`, { stdio: "inherit" });
      console.log(`🛑 User service '${name}' stopped`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('stop', { name: name.startsWith('bs9.') ? name : `bs9.${name}` });
    } else if (platformInfo.isWindows) {
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();
      // Resolve full name for Windows (add BS9_ prefix if missing)
      const fullName = name.startsWith('BS9_') ? name : `BS9_${name}`;
      await manager.stopService(fullName);
    }
  } catch (err) {
    console.error(`❌ Failed to stop service '${name}': ${err}`);
    process.exit(1);
  }
}

function displayBatchResults(results: PromiseSettledResult<{ service: string; status: string; error: string | null }>[], operation: string): void {
  console.log(`\n📊 Batch ${operation} Results`);
  console.log("=".repeat(50));

  const successful = results.filter(r => r.status === 'fulfilled' && r.value.status === 'success');
  const failed = results.filter(r => r.status === 'fulfilled' && r.value.status === 'failed');

  successful.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`✅ ${result.value.service} - ${operation} successful`);
    }
  });

  failed.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`❌ ${result.value.service} - Failed: ${result.value.error}`);
    }
  });

  console.log(`\n📈 Summary:`);
  console.log(`   Total: ${results.length} services`);
  console.log(`   Success: ${successful.length}/${results.length} (${((successful.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`   Failed: ${failed.length}/${results.length} (${((failed.length / results.length) * 100).toFixed(1)}%)`);
}
