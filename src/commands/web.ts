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
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface WebOptions {
  action?: string;
  port?: string;
  detach?: boolean;
  stop?: boolean;
  status?: boolean;
}

// Security: Port validation
export function isValidPort(port: string): boolean {
  const portNum = Number(port);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

// Security: Generate secure session token
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function getWebPidFile(): string {
  const configDir = join(homedir(), '.bs9');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return join(configDir, 'web.pid');
}

export function readWebPidInfo(): { pid: number; port?: string } | null {
  const pidFile = getWebPidFile();
  if (!existsSync(pidFile)) return null;
  try {
    const content = readFileSync(pidFile, 'utf8').trim();
    if (!content) return null;
    if (content.startsWith('{')) {
      const data = JSON.parse(content);
      if (typeof data.pid === 'number') {
        return { pid: data.pid, port: data.port };
      }
    }
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && pid > 0) {
      return { pid };
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopWebDashboard(): boolean {
  const info = readWebPidInfo();
  const pidFile = getWebPidFile();

  if (!info) {
    console.log("⚠️  No background BS9 Web Dashboard is currently running.");
    return false;
  }

  const { pid } = info;
  if (!isProcessAlive(pid)) {
    console.log(`⚠️  Web dashboard (PID: ${pid}) is no longer active. Cleaned up stale PID file.`);
    try { rmSync(pidFile, { force: true }); } catch {}
    return true;
  }

  console.log(`🛑 Stopping BS9 Web Dashboard (PID: ${pid})...`);
  try {
    if (process.platform === 'win32') {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    try { rmSync(pidFile, { force: true }); } catch {}
    console.log(`✅ BS9 Web Dashboard (PID: ${pid}) stopped successfully.`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to stop Web Dashboard: ${error}`);
    return false;
  }
}

export async function webCommand(actionOrOptions?: string | WebOptions, maybeOptions?: WebOptions): Promise<void> {
  let action: string | undefined;
  let options: WebOptions = {};

  if (typeof actionOrOptions === 'string') {
    action = actionOrOptions;
    options = maybeOptions || {};
  } else if (typeof actionOrOptions === 'object' && actionOrOptions !== null) {
    options = actionOrOptions;
    action = options.action;
  } else {
    options = maybeOptions || {};
  }

  // Handle stop action or --stop flag
  if (action === 'stop' || options.stop) {
    stopWebDashboard();
    return;
  }

  // Handle status action or --status flag
  if (action === 'status' || options.status) {
    const info = readWebPidInfo();
    if (!info) {
      console.log("ℹ️  BS9 Web Dashboard is not running in background.");
      return;
    }
    if (isProcessAlive(info.pid)) {
      console.log(`✅ BS9 Web Dashboard is running in background (PID: ${info.pid}${info.port ? `, port: ${info.port}` : ''}).`);
    } else {
      console.log(`⚠️  BS9 Web Dashboard (PID: ${info.pid}) is dead (stale PID file cleaned).`);
      try { rmSync(getWebPidFile(), { force: true }); } catch {}
    }
    return;
  }

  // Security: Validate port
  const port = options.port || "8080";
  if (!isValidPort(port)) {
    console.error(`❌ Security: Invalid port number: ${port}. Must be 1-65535`);
    process.exit(1);
  }

  // Check if background web dashboard is already running
  const existingInfo = readWebPidInfo();
  if (existingInfo) {
    if (isProcessAlive(existingInfo.pid)) {
      console.log(`⚠️  BS9 Web Dashboard is already running in background (PID: ${existingInfo.pid}).`);
      console.log(`   Stop it first with: bs9 web stop`);
      return;
    } else {
      try { rmSync(getWebPidFile(), { force: true }); } catch {}
    }
  }

  const dashboardPath = `${import.meta.dir}/../web/dashboard.ts`;

  // Security: Generate session token for authentication
  const sessionToken = generateSessionToken();

  console.log(`🌐 Starting BS9 Web Dashboard on port ${port}`);
  console.log(`🔐 Session Token: ${sessionToken}`);

  if (options.detach) {
    const logDir = join(homedir(), '.bs9', 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const webLog = join(logDir, 'web.log');
    let outFd: any = 'ignore';
    let errFd: any = 'ignore';
    try {
      const fs = await import("node:fs");
      outFd = fs.openSync(webLog, 'a');
      errFd = fs.openSync(webLog, 'a');
    } catch {}

    // Run in background with security
    const child = spawn(process.execPath, ["run", dashboardPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        WEB_DASHBOARD_PORT: port,
        WEB_SESSION_TOKEN: sessionToken,
        BS9_DASHBOARD_DETACH: "1",
        NODE_ENV: "production",
      },
    });

    child.unref();

    let actualPid = child.pid;
    let attempts = 0;
    while (attempts < 10) {
      await Bun.sleep(100);
      const info = readWebPidInfo();
      if (info?.pid && isProcessAlive(info.pid)) {
        actualPid = info.pid;
        break;
      }
      attempts++;
    }

    if (!readWebPidInfo() && child.pid) {
      try {
        writeFileSync(getWebPidFile(), JSON.stringify({ pid: child.pid, port, startedAt: Date.now() }), 'utf8');
      } catch {}
    }

    console.log(`✅ Web dashboard started in background`);
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   Process ID: ${actualPid}`);
    console.log(`   Stop with: bs9 web stop`);
    console.log(`   🔐 Use session token for API access`);
  } else {
    // Run in foreground with security
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   🔐 Session token: ${sessionToken}`);
    console.log(`   Press Ctrl+C to stop`);
    console.log('');

    try {
      execSync(`bun run "${dashboardPath}"`, {
        stdio: "inherit",
        env: {
          ...process.env,
          WEB_DASHBOARD_PORT: port,
          WEB_SESSION_TOKEN: sessionToken,
          NODE_ENV: "production",
        }
      });
    } catch (error) {
      console.error(`❌ Failed to start web dashboard: ${error}`);
      process.exit(1);
    }
  }
}
