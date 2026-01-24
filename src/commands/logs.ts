#!/usr/bin/env bun

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
