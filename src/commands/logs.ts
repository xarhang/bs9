#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync, spawn } from "node:child_process";
import { getPlatformInfo } from "../platform/detect.js";
import { join } from "node:path";
import { existsSync, readFileSync, watch } from "node:fs";

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(name: string, options: LogsOptions): Promise<void> {
  const platformInfo = getPlatformInfo();

  // Resolve full name (e.g. handle BS9_ prefix on Windows)
  let fullName = name;
  if (platformInfo.isWindows && !name.startsWith('BS9_')) fullName = `BS9_${name}`;
  if (platformInfo.isMacOS && !name.startsWith('bs9.')) fullName = `bs9.${name}`;

  try {
    if (platformInfo.isLinux) {
      // On Linux, try journalctl first as it's the standard
      try {
        const args = ["--no-pager"];
        if (options.follow) args.push("-f");
        if (options.lines) args.push("-n", options.lines || "50");

        const cmd = `journalctl --user ${args.join(" ")} -u ${fullName}.service`;
        execSync(cmd, { stdio: "inherit" });
        return;
      } catch {
        // Fallback to file-based logs if journalctl fails
      }
    }

    // Cross-platform file-based logs
    const logFile = join(platformInfo.logDir, `${fullName}.out.log`);
    const errorFile = join(platformInfo.logDir, `${fullName}.err.log`);

    if (!existsSync(logFile) && !existsSync(errorFile)) {
      console.warn(`⚠️  No log files found for service '${fullName}' in ${platformInfo.logDir}`);
      console.log(`💡 Logs are created when the service is started with BS9.`);
      return;
    }

    const showLogs = (filePath: string, label: string) => {
      if (!existsSync(filePath)) return;
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const count = parseInt(options.lines || "50");
      const lastLines = lines.slice(-count);
      console.log(`--- ${label} (${filePath}) ---`);
      console.log(lastLines.join('\n'));
    };

    showLogs(logFile, "STDOUT");
    showLogs(errorFile, "STDERR");

    if (options.follow) {
      console.log(`\n👀 Following logs... (Ctrl+C to stop)`);

      const followFile = (filePath: string) => {
        if (!existsSync(filePath)) return;
        let fileSize = readFileSync(filePath).length;

        watch(filePath, (event) => {
          if (event === 'change') {
            const currentContent = readFileSync(filePath);
            if (currentContent.length > fileSize) {
              const newContent = currentContent.slice(fileSize).toString();
              process.stdout.write(newContent);
              fileSize = currentContent.length;
            }
          }
        });
      };

      followFile(logFile);
      followFile(errorFile);

      // Keep process alive for tailing
      await new Promise(() => { });
    }

  } catch (err) {
    console.error(`❌ Failed to fetch logs for service '${fullName}': ${err}`);
    process.exit(1);
  }
}
