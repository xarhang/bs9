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

export async function flushCommand(name?: string): Promise<void> {
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
      const matchPrefix = name.startsWith("BS9_") || name.startsWith("bs9.") ? name : name;
      if (!file.includes(matchPrefix)) continue;
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