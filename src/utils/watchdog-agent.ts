#!/usr/bin/env bun

/**
 * BS9 - Dedicated Background Watchdog Supervisor
 * 
 * Runs completely detached in the background to monitor a service process.
 * Recovers from crashes using exponential backoff and prevents infinite crash loops.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { recordCrash, resetCrash, sleep, startHealthyTimer } from "./crash-tracker.js";

const serviceName = process.argv[2];
if (!serviceName) {
  console.error("Missing service name for watchdog supervisor");
  process.exit(1);
}

const servicesDir = join(homedir(), ".bs9", "services");
const logsDir = join(homedir(), ".bs9", "logs");
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

function getMetadata(): any {
  const metaPath = join(servicesDir, `${serviceName}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

function saveMetadata(data: any): void {
  const metaPath = join(servicesDir, `${serviceName}.json`);
  writeFileSync(metaPath, JSON.stringify(data, null, 2));
}

async function runSupervisor() {
  const meta = getMetadata();
  if (!meta) {
    process.exit(1);
  }

  let exe = meta.executable;
  let args: string[] = meta.arguments || [];

  if (exe.endsWith(".js") || exe.endsWith(".ts")) {
    exe = process.execPath;
  }

  // Record supervisor PID
  meta.watchdogPid = process.pid;
  saveMetadata(meta);

  // Reset crash history on explicit watchdog start
  resetCrash(serviceName);

  while (true) {
    const currentMeta = getMetadata();
    if (!currentMeta || currentMeta.status === "stopped") {
      // Stopped gracefully by user
      break;
    }

    const out = openSync(join(logsDir, `${serviceName}.out.log`), "a");
    const err = openSync(join(logsDir, `${serviceName}.err.log`), "a");

    const child = spawn(exe, args, {
      cwd: currentMeta.workingDir,
      env: { ...process.env, ...currentMeta.environment },
      stdio: ["ignore", out, err],
    });

    currentMeta.pid = child.pid;
    currentMeta.startTime = new Date().toISOString();
    currentMeta.status = "running";
    saveMetadata(currentMeta);

    let healthyTimer = startHealthyTimer(serviceName);

    // Wait for child to exit
    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    clearTimeout(healthyTimer);

    // Check if service was intentionally stopped
    const freshMeta = getMetadata();
    if (!freshMeta || freshMeta.status === "stopped") {
      break;
    }

    const decision = recordCrash(serviceName, exitCode);

    if (!decision.shouldRestart) {
      freshMeta.status = "crash-loop";
      freshMeta.pid = null;
      saveMetadata(freshMeta);
      break;
    }

    freshMeta.status = "backoff";
    saveMetadata(freshMeta);

    await sleep(decision.delayMs);
  }

  process.exit(0);
}

runSupervisor().catch((err) => {
  console.error("Watchdog supervisor fatal error:", err);
  process.exit(1);
});