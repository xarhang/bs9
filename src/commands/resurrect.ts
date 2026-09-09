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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { getPlatformInfo, initializePlatformDirectories } from "../platform/detect.js";

interface ResurrectOptions {
  all?: boolean;
  force?: boolean;
  config?: string;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, and dots
  // Prevent command injection and path traversal
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function resurrectCommand(name: string, options: ResurrectOptions): Promise<void> {
  // Initialize platform directories
  initializePlatformDirectories();

  const platformInfo = getPlatformInfo();

  // Handle resurrect all services or patterns
  if (options.all || !name || name === 'all' || name.includes('[') || name.includes(' ')) {
    await resurrectAllServices(platformInfo, options);
    return;
  }

  // Security: Validate service name
  if (!isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  try {
    if (platformInfo.isLinux) {
      // Security: Use shell escaping to prevent injection
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');

      // Check if service exists in backup
      const backupFile = join(platformInfo.backupDir, `${escapedName}.json`);

      if (!existsSync(backupFile)) {
        console.error(`❌ No backup found for service '${name}'`);
        process.exit(1);
      }

      // Load backup configuration
      const backupConfig = JSON.parse(readFileSync(backupFile, 'utf8'));

      // Check if the file exists
      const filePath = backupConfig.file;
      if (!existsSync(filePath)) {
        console.error(`❌ Service file not found: ${filePath}`);
        process.exit(1);
      }

      // Restore service using backup configuration
      const { startCommand } = await import("./start.js");
      await startCommand([backupConfig.file], {
        name: backupConfig.name,
        port: backupConfig.port?.toString(),
        host: backupConfig.host,
        env: backupConfig.env,
        otel: backupConfig.otel,
        prometheus: backupConfig.prometheus,
        build: backupConfig.build,
        https: backupConfig.https
      });

      console.log(`✅ Service '${name}' resurrected successfully from backup`);

    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('resurrect', { name: `bs9.${name}` });

      if (options.config) {
        const plistFile = join(platformInfo.serviceDir, `bs9.${name}.plist`);
        try {
          writeFileSync(plistFile, options.config);
          console.log(`📝 Configuration restored: ${plistFile}`);
        } catch (error) {
          console.error(`❌ Failed to restore configuration: ${error}`);
        }
      }

      console.log(`✅ Service '${name}' resurrected successfully`);

    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('resurrect', { name: `BS9_${name}` });

      console.log(`✅ Service '${name}' resurrected successfully`);
    }
  } catch (err) {
    console.error(`❌ Failed to resurrect service '${name}': ${err}`);
    if (!options.force) {
      process.exit(1);
    }
  }
}

async function resurrectAllServices(platformInfo: any, options: ResurrectOptions): Promise<void> {
  try {
    console.log("🔄 Resurrecting all BS9 services from backup...");

    // Initialize platform directories
    initializePlatformDirectories();

    if (platformInfo.isLinux) {
      // Get all backup files
      const backupFiles = readdirSync(platformInfo.backupDir)
        .filter((file: string) => file.endsWith('.json'));

      if (backupFiles.length === 0) {
        console.log("ℹ️ No backup files found to resurrect");
        return;
      }

      console.log(`Found ${backupFiles.length} backup files to restore...`);

      for (const backupFile of backupFiles) {
        try {
          const serviceName = backupFile.replace('.json', '');
          const backupPath = join(platformInfo.backupDir, backupFile);
          const backupConfig = JSON.parse(readFileSync(backupPath, 'utf8'));

          // Restore service using backup configuration
          const { startCommand } = await import("./start.js");
          await startCommand([backupConfig.file], {
            name: backupConfig.name,
            port: backupConfig.port?.toString(),
            host: backupConfig.host,
            env: backupConfig.env,
            otel: backupConfig.otel,
            prometheus: backupConfig.prometheus,
            build: backupConfig.build,
            https: backupConfig.https
          });

          console.log(`  ✅ Resurrected service: ${serviceName}`);
        } catch (error) {
          console.error(`  ⚠️  Failed to resurrect service '${backupFile}': ${error}`);
        }
      }

    } else if (platformInfo.isMacOS) {
      console.log("📝 To resurrect all services on macOS, you need to manually restore the plist files from:");
      console.log(`   ${platformInfo.backupDir}/*.plist`);
      console.log("   And then run: launchctl load ~/Library/LaunchAgents/bs9.*.plist");
    } else if (platformInfo.isWindows) {
      const backupDir = platformInfo.backupDir;
      if (existsSync(backupDir)) {
        const files = readdirSync(backupDir).filter((f: string) => f.endsWith('.json'));
        console.log(`Found ${files.length} backups to resurrect on Windows...`);
        for (const file of files) {
          try {
            const serviceName = file.replace('.json', '');
            const { windowsCommand } = await import("../windows/service.js");
            await windowsCommand('resurrect', { name: serviceName });
            console.log(`  ✅ Resurrected service: ${serviceName}`);
          } catch (e) {
            console.error(`  ⚠️  Failed to resurrect service '${file}': ${e}`);
          }
        }
      } else {
        console.log("ℹ️ No backup files found to resurrect");
      }
    }

    console.log(`✅ All BS9 services resurrection process completed`);
  } catch (err) {
    console.error(`❌ Failed to resurrect all services: ${err}`);
    if (!options.force) {
      process.exit(1);
    }
  }
}
