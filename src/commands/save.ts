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
import { join, resolve } from "node:path";
import { getPlatformInfo, initializePlatformDirectories } from "../platform/detect.js";

interface SaveOptions {
  all?: boolean;
  force?: boolean;
  backup?: boolean;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, and dots
  // Prevent command injection and path traversal
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function saveCommand(name: string, options: SaveOptions): Promise<void> {
  // Initialize platform directories
  initializePlatformDirectories();

  const platformInfo = getPlatformInfo();

  // Handle save all services or multi-service patterns
  if (options.all || name === 'all' || name.includes('[') || name.includes(' ')) {
    await saveAllServices(platformInfo, options);
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

      // Get service status and configuration
      const statusOutput = execSync(`systemctl --user show "${escapedName}"`, { encoding: "utf-8" });
      const serviceFile = join(platformInfo.serviceDir, `${escapedName}.service`);

      if (!require('node:fs').existsSync(serviceFile)) {
        console.error(`❌ Service configuration not found for '${name}'`);
        process.exit(1);
      }

      // Read service configuration
      const serviceConfig = require('node:fs').readFileSync(serviceFile, 'utf8');

      // Parse service configuration to extract startup parameters
      const config = parseServiceConfig(serviceConfig, statusOutput);

      // Save configuration to backup
      const backupFile = join(platformInfo.backupDir, `${escapedName}.json`);
      const backupData = {
        name: name,
        file: extractFileFromConfig(serviceConfig),
        port: config.port,
        host: config.host,
        env: config.env,
        otel: config.otel,
        prometheus: config.prometheus,
        build: config.build,
        https: config.https,
        savedAt: new Date().toISOString(),
        platform: platformInfo.platform
      };

      require('node:fs').writeFileSync(backupFile, JSON.stringify(backupData, null, 2));

      console.log(`💾 Service '${name}' configuration saved to: ${backupFile}`);

      if (options.backup) {
        // Create additional backup with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const timestampedBackup = join(platformInfo.backupDir, `${escapedName}-${timestamp}.json`);
        require('node:fs').writeFileSync(timestampedBackup, JSON.stringify(backupData, null, 2));
        console.log(`📦 Additional backup created: ${timestampedBackup}`);
      }

    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('save', { name: `bs9.${name}` });

      console.log(`💾 Service '${name}' configuration saved`);

    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('save', { name: `BS9_${name}` });

      console.log(`💾 Service '${name}' configuration saved`);
    }
  } catch (err) {
    console.error(`❌ Failed to save service '${name}': ${err}`);
    if (!options.force) {
      process.exit(1);
    }
  }
}

async function saveAllServices(platformInfo: any, options: SaveOptions): Promise<void> {
  try {
    console.log("💾 Saving all BS9 service configurations...");

    // Initialize platform directories
    initializePlatformDirectories();

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
        console.log("ℹ️ No BS9 services found to save");
        return;
      }

      console.log(`Found ${bs9Services.length} BS9 services to save...`);

      for (const serviceName of bs9Services) {
        try {
          const serviceFile = join(platformInfo.serviceDir, `${serviceName}.service`);

          if (require('node:fs').existsSync(serviceFile)) {
            const serviceConfig = require('node:fs').readFileSync(serviceFile, 'utf8');
            const statusOutput = execSync(`systemctl --user show "${serviceName}"`, { encoding: "utf-8" });
            const config = parseServiceConfig(serviceConfig, statusOutput);

            const backupFile = join(platformInfo.backupDir, `${serviceName}.json`);
            const backupData = {
              name: serviceName,
              file: extractFileFromConfig(serviceConfig),
              port: config.port,
              host: config.host,
              env: config.env,
              otel: config.otel,
              prometheus: config.prometheus,
              build: config.build,
              https: config.https,
              savedAt: new Date().toISOString(),
              platform: platformInfo.platform
            };

            require('node:fs').writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
            console.log(`  💾 Saved service: ${serviceName}`);
          }
        } catch (error) {
          console.error(`  ⚠️  Failed to save service '${serviceName}': ${error}`);
        }
      }

    } else if (platformInfo.isMacOS) {
      console.log("📝 To save all services on macOS, you need to manually backup the plist files from:");
      console.log(`   ${platformInfo.serviceDir}/bs9.*.plist`);
    } else if (platformInfo.isWindows) {
      // Get all services metadata files
      const servicesDir = platformInfo.serviceDir;
      const fs = require('node:fs');
      if (fs.existsSync(servicesDir)) {
        const files = fs.readdirSync(servicesDir).filter((f: string) => f.endsWith('.json'));
        console.log(`Found ${files.length} BS9 services to save on Windows...`);
        for (const file of files) {
          try {
            const serviceName = file.replace('.json', '');
            const { windowsCommand } = await import("../windows/service.js");
            await windowsCommand('save', { name: serviceName });
            console.log(`  💾 Saved service: ${serviceName}`);
          } catch (e) {
            console.error(`  ⚠️  Failed to save service '${file}': ${e}`);
          }
        }
      } else {
        console.log("ℹ️ No BS9 services found to save");
      }
    }

    console.log(`✅ All BS9 services save process completed`);
  } catch (err) {
    console.error(`❌ Failed to save all services: ${err}`);
    if (!options.force) {
      process.exit(1);
    }
  }
}

// Helper function to parse service configuration
function parseServiceConfig(serviceConfig: string, statusOutput: string): any {
  const config: any = {};

  // Extract port from service config
  const portMatch = serviceConfig.match(/--port[=\s]+(\d+)/);
  if (portMatch) {
    config.port = parseInt(portMatch[1]);
  }

  // Extract host from service config
  const hostMatch = serviceConfig.match(/--host[=\s]+([^\s]+)/);
  if (hostMatch) {
    config.host = hostMatch[1];
  }

  // Extract environment variables
  const envMatches = serviceConfig.match(/--env[=\s]+([^\s]+)/g);
  if (envMatches) {
    config.env = envMatches.map((env: string) => env.replace(/--env[=\s]+/, ''));
  }

  // Extract OpenTelemetry flag
  config.otel = serviceConfig.includes('--otel') || serviceConfig.includes('--opentelemetry');

  // Extract Prometheus flag
  config.prometheus = serviceConfig.includes('--prometheus');

  // Extract build flag
  config.build = serviceConfig.includes('--build');

  // Extract HTTPS flag
  config.https = serviceConfig.includes('--https');

  return config;
}

// Helper function to extract file path from service config
function extractFileFromConfig(serviceConfig: string): string {
  const execMatch = serviceConfig.match(/ExecStart=([^\n]+)/);
  if (execMatch) {
    const execLine = execMatch[1].trim();
    // Handle both "bun run" and direct "bun" execution
    let fileMatch;
    if (execLine.includes('bun run')) {
      // Extract the file path from "bun run <file>"
      fileMatch = execLine.match(/bun run\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))/);
    } else {
      // Extract the file path from "bun <file>"
      fileMatch = execLine.match(/bun\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))/);
    }

    if (fileMatch) {
      const filePath = fileMatch[1] || fileMatch[2] || fileMatch[3];
      // If it's a relative path, resolve it relative to the working directory
      if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
        return resolve(filePath);
      }
      return filePath;
    }
  }
  return '';
}
