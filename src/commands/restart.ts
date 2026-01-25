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
import { parseServiceArray, confirmAction } from "../utils/array-parser.js";

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function restartCommand(names: string[]): Promise<void> {
  // Handle multiple arguments
  const name = names.length > 0 ? names.join(' ') : '';
  
  // Handle multi-service operations
  if (name.includes('[') || name === 'all') {
    await handleMultiServiceRestart(name);
    return;
  }
  
  // Single service operation (existing logic)
  await handleSingleServiceRestart(name);
}

async function handleMultiServiceRestart(name: string): Promise<void> {
  const services = await parseServiceArray(name);
  
  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }
  
  // Safety confirmation for bulk operations
  if (services.length > 1) {
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
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }
  
  const platformInfo = getPlatformInfo();
  
  try {
    if (platformInfo.isLinux) {
      // Security: Use shell escaping to prevent injection
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      execSync(`systemctl --user restart "${escapedName}"`, { stdio: "inherit" });
      console.log(`🔄 User service '${name}' restarted`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('restart', { name: `bs9.${name}` });
    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('restart', { name: `BS9_${name}` });
    }
  } catch (err) {
    console.error(`❌ Failed to restart service '${name}': ${err}`);
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
