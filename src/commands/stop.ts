#!/usr/bin/env bun

import { execSync } from "node:child_process";

export async function stopCommand(name: string): Promise<void> {
  try {
    execSync(`systemctl --user stop ${name}`, { stdio: "inherit" });
    console.log(`🛑 User service '${name}' stopped`);
  } catch (err) {
    console.error(`❌ Failed to stop user service '${name}': ${err}`);
    process.exit(1);
  }
}
