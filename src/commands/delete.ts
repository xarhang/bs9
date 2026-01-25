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
  
  // Handle multiple arguments
  const name = names.length > 0 ? names.join(' ') : '';
  
  // Handle multi-service operations
  if (name.includes('[') || name === 'all') {
    await handleMultiServiceDelete(name, options);
    return;
  }
  
  // Handle delete all services (legacy)
  if (options.all) {
    await deleteAllServices(platformInfo, options);
    return;
  }
  
  // Single service operation (existing logic)
  await handleSingleServiceDelete(name, platformInfo, options);
}

async function handleMultiServiceDelete(name: string, options: DeleteOptions): Promise<void> {
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
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }
  
  try {
    if (platformInfo.isLinux) {
      // Security: Use shell escaping to prevent injection
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      
      // Stop the service first
      try {
        execSync(`systemctl --user stop "${escapedName}"`, { stdio: "inherit" });
      } catch (error) {
        // Service might not be running, continue with deletion
      }
      
      // Disable the service
      try {
        execSync(`systemctl --user disable "${escapedName}"`, { stdio: "inherit" });
      } catch (error) {
        // Service might not exist, continue
      }
      
      // Remove the service file if requested
      if (options.remove) {
        const serviceFile = join(platformInfo.serviceDir, `${escapedName}.service`);
        try {
          execSync(`rm -f "${serviceFile}"`, { stdio: "inherit" });
          console.log(`🗑️ Service file removed: ${serviceFile}`);
        } catch (error) {
          // File might not exist, continue
        }
      }
      
      console.log(`🗑️ Service '${name}' deleted successfully`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('delete', { name: `bs9.${name}` });
      
      if (options.remove) {
        const plistFile = join(platformInfo.serviceDir, `bs9.${name}.plist`);
        try {
          execSync(`rm -f "${plistFile}"`, { stdio: "inherit" });
          console.log(`🗑️ Service file removed: ${plistFile}`);
        } catch (error) {
          // File might not exist, continue
        }
      }
    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('delete', { name: `BS9_${name}` });
      
      if (options.remove) {
        // Windows service removal is handled by the windowsCommand
        console.log(`🗑️ Windows service 'BS9_${name}' deleted`);
      }
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
      // Get all BS9 services
      const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
      const lines = listOutput.split("\n").filter(line => line.includes(".service"));
      
      const bs9Services: string[] = [];
      
      for (const line of lines) {
        const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
        if (match) {
          const [, , serviceName] = match; // Skip the status symbol, capture service name
          
          // Only process BS9 services
          if (match[5].includes("Bun Service:") || match[5].includes("BS9 Service:")) {
            bs9Services.push(serviceName);
          }
        }
      }
      
      if (bs9Services.length === 0) {
        console.log("ℹ️ No BS9 services found to delete");
        return;
      }
      
      console.log(`Found ${bs9Services.length} BS9 services to delete...`);
      
      for (const serviceName of bs9Services) {
        try {
          // Stop the service
          execSync(`systemctl --user stop "${serviceName}"`, { stdio: "inherit" });
          
          // Disable the service
          execSync(`systemctl --user disable "${serviceName}"`, { stdio: "inherit" });
          
          // Remove service file if requested
          if (options.remove) {
            const serviceFile = join(platformInfo.serviceDir, `${serviceName}.service`);
            execSync(`rm -f "${serviceFile}"`, { stdio: "inherit" });
            console.log(`  🗑️ Deleted service file: ${serviceName}`);
          }
          
          console.log(`  🗑️ Deleted service: ${serviceName}`);
        } catch (error) {
          console.error(`  ⚠️  Failed to delete service '${serviceName}': ${error}`);
        }
      }
      
    } else if (platformInfo.isMacOS) {
      // For macOS, we would need to list all launchd agents
      // This is more complex, so for now we'll provide a message
      console.log("📝 To delete all services on macOS, you need to manually remove the plist files from:");
      console.log(`   ${platformInfo.serviceDir}/bs9.*.plist`);
      console.log("   And then run: launchctl unload ~/Library/LaunchAgents/bs9.*.plist");
    } else if (platformInfo.isWindows) {
      // For Windows, we would need to query all BS9 services
      // This is more complex, so for now we'll provide a message
      console.log("📝 To delete all services on Windows, use PowerShell:");
      console.log("   Get-Service -Name \"BS9_*\" | ForEach-Object { Stop-Service $_.Name; Remove-Service $_.Name }");
    }
    
    console.log(`✅ All BS9 services deletion process completed`);
  } catch (err) {
    console.error(`❌ Failed to delete all services: ${err}`);
    if (!options.force) {
      process.exit(1);
    }
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
