#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { getPlatformInfo, initializePlatformDirectories } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile, writePrivateFile } from "../utils/private-files.js";

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
  return validPattern.test(name) && !name.startsWith("-") && name !== "." && name.length <= 64 && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

export async function saveCommand(name: string, options: SaveOptions): Promise<void> {
  // Initialize platform directories
  initializePlatformDirectories();

  const platformInfo = getPlatformInfo();

  // Handle save all services or multi-service patterns
  if (options.all || !name || name === 'all' || name.includes('[') || name.includes(' ')) {
    await saveAllServices(platformInfo, options);
    return;
  }

  // Security: Validate service name
  if (!isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (platformInfo.isLinux) {
      // Security: Use sanitized name and execFileSync without shell
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');

      // Get service status and configuration
      const statusOutput = execFileSync("systemctl", ["--user", "show", "--", escapedName], { encoding: "utf-8", windowsHide: true });
      const serviceFile = join(platformInfo.serviceDir, `${escapedName}.service`);

      if (!existsSync(serviceFile)) {
        console.error(`❌ Service configuration not found for '${name}'`);
        if (!options.force) {
          process.exitCode = 1;
        }
        return;
      }

      ensurePrivateDirectory(platformInfo.serviceDir);
      securePrivateFile(serviceFile);
      // Read service configuration
      const serviceConfig = readFileSync(serviceFile, 'utf8');

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

      ensurePrivateDirectory(platformInfo.backupDir);
      writePrivateFile(backupFile, JSON.stringify(backupData, null, 2));

      console.log(`💾 Service '${name}' configuration saved to: ${backupFile}`);

      if (options.backup) {
        // Create additional backup with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const timestampedBackup = join(platformInfo.backupDir, `${escapedName}-${timestamp}.json`);
        writePrivateFile(timestampedBackup, JSON.stringify(backupData, null, 2));
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
      process.exitCode = 1;
      return;
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
      const listOutput = execFileSync("systemctl", ["--user", "list-units", "--type=service", "--no-pager", "--no-legend"], { encoding: "utf-8", windowsHide: true });
      const lines = listOutput.split("\n").filter(line => line.includes(".service"));

      const bs9Services: string[] = [];

      for (const line of lines) {
        const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
        if (match) {
          const [, , serviceName] = match; // Skip the status symbol, capture service name

          // Only process BS9 services with valid names
          if ((match[5].includes("Bun Service:") || match[5].includes("BS9 Service:")) && isValidServiceName(serviceName)) {
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

          if (existsSync(serviceFile)) {
            ensurePrivateDirectory(platformInfo.serviceDir);
            securePrivateFile(serviceFile);
            const serviceConfig = readFileSync(serviceFile, 'utf8');
            const statusOutput = execFileSync("systemctl", ["--user", "show", "--", serviceName], { encoding: "utf-8", windowsHide: true });
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

            ensurePrivateDirectory(platformInfo.backupDir);
            writePrivateFile(backupFile, JSON.stringify(backupData, null, 2));
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
      if (existsSync(servicesDir)) {
        const files = readdirSync(servicesDir).filter((f: string) => f.endsWith('.json'));
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
      process.exitCode = 1;
      return;
    }
  }
}

// Helper function to parse service configuration
function parseServiceConfig(serviceConfig: string, _statusOutput: string): any {
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

  // Extract environment variables from --env flags or systemd Environment= lines
  const envList: string[] = [];
  const envMatches = serviceConfig.match(/--env[=\s]+([^\s]+)/g);
  if (envMatches) {
    for (const env of envMatches) {
      envList.push(env.replace(/--env[=\s]+/, ''));
    }
  }
  const systemdEnvMatches = serviceConfig.match(/^Environment=(.+)$/gm);
  if (systemdEnvMatches) {
    for (const line of systemdEnvMatches) {
      let val = line.slice('Environment='.length).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val && !envList.includes(val)) {
        envList.push(val);
      }
    }
  }
  if (envList.length > 0) {
    config.env = envList;
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
  const execMatch = serviceConfig.match(/^ExecStart=(.+)$/m);
  if (execMatch) {
    const execLine = execMatch[1].trim();
    const tokens = execLine.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g) || [];
    const args = tokens.map(t => {
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
    // Skip bun executable and known flags (like run, --preload <val>, --hot, etc.)
    for (let i = 1; i < args.length; i++) {
      const tok = args[i];
      if (tok === 'run') continue;
      if (tok === '--preload' || tok === '--port' || tok === '--host' || tok === '--env') {
        i++; // skip option value
        continue;
      }
      if (tok.startsWith('-')) continue;
      if (!tok.startsWith('/') && !tok.startsWith('~')) {
        return resolve(tok);
      }
      return tok;
    }
  }
  return '';
}
