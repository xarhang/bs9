#!/usr/bin/env bun

/**
 * BS9 - Env Command
 * Displays live or configured environment variables for a managed service.
 * Mirrors `pm2 env <app>`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import { listServices } from "../utils/service-discovery.js";

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function envCommand(name: string): Promise<void> {
  if (!name) {
    console.error("❌ Service name required. Usage: bs9 env <app-name>");
    process.exit(1);
  }

  const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
  if (!isValidServiceName(cleanName)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const platformInfo = getPlatformInfo();

  let envMap: Record<string, string> | null = null;

  if (platformInfo.isWindows) {
    const metaPath = join(homedir(), ".bs9", "services", `BS9_${cleanName}.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        envMap = meta.environment || {};
      } catch {}
    }
  } else if (platformInfo.isLinux) {
    const unitPath = join(homedir(), ".config", "systemd", "user", `${cleanName}.service`);
    if (existsSync(unitPath)) {
      const content = readFileSync(unitPath, "utf-8");
      envMap = {};
      const envLines = content.split("\n").filter(l => l.startsWith("Environment="));
      for (const line of envLines) {
        const match = line.match(/^Environment="?([^"=]+)=([^"]*)"?$/);
        if (match) {
          envMap[match[1]] = match[2];
        }
      }
    }
  } else if (platformInfo.isMacOS) {
    const configPath = join(homedir(), ".bs9", "launchd-services.json");
    if (existsSync(configPath)) {
      try {
        const configs = JSON.parse(readFileSync(configPath, "utf-8"));
        const cfg = configs[`bs9.${cleanName}`] || configs[cleanName];
        if (cfg?.env) {
          envMap = typeof cfg.env === "string" ? JSON.parse(cfg.env) : cfg.env;
        }
      } catch {}
    }
  }

  if (!envMap || Object.keys(envMap).length === 0) {
    // Check if the service exists in discovery
    const all = await listServices();
    const found = all.find(s => s.name.replace(/^(BS9_|bs9\.)/, "") === cleanName);
    if (!found) {
      console.error(`❌ Service '${name}' not found.`);
      process.exit(1);
    }
    console.log(`ℹ️  Service '${cleanName}' is registered but has no custom environment variables configured.`);
    return;
  }

  console.log(`\n================================================================================`);
  console.log(`🌐 Environment Variables for '${cleanName}' (${Object.keys(envMap).length} variable(s))`);
  console.log(`================================================================================`);

  for (const [k, v] of Object.entries(envMap).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${k.padEnd(28)} = ${v}`);
  }

  console.log(`================================================================================\n`);
}
