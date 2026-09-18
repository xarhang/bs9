#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { readFileSync, existsSync } from "node:fs";
import { parseServiceArray, getMultipleServiceInfo } from "../utils/array-parser.js";
import { listServices, ServiceMetrics } from "../utils/service-discovery.js";

export interface StatusOptions {
  watch?: boolean;
  json?: boolean;
  raw?: boolean;
}

export async function statusCommand(names: string[], options: StatusOptions): Promise<void> {
  // Multi-service if: multiple args, single arg with array syntax, or 'all' keyword
  if (names.length > 1 || (names.length === 1 && (names[0].includes('[') || names[0] === 'all'))) {
    await handleMultiServiceStatus(names, options);
    return;
  }

  // Single service or all services status
  const name = names[0];
  await handleStatus(options, name);
}

async function handleMultiServiceStatus(name: string | string[], options: StatusOptions): Promise<void> {
  const services = await parseServiceArray(name);

  if (services.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("❌ No services found matching the pattern");
    return;
  }

  const serviceInfo = await getMultipleServiceInfo(services);

  if (options.json) {
    console.log(JSON.stringify(serviceInfo, null, 2));
    return;
  }
  if (options.raw) {
    console.log(JSON.stringify(serviceInfo));
    return;
  }

  console.log(`📊 Multi-Service Status: ${Array.isArray(name) ? name.join(', ') : name}`);
  console.log("=".repeat(80));

  if (serviceInfo.length === 0) {
    console.log("❌ No running services found");
    return;
  }

  displayMultiServiceStatus(serviceInfo, name);

  if (options.watch) {
    console.log("\n🔄 Watching for changes (Ctrl+C to stop)...");
    setInterval(async () => {
      console.clear();
      console.log(`📊 Multi-Service Status: ${Array.isArray(name) ? name.join(', ') : name}`);
      console.log("=".repeat(80));

      const updatedServiceInfo = await getMultipleServiceInfo(services);
      displayMultiServiceStatus(updatedServiceInfo, name);
    }, 2000);
  }
}

async function handleStatus(options: StatusOptions, name?: string): Promise<void> {
  const platformInfo = getPlatformInfo();

  try {
    let services = await listServices();

    // Filter by specific service if provided
    if (name) {
      const clean = name.replace(/^(BS9_|bs9\.)/, "");
      services = services.filter(service => {
        const sClean = service.name.replace(/^(BS9_|bs9\.)/, "");
        if (service.name === name || sClean === clean) return true;
        if (new RegExp(`^${clean}-g\\d+$`).test(sClean)) return true;
        const isWorker = new RegExp(`^${clean}-\\d+(-g\\d+)?$`).test(sClean);
        return isWorker;
      });
    }

    if (options.json) {
      console.log(JSON.stringify(services, null, 2));
      return;
    }
    if (options.raw) {
      console.log(JSON.stringify(services));
      return;
    }

    displayServices(services);

    if (options.watch) {
      console.log("\n🔄 Watching for changes (Ctrl+C to stop)...");
      setInterval(async () => {
        console.clear();
        console.log("🔍 BS9 Service Status");
        console.log("=".repeat(80));

        let updatedServices = await listServices();

        // Filter by specific service if provided
        if (name) {
          const clean = name.replace(/^(BS9_|bs9\.)/, "");
          updatedServices = updatedServices.filter(service => {
            const sClean = service.name.replace(/^(BS9_|bs9\.)/, "");
            if (service.name === name || sClean === clean) return true;
            if (new RegExp(`^${clean}-g\\d+$`).test(sClean)) return true;
            const isWorker = new RegExp(`^${clean}-\\d+(-g\\d+)?$`).test(sClean);
            return isWorker;
          });
        }

        displayServices(updatedServices);
      }, 2000);
    }
  } catch (error) {
    console.error("❌ Failed to get service status:", error);
    process.exit(1);
  }
}

function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.substring(0, maxLen);
  return str.substring(0, maxLen - 3) + "...";
}

function displayServices(services: ServiceMetrics[]): void {
  if (services.length === 0) {
    console.log("No BS9 services found");
    console.log("Use 'bs9 start <file>' to start a service");
    return;
  }

  const termWidth = Math.max(60, process.stdout.columns || 80);

  // Dynamic column layout tailored to terminal width
  const statusWidth = 12;
  const cpuWidth = 9;
  const memWidth = 10;
  const uptimeWidth = 10;
  const tasksWidth = 6;
  const rightColumnsWidth = statusWidth + cpuWidth + memWidth + uptimeWidth + tasksWidth + 5; // 5 spaces between columns

  const svcWidth = Math.max(20, Math.min(32, termWidth - rightColumnsWidth - 1));
  const baseWidth = svcWidth + rightColumnsWidth;
  const showDesc = termWidth >= 100;
  const descWidth = showDesc ? Math.max(12, termWidth - baseWidth - 2) : 0;

  // Header
  let header = `${"SERVICE".padEnd(svcWidth)} ${"STATUS".padEnd(statusWidth)} ${"CPU".padEnd(cpuWidth)} ${"MEMORY".padEnd(memWidth)} ${"UPTIME".padEnd(uptimeWidth)} ${"TASKS".padEnd(tasksWidth)}`;
  if (showDesc) {
    header += ` ${"DESCRIPTION".padEnd(descWidth)}`;
  }
  console.log(header);
  console.log("─".repeat(Math.min(termWidth, header.length)));

  // Sort services by status (running first, then by name)
  const sortedServices = services.sort((a, b) => {
    const aRunning = a.active === "active" && a.sub === "running";
    const bRunning = b.active === "active" && b.sub === "running";
    if (aRunning !== bRunning) return bRunning ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const svc of sortedServices) {
    let status = `${svc.active}/${svc.sub}`;
    if (svc.active === "active" && svc.sub === "running") {
      status = "online";
    } else if (svc.active === "activating" || svc.sub.includes("auto-restart")) {
      status = "restarting";
    } else if (svc.active === "failed" || svc.sub === "failed") {
      status = "errored";
    } else if (svc.active === "inactive" || svc.sub === "stopped") {
      status = "stopped";
    }

    const cleanName = svc.name.replace(/^(BS9_|bs9\.)/, "");
    const displayName = svc.logicalSlot && svc.logicalSlot !== cleanName
      ? `${svc.logicalSlot} -> ${cleanName}`
      : cleanName;

    const truncatedName = truncate(displayName, svcWidth);
    const truncatedStatus = truncate(status, statusWidth);
    const cpuStr = truncate(svc.cpu || "-", cpuWidth);
    const memStr = truncate(svc.memory || "-", memWidth);
    const uptimeStr = truncate(svc.uptime || "-", uptimeWidth);
    const tasksStr = truncate(String(svc.tasks || "-"), tasksWidth);

    let row = `${truncatedName.padEnd(svcWidth)} ${truncatedStatus.padEnd(statusWidth)} ${cpuStr.padEnd(cpuWidth)} ${memStr.padEnd(memWidth)} ${uptimeStr.padEnd(uptimeWidth)} ${tasksStr.padEnd(tasksWidth)}`;
    if (showDesc) {
      row += ` ${truncate(svc.description || "", descWidth).padEnd(descWidth)}`;
    }
    console.log(row);
  }

  // Summary
  console.log("\nService Summary:");
  const totalServices = services.length;
  const runningServices = services.filter(s => s.active === "active").length;
  console.log(`  Status: ${runningServices} running, ${totalServices - runningServices} stopped (${totalServices} total)`);
  console.log(`  Updated: ${new Date().toLocaleString()}`);
}

function displayMultiServiceStatus(serviceInfo: any[], pattern: string | string[]): void {
  const patternStr = Array.isArray(pattern) ? pattern.join(', ') : pattern;
  const running = serviceInfo.filter(s => s.status === 'active');
  const failed = serviceInfo.filter(s => s.status === 'failed');
  const inactive = serviceInfo.filter(s => s.status === 'inactive');

  console.log(`\n📊 Services matching pattern: ${patternStr}`);
  console.log(`   Total: ${serviceInfo.length} services`);
  console.log(`   Running: ${running.length}/${serviceInfo.length} (${((running.length / serviceInfo.length) * 100).toFixed(1)}%)`);
  console.log(`   Failed: ${failed.length}/${serviceInfo.length} (${((failed.length / serviceInfo.length) * 100).toFixed(1)}%)`);
  console.log(`   Inactive: ${inactive.length}/${serviceInfo.length} (${((inactive.length / serviceInfo.length) * 100).toFixed(1)}%)`);

  if (serviceInfo.length > 0) {
    console.log("\n📋 Service Details:");
    console.log("-".repeat(80));

    serviceInfo.forEach(service => {
      const statusIcon = service.status === 'active' ? '✅' :
        service.status === 'failed' ? '❌' : '⏸️';

      console.log(`${statusIcon} ${service.name.padEnd(20)} PID: ${service.pid?.toString().padStart(8) || '-'.padStart(8)} PORT: ${service.port?.toString().padStart(6) || '-'.padStart(6)} STATUS: ${service.status.padEnd(10)}`);
    });
  }
}
