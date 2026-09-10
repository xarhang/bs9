#!/usr/bin/env bun

/**
 * BS9 - Flush Logs Command
 * Empties all or specific service log files, mirroring `pm2 flush`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function flushCommand(name?: string): Promise<void> {
  if (name && !isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const platformInfo = getPlatformInfo();
  const logDir = platformInfo.logDir;

  if (!existsSync(logDir)) {
    console.log(`✨ Log directory does not exist yet: ${logDir}`);
    return;
  }

  const files = readdirSync(logDir);
  let flushedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".log")) continue;

    if (name) {
      const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
      const isTarget =
        file === `${cleanName}.out.log` || file === `${cleanName}.err.log` ||
        file === `BS9_${cleanName}.out.log` || file === `BS9_${cleanName}.err.log` ||
        file === `bs9.${cleanName}.out.log` || file === `bs9.${cleanName}.err.log` ||
        (file.startsWith(`${cleanName}-`) && (file.endsWith(".out.log") || file.endsWith(".err.log")));
      if (!isTarget) continue;
    }

    const fullPath = join(logDir, file);
    try {
      writeFileSync(fullPath, "");
      flushedCount++;
    } catch (e) {
      console.warn(`⚠️  Failed to flush ${file}: ${e}`);
    }
  }

  if (name) {
    console.log(`🧹 Flushed logs for '${name}' (${flushedCount} file(s) cleared)`);
  } else {
    console.log(`🧹 Flushed all BS9 logs (${flushedCount} file(s) cleared)`);
  }
}