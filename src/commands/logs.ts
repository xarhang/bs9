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
import { existsSync, readFileSync, readdirSync, watch } from "node:fs";

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(name?: string, options: LogsOptions = {}): Promise<void> {
  const platformInfo = getPlatformInfo();

  // If no name is given, show combined logs for all services (PM2 logs behavior)
  if (!name || name === "all") {
    await showAllLogs(options, platformInfo);
    return;
  }

  // Resolve full name (e.g. handle BS9_ prefix on Windows)
  let fullName = name;
  if (platformInfo.isWindows && !name.startsWith('BS9_')) fullName = `BS9_${name}`;
  if (platformInfo.isMacOS && !name.startsWith('bs9.')) fullName = `bs9.${name}`;

  try {
    if (platformInfo.isLinux) {
      try {
        const args = ["--user", "--no-pager"];
        if (options.lines) args.push("-n", options.lines || "50");
        args.push("-u", `${fullName}.service`);

        if (options.follow) {
          args.push("-f");
          const child = spawn("journalctl", args, { stdio: "inherit" });
          await new Promise<void>((resolve) => child.on("close", resolve));
        } else {
          execSync(`journalctl ${args.join(" ")}`, { stdio: "inherit" });
        }
        return;
      } catch {
        // Fallback to file-based logs
      }
    }

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
      console.log(`\n👀 Following logs for '${name}'... (Ctrl+C to stop)`);

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

      await new Promise(() => { });
    }

  } catch (err) {
    console.error(`❌ Failed to fetch logs for service '${fullName}': ${err}`);
    process.exit(1);
  }
}

async function showAllLogs(options: LogsOptions, platformInfo: any): Promise<void> {
  const logDir = platformInfo.logDir;
  if (!existsSync(logDir)) {
    console.log(`📋 No log files found in ${logDir}`);
    return;
  }

  const logFiles = readdirSync(logDir).filter(f => f.endsWith(".out.log") || f.endsWith(".err.log"));
  if (logFiles.length === 0) {
    console.log(`📋 No active service logs found in ${logDir}`);
    return;
  }

  const count = parseInt(options.lines || "20");

  console.log(`\n================================================================================`);
  console.log(`📜 Combined Logs for all BS9 Services (last ${count} lines)`);
  console.log(`================================================================================\n`);

  for (const file of logFiles) {
    const fullPath = join(logDir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);
      const recent = lines.slice(-count);
      if (recent.length > 0) {
        console.log(`--- [${file}] ---`);
        console.log(recent.join("\n"));
        console.log("");
      }
    } catch {}
  }

  if (options.follow) {
    console.log(`👀 Streaming combined logs... (Ctrl+C to stop)`);
    for (const file of logFiles) {
      const fullPath = join(logDir, file);
      let fileSize = readFileSync(fullPath).length;
      watch(fullPath, (event) => {
        if (event === "change") {
          try {
            const currentContent = readFileSync(fullPath);
            if (currentContent.length > fileSize) {
              const chunk = currentContent.slice(fileSize).toString();
              const labeled = chunk.split("\n").map(l => l ? `[${file}] ${l}` : l).join("\n");
              process.stdout.write(labeled);
              fileSize = currentContent.length;
            }
          } catch {}
        }
      });
    }
    await new Promise(() => { });
  }
}