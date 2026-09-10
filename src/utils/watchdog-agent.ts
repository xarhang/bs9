#!/usr/bin/env bun

/**
 * BS9 - Dedicated Background Watchdog Supervisor
 * 
 * Runs completely detached in the background to monitor a service process.
 * Recovers from crashes using exponential backoff and prevents infinite crash loops.
 * Supports: --watch, --max-memory-restart, --restart-delay, --no-autorestart, --time
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { spawn, execSync } from "node:child_process";
import { openSync, existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch, appendFileSync } from "node:fs";
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

function parseMemoryBytes(val?: string): number | null {
  if (!val) return null;
  const match = val.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?B?)$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "M").toUpperCase();
  if (unit.startsWith("G")) return Math.round(num * 1024 * 1024 * 1024);
  if (unit.startsWith("M")) return Math.round(num * 1024 * 1024);
  if (unit.startsWith("K")) return Math.round(num * 1024);
  return Math.round(num * 1024 * 1024);
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

  const memoryLimitBytes = parseMemoryBytes(meta.maxMemoryRestart);

  // File watcher setup if --watch is active
  let watcher: any = null;
  let restartTriggeredByWatch = false;

  if (meta.watch && meta.workingDir && existsSync(meta.workingDir)) {
    let debounceTimer: any = null;
    try {
      watcher = fsWatch(meta.workingDir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        if (
          filename.includes(".git") ||
          filename.includes("node_modules") ||
          filename.includes(".bs9") ||
          filename.endsWith(".log")
        ) {
          return;
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`👀 [Watch] File change detected: ${filename}. Restarting '${serviceName}'...`);
          restartTriggeredByWatch = true;
          const current = getMetadata();
          if (current && current.pid) {
            try {
              process.kill(current.pid, "SIGTERM");
            } catch {}
          }
        }, 500);
      });
    } catch (e) {
      console.warn("⚠️  File watcher initialization warning:", e);
    }
  }

  while (true) {
    const currentMeta = getMetadata();
    if (!currentMeta || currentMeta.status === "stopped") {
      // Stopped gracefully by user
      break;
    }

    const outPath = join(logsDir, `${serviceName}.out.log`);
    const errPath = join(logsDir, `${serviceName}.err.log`);

    const withTime = Boolean(currentMeta.time);
    let child: any;

    if (withTime) {
      // Stream with timestamp prefix
      child = spawn(exe, args, {
        cwd: currentMeta.workingDir,
        env: { ...process.env, ...currentMeta.environment },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const time = new Date().toISOString();
        const lines = chunk.toString().split("\n");
        const formatted = lines.map((l) => (l.length ? `[${time}] ${l}` : l)).join("\n");
        appendFileSync(outPath, formatted);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const time = new Date().toISOString();
        const lines = chunk.toString().split("\n");
        const formatted = lines.map((l) => (l.length ? `[${time}] ${l}` : l)).join("\n");
        appendFileSync(errPath, formatted);
      });
    } else {
      const out = openSync(outPath, "a");
      const err = openSync(errPath, "a");
      child = spawn(exe, args, {
        cwd: currentMeta.workingDir,
        env: { ...process.env, ...currentMeta.environment },
        stdio: ["ignore", out, err],
      });
    }

    currentMeta.pid = child.pid;
    currentMeta.startTime = new Date().toISOString();
    currentMeta.status = "running";
    saveMetadata(currentMeta);

    let healthyTimer = startHealthyTimer(serviceName);

    // Memory monitoring loop if maxMemoryRestart is configured
    let memoryMonitorInterval: any = null;
    if (memoryLimitBytes && child.pid) {
      memoryMonitorInterval = setInterval(() => {
        try {
          if (process.platform === "win32") {
            const out = execSync(
              `powershell -NoProfile -Command "try { (Get-Process -Id ${child.pid} -ErrorAction Stop).WorkingSet64 } catch { 0 }"`,
              { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
            ).trim();
            const bytes = parseInt(out, 10);
            if (bytes > memoryLimitBytes) {
              console.warn(`⚠️ [Watchdog] Service '${serviceName}' memory limit exceeded (${Math.round(bytes / 1024 / 1024)}MB > ${Math.round(memoryLimitBytes / 1024 / 1024)}MB). Auto-restarting...`);
              child.kill("SIGTERM");
            }
          }
        } catch {}
      }, 5000);
    }

    // Wait for child to exit
    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code));
    });

    clearInterval(memoryMonitorInterval);
    clearTimeout(healthyTimer);

    // Check if service was intentionally stopped
    const freshMeta = getMetadata();
    if (!freshMeta || freshMeta.status === "stopped") {
      break;
    }

    // Check --no-autorestart
    if (freshMeta.noAutorestart && !restartTriggeredByWatch) {
      freshMeta.status = "stopped";
      freshMeta.pid = null;
      saveMetadata(freshMeta);
      console.log(`ℹ️ [Watchdog] Service '${serviceName}' exited. Auto-restart disabled via --no-autorestart.`);
      break;
    }

    // If restart was triggered by watch, don't penalize crash tracker
    if (restartTriggeredByWatch) {
      restartTriggeredByWatch = false;
      await sleep(200);
      continue;
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

    const delay = freshMeta.restartDelay ? Math.max(freshMeta.restartDelay, decision.delayMs) : decision.delayMs;
    await sleep(delay);
  }

  if (watcher) {
    try { watcher.close(); } catch {}
  }

  process.exit(0);
}

runSupervisor().catch((err) => {
  console.error("Watchdog supervisor fatal error:", err);
  process.exit(1);
});