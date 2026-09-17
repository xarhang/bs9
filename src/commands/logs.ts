#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { getPlatformInfo } from "../platform/detect.js";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import { listServices } from "../utils/service-discovery.js";

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function logsCommand(name?: string, options: LogsOptions = {}): Promise<void> {
  const platformInfo = getPlatformInfo();

  // If no name is given, show combined logs for all services (PM2 logs behavior)
  if (!name || name === "all") {
    await showAllLogs(options, platformInfo);
    return;
  }

  // Security: Validate service name
  if (!isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  let targetName = name;
  const clean = name.replace(/^(BS9_|bs9\.)/, "");

  try {
    const allServices = await listServices();
    const exact = allServices.find(s => {
      const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
      return s.name === name || sClean === clean;
    });

    if (exact) {
      targetName = exact.name.replace(/^(BS9_|bs9\.)/, "");
    } else {
      // Logical slot match: e.g. "api-0" matching "api-0-g1", "api-0-g2"
      const slotWorkers = allServices.filter(s => {
        const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
        return new RegExp(`^${clean}-g\\d+$`).test(sClean);
      });
      if (slotWorkers.length > 0) {
        const active = slotWorkers.find(s => s.active === "active") ||
          slotWorkers.sort((a, b) => (b.generation || 0) - (a.generation || 0))[0];
        targetName = active.name.replace(/^(BS9_|bs9\.)/, "");
      }
    }
  } catch {}

  // Resolve full name (e.g. handle BS9_ prefix on Windows)
  let fullName = targetName;
  if (platformInfo.isWindows && !targetName.startsWith('BS9_')) fullName = `BS9_${targetName}`;
  if (platformInfo.isMacOS && !targetName.startsWith('bs9.')) fullName = `bs9.${targetName}`;

  const linesCount = options.lines ? Math.max(1, parseInt(options.lines, 10) || 50) : 50;

  try {
    if (platformInfo.isLinux) {
      try {
        const args = ["--user", "--no-pager", "-n", String(linesCount), "-u", `${fullName}.service`];
        if (options.follow) {
          args.push("-f");
          const child = spawn("journalctl", args, { stdio: "inherit" });
          const exitCode = await new Promise<number>((resolve) => {
            child.once("error", () => resolve(-1));
            child.once("close", (code) => resolve(code ?? -1));
          });
          if (exitCode === 0) return;
        } else {
          // Capture the result so a missing user journal or an empty unit can
          // fall back to BS9's portable file logs. Spawning with inherited
          // stdio hides journalctl's exit status/content from this decision.
          const result = spawnSync("journalctl", args, { encoding: "utf-8" });
          const output = result.stdout?.trim();
          const hasEntries = Boolean(output && !output.includes("-- No entries --"));

          if (result.status === 0 && hasEntries) {
            console.log(output);
            return;
          }
        }
      } catch {
        // Fallback to file-based logs
      }
    }

    let logFile = join(platformInfo.logDir, `${fullName}.out.log`);
    let errorFile = join(platformInfo.logDir, `${fullName}.err.log`);

    if (!existsSync(logFile) && !existsSync(errorFile)) {
      const existingFiles = existsSync(platformInfo.logDir) ? readdirSync(platformInfo.logDir) : [];
      const cleanPrefix = fullName.replace(/^(BS9_|bs9\.)/, "");
      const genLogs = existingFiles
        .filter(f => f.includes(cleanPrefix) && (f.endsWith(".out.log") || f.endsWith(".err.log")))
        .sort().reverse();
      const outCandidate = genLogs.find(f => f.endsWith(".out.log"));
      const errCandidate = genLogs.find(f => f.endsWith(".err.log"));
      if (outCandidate) logFile = join(platformInfo.logDir, outCandidate);
      if (errCandidate) errorFile = join(platformInfo.logDir, errCandidate);
    }

    if (!existsSync(logFile) && !existsSync(errorFile)) {
      console.warn(`⚠️  No log files found for service '${fullName}' in ${platformInfo.logDir}`);
      console.log(`💡 Logs are created when the service is started with BS9.`);
      return;
    }

    const showLogs = (filePath: string, label: string) => {
      if (!existsSync(filePath)) return;
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const lastLines = lines.slice(-linesCount);
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
            try {
              const currentContent = readFileSync(filePath);
              if (currentContent.length < fileSize) {
                fileSize = currentContent.length;
              } else if (currentContent.length > fileSize) {
                const newContent = currentContent.slice(fileSize).toString();
                process.stdout.write(newContent);
                fileSize = currentContent.length;
              }
            } catch {}
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
            if (currentContent.length < fileSize) {
              fileSize = currentContent.length;
            } else if (currentContent.length > fileSize) {
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
