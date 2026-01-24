#!/usr/bin/env bun

import { execSync } from "node:child_process";

export async function restartCommand(name: string): Promise<void> {
  try {
    execSync(`systemctl --user restart ${name}`, { stdio: "inherit" });
    console.log(`🔄 User service '${name}' restarted`);
  } catch (err) {
    console.error(`❌ Failed to restart user service '${name}': ${err}`);
    process.exit(1);
  }
}
