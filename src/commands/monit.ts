#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listServices, ServiceMetrics } from "../utils/service-discovery.js";
import { getPlatformInfo } from "../platform/detect.js";

interface MonitOptions {
  refresh?: string;
}

function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.substring(0, maxLen);
  return str.substring(0, maxLen - 3) + "...";
}

function getServiceLogTail(serviceName: string, maxLines: number = 8): string[] {
  try {
    const platformInfo = getPlatformInfo();
    const logDir = platformInfo.logDir;
    const cleanName = serviceName.replace(/^(BS9_|bs9\.)/, "");

    const candidates = [
      join(logDir, `${serviceName}.out.log`),
      join(logDir, `${cleanName}.out.log`),
      join(logDir, `${serviceName}.err.log`),
      join(logDir, `${cleanName}.err.log`),
    ];

    const lines: string[] = [];
    for (const file of candidates) {
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, "utf-8");
          const fileLines = content.split("\n").filter((l) => l.trim().length > 0);
          for (const line of fileLines.slice(-maxLines)) {
            lines.push(line);
          }
        } catch {}
      }
    }
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export async function monitCommand(options: MonitOptions): Promise<void> {
  const refreshInterval = Math.max(1, Number(options.refresh) || 2);
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let selectedIndex = 0;
  let statusMessage = "";
  let statusMessageTimer: any = null;
  let currentServices: ServiceMetrics[] = [];
  let isRunning = true;

  const setStatus = (msg: string) => {
    statusMessage = msg;
    if (statusMessageTimer) clearTimeout(statusMessageTimer);
    statusMessageTimer = setTimeout(() => {
      statusMessage = "";
    }, 4000);
  };

  // Terminal setup: Alternate screen buffer & hide cursor in TTY mode
  if (isTTY) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
  }

  const cleanup = () => {
    if (!isRunning) return;
    isRunning = false;
    if (isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
      process.stdout.write("\x1b[?1049l\x1b[?25h");
    }
    console.log("Monitoring stopped");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const fetchMetrics = async (): Promise<ServiceMetrics[]> => {
    try {
      const services = await listServices();
      const servicesWithHealth = await Promise.all(
        services.map(async (service) => {
          try {
            let port: string | null = null;
            const portMatch = service.description.match(/port[=:]?\s*(\d+)/i);
            if (portMatch) port = portMatch[1];

            if (port) {
              try {
                const healthCheck = await fetch(`http://localhost:${port}/healthz`, {
                  signal: AbortSignal.timeout(800),
                });
                service.health = healthCheck.status === 200 ? "OK" : "FAIL";
              } catch {
                service.health = "FAIL";
              }
            } else {
              service.health = "-";
            }
          } catch {
            service.health = "-";
          }
          return service;
        })
      );
      return servicesWithHealth;
    } catch {
      return [];
    }
  };

  // Keyboard input handler for interactive TUI
  if (isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      process.stdin.on("data", async (key: string) => {
        if (key === "\u0003" || key === "q" || key === "Q") {
          cleanup();
          return;
        }

        if (currentServices.length > 0) {
          // Up arrow or 'k'
          if (key === "\u001b[A" || key === "k" || key === "K") {
            selectedIndex = Math.max(0, selectedIndex - 1);
            render();
            return;
          }
          // Down arrow or 'j'
          if (key === "\u001b[B" || key === "j" || key === "J") {
            selectedIndex = Math.min(currentServices.length - 1, selectedIndex + 1);
            render();
            return;
          }
          // 'r' to restart selected service
          if (key === "r" || key === "R") {
            const svc = currentServices[selectedIndex];
            if (svc) {
              setStatus(`Restarting '${svc.name}'...`);
              render();
              try {
                const { restartCommand } = await import("./restart.js");
                await restartCommand([svc.name]);
                setStatus(`Service '${svc.name}' restarted`);
              } catch (err: any) {
                setStatus(`Restart error: ${err.message || err}`);
              }
              currentServices = await fetchMetrics();
              render();
            }
            return;
          }
          // 's' to stop selected service
          if (key === "s" || key === "S") {
            const svc = currentServices[selectedIndex];
            if (svc) {
              setStatus(`Stopping '${svc.name}'...`);
              render();
              try {
                const { stopCommand } = await import("./stop.js");
                await stopCommand([svc.name], {});
                setStatus(`Service '${svc.name}' stopped`);
              } catch (err: any) {
                setStatus(`Stop error: ${err.message || err}`);
              }
              currentServices = await fetchMetrics();
              render();
            }
            return;
          }
        }
      });
    } catch {}
  }

  const render = () => {
    if (!isRunning) return;

    const cols = Math.max(60, process.stdout.columns || 80);
    const rows = Math.max(16, process.stdout.rows || 24);

    // Color definitions
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const dim = "\x1b[2m";
    const highlight = "\x1b[7m"; // reverse video for cursor
    const green = "\x1b[32m";
    const red = "\x1b[31m";
    const yellow = "\x1b[33m";
    const cyan = "\x1b[36m";

    const clamp = (str: string, len: number) => {
      if (str.length > len) return str.substring(0, len);
      return str.padEnd(len);
    };

    let buffer = "";

    // Home cursor
    buffer += "\x1b[H";

    // 1. Header Bar
    const title = " BS9 PROCESS MONITOR ";
    const shortcuts = "[↑/↓] Select  [r] Restart  [s] Stop  [q] Quit";
    const statusNote = statusMessage ? ` | ${statusMessage}` : "";
    const headerLine = ` ${bold}${title}${reset}${dim}${shortcuts}${statusNote}${reset}`;
    buffer += `${clamp(headerLine, cols)}\n`;
    buffer += `${dim}${"─".repeat(cols)}${reset}\n`;

    // 2. Calculate dynamic heights
    const availableRows = rows - 4; // header (2), divider (1), footer (1)
    const topPanelHeight = Math.max(4, Math.min(10, Math.floor(availableRows * 0.45)));
    const bottomPanelHeight = Math.max(4, availableRows - topPanelHeight);

    // 3. Render Top Panel: Services Table
    const svcWidth = Math.max(16, Math.min(26, Math.floor(cols * 0.3)));
    const statusWidth = 10;
    const healthWidth = 8;
    const cpuWidth = 8;
    const memWidth = 10;
    const uptimeWidth = 10;
    const pidWidth = 8;

    const tableHeader = `  ${"SERVICE".padEnd(svcWidth)} ${"STATUS".padEnd(statusWidth)} ${"HEALTH".padEnd(healthWidth)} ${"CPU".padEnd(cpuWidth)} ${"MEM".padEnd(memWidth)} ${"UPTIME".padEnd(uptimeWidth)} ${"PID".padEnd(pidWidth)}`;
    buffer += `${dim}${clamp(tableHeader, cols)}${reset}\n`;

    if (currentServices.length === 0) {
      buffer += `${dim}  No services running. Use 'bs9 start <file>' to launch.${reset}\n`;
      for (let i = 1; i < topPanelHeight; i++) buffer += "\n";
    } else {
      // Clamp selectedIndex
      if (selectedIndex >= currentServices.length) selectedIndex = currentServices.length - 1;
      if (selectedIndex < 0) selectedIndex = 0;

      // Scroll window for table
      let startIndex = 0;
      if (selectedIndex >= topPanelHeight - 1) {
        startIndex = selectedIndex - (topPanelHeight - 2);
      }
      const visibleServices = currentServices.slice(startIndex, startIndex + topPanelHeight - 1);

      for (let i = 0; i < topPanelHeight - 1; i++) {
        if (i < visibleServices.length) {
          const globalIdx = startIndex + i;
          const svc = visibleServices[i];
          const isSelected = globalIdx === selectedIndex;

          const pointer = isSelected ? "> " : "  ";
          const cleanName = svc.name.replace(/^(BS9_|bs9\.)/, "");
          const nameCol = truncate(cleanName, svcWidth).padEnd(svcWidth);
          const isOnline = svc.active === "active";
          const statusStr = isOnline ? "online" : svc.active === "failed" ? "errored" : "stopped";
          const statusCol = truncate(statusStr, statusWidth).padEnd(statusWidth);
          const healthCol = truncate(svc.health || "-", healthWidth).padEnd(healthWidth);
          const cpuCol = truncate(svc.cpu || "-", cpuWidth).padEnd(cpuWidth);
          const memCol = truncate(svc.memory || "-", memWidth).padEnd(memWidth);
          const uptimeCol = truncate(svc.uptime || "-", uptimeWidth).padEnd(uptimeWidth);
          const pidCol = truncate(String(svc.pid || "-"), pidWidth).padEnd(pidWidth);

          const rowText = `${pointer}${nameCol} ${statusCol} ${healthCol} ${cpuCol} ${memCol} ${uptimeCol} ${pidCol}`;
          const color = isOnline ? green : red;

          if (isSelected) {
            buffer += `${highlight}${bold}${clamp(rowText, cols)}${reset}\n`;
          } else {
            buffer += `${color}${clamp(rowText, cols)}${reset}\n`;
          }
        } else {
          buffer += "\n";
        }
      }
    }

    // 4. Panel Divider
    const selectedSvc = currentServices[selectedIndex];
    const inspectorTitle = selectedSvc
      ? ` DETAILS & LOGS: ${selectedSvc.name.replace(/^(BS9_|bs9\.)/, "")} `
      : " DETAILS & LOGS ";
    const dividerText = `──${bold}${inspectorTitle}${reset}${dim}${"─".repeat(Math.max(0, cols - inspectorTitle.length - 2))}${reset}`;
    buffer += `${clamp(dividerText, cols)}\n`;

    // 5. Render Bottom Panel: Inspector Details & Live Logs
    if (selectedSvc) {
      // Metadata line
      const cleanName = selectedSvc.name.replace(/^(BS9_|bs9\.)/, "");
      let port = "-";
      const portMatch = selectedSvc.description?.match(/port[=:]?\s*(\d+)/i);
      if (portMatch) port = portMatch[1];

      const metaLine = `  PID: ${cyan}${selectedSvc.pid || "-"}${reset}  Port: ${cyan}${port}${reset}  Memory: ${yellow}${selectedSvc.memory || "-"}${reset}  CPU: ${yellow}${selectedSvc.cpu || "-"}${reset}  Uptime: ${selectedSvc.uptime || "-"}`;
      buffer += `${clamp(metaLine, cols)}\n`;

      // Logs tail
      const logLinesCount = Math.max(1, bottomPanelHeight - 2);
      const logs = getServiceLogTail(selectedSvc.name, logLinesCount);

      if (logs.length === 0) {
        buffer += `${dim}  (No recent log entries found for ${cleanName})${reset}\n`;
        for (let j = 1; j < logLinesCount; j++) buffer += "\n";
      } else {
        for (let j = 0; j < logLinesCount; j++) {
          if (j < logs.length) {
            const rawLog = logs[j].replace(/[\r\n]/g, "");
            buffer += `${dim}  ${truncate(rawLog, cols - 4)}${reset}\n`;
          } else {
            buffer += "\n";
          }
        }
      }
    } else {
      buffer += `${dim}  Select a service to inspect details and live logs.${reset}\n`;
      for (let j = 1; j < bottomPanelHeight; j++) buffer += "\n";
    }

    // Clear remainder of terminal
    buffer += "\x1b[J";

    process.stdout.write(buffer);
  };

  // Resize listener
  if (process.stdout.on) {
    process.stdout.on("resize", () => {
      render();
    });
  }

  // Initial fetch and render
  currentServices = await fetchMetrics();
  render();

  // Background polling loop
  while (isRunning) {
    await delay(refreshInterval * 1000);
    if (!isRunning) break;
    currentServices = await fetchMetrics();
    render();
  }
}