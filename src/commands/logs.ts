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

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(name: string, options: LogsOptions): Promise<void> {
  try {
    const args = ["--no-pager"];
    if (options.follow) args.push("-f");
    if (options.lines) args.push("-n", options.lines);
    
    const cmd = `journalctl --user ${args.join(" ")} -u ${name}.service`;
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error(`❌ Failed to fetch logs for user service '${name}': ${err}`);
    process.exit(1);
  }
}
