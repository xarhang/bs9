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

  // Non-interactive output (pipes, IDE output panes, CI) cannot handle cursor
  // movement or keyboard input. Print one readable snapshot instead of
  // repeatedly writing terminal control sequences into the output stream.
  if (!isTTY) {
    currentServices = await fetchMetrics();
    console.log("BS9 PROCESS MONITOR (snapshot)");
    console.log("─".repeat(72));

    if (currentServices.length === 0) {
      console.log("No services running.");
      console.log("Start one with: bs9 start <file> --name <service>");
    } else {
      console.log("SERVICE                 STATUS      HEALTH   CPU      MEM       UPTIME    PID");
      for (const service of currentServices) {
        const cleanName = service.name.replace(/^(BS9_|bs9\.)/, "");
        const status = service.active === "active" ? "online" : service.active === "failed" ? "errored" : "stopped";
        console.log(
          `${truncate(cleanName, 23).padEnd(23)}  ${status.padEnd(10)}  ${(service.health || "-").padEnd(7)}  ${(service.cpu || "-").padEnd(7)}  ${(service.memory || "-").padEnd(8)}  ${(service.uptime || "-").padEnd(8)}  ${service.pid || "-"}`,
        );
      }
    }

    console.log("\nInteractive controls are available when bs9 monit runs in a terminal.");
    return;
  }

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
    const blue = "\x1b[34m";

    const fit = (str: string, len: number) => {
      if (str.length > len) return str.substring(0, len);
      return str.padEnd(len);
    };
    const contentWidth = cols - 4;
    const innerWidth = cols - 2;
    const contentLine = (value: string) => `│ ${fit(value, contentWidth)} │`;
    const sectionLine = (title: string) => {
      const label = ` ${truncate(title, innerWidth - 5)} `;
      return `├─${label}${"─".repeat(Math.max(0, innerWidth - label.length - 3))}┤`;
    };
    const topLine = `┌${"─".repeat(innerWidth)}┐`;
    const bottomLine = `└${"─".repeat(innerWidth)}┘`;

    // Keep the services table compact so the details and logs remain visible.
    if (currentServices.length > 0) {
      selectedIndex = Math.max(0, Math.min(selectedIndex, currentServices.length - 1));
    } else {
      selectedIndex = 0;
    }

    const widths = { status: 8, health: 6, cpu: 6, memory: 7, uptime: 7, pid: 6 };
    const serviceWidth = Math.max(10, contentWidth - 6 - Object.values(widths).reduce((sum, value) => sum + value, 0));
    const tableHeader = `${"SERVICE".padEnd(serviceWidth)} ${"STATUS".padEnd(widths.status)} ${"HEALTH".padEnd(widths.health)} ${"CPU".padEnd(widths.cpu)} ${"MEM".padEnd(widths.memory)} ${"UPTIME".padEnd(widths.uptime)} ${"PID".padEnd(widths.pid)}`;
    const maxServiceRows = Math.max(2, Math.min(7, Math.floor(rows * 0.28)));
    const visibleCount = Math.min(currentServices.length, maxServiceRows);
    let startIndex = Math.max(0, selectedIndex - visibleCount + 1);
    if (selectedIndex < startIndex) startIndex = selectedIndex;
    const visibleServices = currentServices.slice(startIndex, startIndex + visibleCount);
    const title = "BS9 PROCESS MONITOR";
    const liveLabel = "LIVE";
    const titleGap = Math.max(1, contentWidth - title.length - liveLabel.length);

    const lines: string[] = [
      topLine,
      `│ ${bold}${title}${reset}${" ".repeat(titleGap)}${dim}${liveLabel}${reset} │`,
      contentLine(`Refresh: ${refreshInterval}s    ${statusMessage || "Press ↑/↓ to select a service"}`),
      sectionLine(`SERVICES  ${currentServices.length}`),
      `│ ${dim}${fit(tableHeader, contentWidth)}${reset} │`,
    ];

    if (currentServices.length === 0) {
      lines.push(contentLine("No services running yet."));
      lines.push(contentLine("Start one with: bs9 start <file> --name <service>"));
    } else {
      for (let rowIndex = 0; rowIndex < visibleServices.length; rowIndex++) {
        const service = visibleServices[rowIndex];
        const globalIndex = startIndex + rowIndex;
        const cleanName = service.name.replace(/^(BS9_|bs9\.)/, "");
        const status = service.active === "active" ? "online" : service.active === "failed" ? "errored" : "stopped";
        const row = `${globalIndex === selectedIndex ? "› " : "  "}${truncate(cleanName, serviceWidth - 2).padEnd(serviceWidth - 2)} ${truncate(status, widths.status).padEnd(widths.status)} ${(service.health || "-").padEnd(widths.health)} ${truncate(service.cpu || "-", widths.cpu).padEnd(widths.cpu)} ${truncate(service.memory || "-", widths.memory).padEnd(widths.memory)} ${truncate(service.uptime || "-", widths.uptime).padEnd(widths.uptime)} ${truncate(String(service.pid || "-"), widths.pid).padEnd(widths.pid)}`;
        const color = service.active === "active" ? green : service.active === "failed" ? red : yellow;
        lines.push(`│ ${globalIndex === selectedIndex ? `${highlight}${bold}${fit(row, contentWidth)}${reset}` : `${color}${fit(row, contentWidth)}${reset}`} │`);
      }
    }

    const selectedSvc = currentServices[selectedIndex];
    const cleanName = selectedSvc?.name.replace(/^(BS9_|bs9\.)/, "");
    lines.push(sectionLine(selectedSvc ? `DETAILS & LOGS  ${cleanName}` : "DETAILS & LOGS"));

    if (selectedSvc) {
      const portMatch = selectedSvc.description?.match(/port[=:]?\s*(\d+)/i);
      const meta = `PID: ${selectedSvc.pid || "-"}   Port: ${portMatch?.[1] || "-"}   Memory: ${selectedSvc.memory || "-"}   CPU: ${selectedSvc.cpu || "-"}   Uptime: ${selectedSvc.uptime || "-"}`;
      lines.push(contentLine(meta));
    } else {
      lines.push(contentLine("Select a service to inspect its status and recent logs."));
    }

    const footer = `↑/↓ or j/k Select   r Restart   s Stop   q Quit   •   Refresh ${refreshInterval}s`;
    const logBudget = Math.max(0, rows - lines.length - 2); // footer and bottom border
    if (selectedSvc) {
      const logs = getServiceLogTail(selectedSvc.name, Math.max(1, logBudget));
      if (logs.length === 0 && logBudget > 0) {
        lines.push(contentLine("No recent log entries found."));
        for (let i = 1; i < logBudget; i++) lines.push(contentLine(""));
      } else {
        for (let i = 0; i < logBudget; i++) {
          const rawLog = logs[i]?.replace(/[\r\n]/g, "") || "";
          lines.push(`│ ${dim}${fit(truncate(rawLog, contentWidth), contentWidth)}${reset} │`);
        }
      }
    } else {
      for (let i = 0; i < logBudget; i++) lines.push(contentLine(""));
    }

    lines.push(`│ ${blue}${fit(footer, contentWidth)}${reset} │`);
    lines.push(bottomLine);

    // Use a full-screen redraw only in a real terminal.
    process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, rows).join("\n")}\x1b[J`);
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
