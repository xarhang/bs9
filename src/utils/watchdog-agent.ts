#!/usr/bin/env bun

/**
 * BS9 - Dedicated Background Watchdog Supervisor
 * 
 * Runs completely detached in the background to monitor a service process.
 * Recovers from crashes using exponential backoff and prevents infinite crash loops.
 * Supports: --watch, --max-memory-restart, --restart-delay, --no-autorestart, --time
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, execSync } from "node:child_process";
import { openSync, closeSync, existsSync, readFileSync, writeFileSync, mkdirSync, watch as fsWatch, createWriteStream } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { recordCrash, resetCrash, sleep, startHealthyTimer } from "./crash-tracker.js";
import { rotateLogIfNeeded, parseLogSizeBytes, DEFAULT_MAX_LOG_FILES } from "./log-rotator.js";

// Detach completely from console on Windows so terminal closure does not terminate supervisor
if (process.platform === "win32") {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      FreeConsole: {
        args: [],
        returns: FFIType.bool,
      },
    });
    kernel32.symbols.FreeConsole();
  } catch {}
}

// Ignore terminal hangup signal on POSIX and Windows so watchdog survives terminal/SSH closure
process.on("SIGHUP", () => {
  // Ignored by design in background watchdog
});

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

const serviceName = process.argv[2];
if (!serviceName || !isValidServiceName(serviceName)) {
  console.error("Missing or invalid service name for watchdog supervisor");
  process.exit(1);
}

const platformInfo = getPlatformInfo();
const servicesDir = process.env.BS9_SERVICES_DIR || (process.argv[3] && existsSync(process.argv[3]) ? process.argv[3] : platformInfo.serviceDir);
const logsDir = platformInfo.logDir;
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
  let args: string[] = meta.arguments ? [...meta.arguments] : [];

  if (exe && (exe.endsWith(".js") || exe.endsWith(".ts"))) {
    const script = exe;
    exe = process.execPath;
    if (!args.includes(script)) {
      args = ["run", script, ...args];
    }
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
    const logRotationOpts = {
      maxBytes: parseLogSizeBytes(currentMeta.maxLogSize || process.env.BS9_MAX_LOG_SIZE),
      maxFiles: Number(currentMeta.maxLogFiles || process.env.BS9_MAX_LOG_FILES) || DEFAULT_MAX_LOG_FILES,
    };
    rotateLogIfNeeded(outPath, logRotationOpts);
    rotateLogIfNeeded(errPath, logRotationOpts);

    const withTime = Boolean(currentMeta.time);
    let child: any;
    let outStream: ReturnType<typeof createWriteStream> | null = null;
    let errStream: ReturnType<typeof createWriteStream> | null = null;

    if (withTime) {
      // Stream with timestamp prefix using non-blocking buffered WriteStream
      outStream = createWriteStream(outPath, { flags: "a" });
      errStream = createWriteStream(errPath, { flags: "a" });
      let outBytes = 0;
      let errBytes = 0;

      child = spawn(exe, args, {
        cwd: currentMeta.workingDir,
        env: { ...process.env, ...currentMeta.environment },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        const time = new Date().toISOString();
        const lines = chunk.toString().split("\n");
        const formatted = lines.map((l) => (l.length ? `[${time}] ${l}` : l)).join("\n");
        outStream!.write(formatted);
        outBytes += Buffer.byteLength(formatted);
        if (outBytes >= logRotationOpts.maxBytes) {
          outBytes = 0;
          rotateLogIfNeeded(outPath, logRotationOpts);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const time = new Date().toISOString();
        const lines = chunk.toString().split("\n");
        const formatted = lines.map((l) => (l.length ? `[${time}] ${l}` : l)).join("\n");
        errStream!.write(formatted);
        errBytes += Buffer.byteLength(formatted);
        if (errBytes >= logRotationOpts.maxBytes) {
          errBytes = 0;
          rotateLogIfNeeded(errPath, logRotationOpts);
        }
      });
    } else {
      const out = openSync(outPath, "a");
      const err = openSync(errPath, "a");
      child = spawn(exe, args, {
        cwd: currentMeta.workingDir,
        env: { ...process.env, ...currentMeta.environment },
        stdio: ["ignore", out, err],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child.unref();
      try { closeSync(out); } catch {}
      try { closeSync(err); } catch {}
    }

    currentMeta.pid = child.pid;
    currentMeta.startTime = new Date().toISOString();
    currentMeta.status = "running";
    saveMetadata(currentMeta);

    let healthyTimer = startHealthyTimer(serviceName);
    const logRotateInterval = setInterval(() => {
      rotateLogIfNeeded(outPath, logRotationOpts);
      rotateLogIfNeeded(errPath, logRotationOpts);
    }, 30_000);
    if (typeof logRotateInterval.unref === "function") logRotateInterval.unref();

    // Memory monitoring loop if maxMemoryRestart is configured
    let memoryMonitorInterval: any = null;
    if (memoryLimitBytes && child.pid) {
      memoryMonitorInterval = setInterval(() => {
        try {
          if (process.platform === "win32") {
            const out = execSync(
              `powershell -NoProfile -Command "try { (Get-Process -Id ${child.pid} -ErrorAction Stop).WorkingSet64 } catch { 0 }"`,
              { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
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

    let cronTimer: ReturnType<typeof setTimeout> | null = null;
    if (currentMeta.cron && typeof currentMeta.cron === "string") {
      try {
        const { getNextCronDelayMs } = await import("./cron.js");
        const delayMs = getNextCronDelayMs(currentMeta.cron);
        cronTimer = setTimeout(() => {
          console.log(`⏰ [Cron] Scheduled restart triggered for '${serviceName}' (${currentMeta.cron})`);
          restartTriggeredByWatch = true;
          try { child.kill("SIGTERM"); } catch {}
        }, delayMs);
        if (typeof cronTimer.unref === "function") cronTimer.unref();
      } catch (err) {
        console.warn(`⚠️ [Cron] Invalid cron expression '${currentMeta.cron}': ${err}`);
      }
    }

    // Wait for child to exit
    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code: number | null) => resolve(code));
    });

    if (cronTimer) clearTimeout(cronTimer);
    clearInterval(logRotateInterval);
    clearInterval(memoryMonitorInterval);
    clearTimeout(healthyTimer);
    try { outStream?.end(); } catch {}
    try { errStream?.end(); } catch {}

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