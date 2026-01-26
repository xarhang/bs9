#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { readFileSync, existsSync } from "node:fs";
import { parseServiceArray, getMultipleServiceInfo } from "../utils/array-parser.js";
import { listServices, ServiceMetrics } from "../utils/service-discovery.js";

interface StatusOptions {
  watch?: boolean;
}

export async function statusCommand(options: StatusOptions, names: string[] = []): Promise<void> {
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
    console.log("❌ No services found matching the pattern");
    return;
  }

  console.log(`📊 Multi-Service Status: ${Array.isArray(name) ? name.join(', ') : name}`);
  console.log("=".repeat(80));

  const serviceInfo = await getMultipleServiceInfo(services);

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
      services = services.filter(service => service.name === name);
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
          updatedServices = updatedServices.filter(service => service.name === name);
        }

        displayServices(updatedServices);
      }, 2000);
    }
  } catch (error) {
    console.error("❌ Failed to get service status:", error);
    process.exit(1);
  }
}

function displayServices(services: ServiceMetrics[]): void {
  if (services.length === 0) {
    console.log("📋 No BS9 services found");
    console.log("💡 Use 'bs9 start <file>' or 'bs9 deploy <file>' to create a service");
    return;
  }

  // Header with better formatting
  console.log(`${"SERVICE".padEnd(18)} ${"STATUS".padEnd(15)} ${"CPU".padEnd(10)} ${"MEMORY".padEnd(12)} ${"UPTIME".padEnd(12)} ${"TASKS".padEnd(8)} DESCRIPTION`);
  console.log("─".repeat(100));

  // Sort services by status (running first, then by name)
  const sortedServices = services.sort((a, b) => {
    const aRunning = a.active === "active" && a.sub === "running";
    const bRunning = b.active === "active" && a.sub === "running";
    if (aRunning !== bRunning) return bRunning ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const svc of sortedServices) {
    // Better status formatting with indicators
    let statusIndicator = "";
    let status = `${svc.active}/${svc.sub}`;

    if (svc.active === "active" && svc.sub === "running") {
      statusIndicator = "✅";
      status = "running";
    } else if (svc.active === "activating" || svc.sub.includes("auto-restart")) {
      statusIndicator = "🔄";
      status = "restarting";
    } else if (svc.active === "failed" || svc.sub === "failed") {
      statusIndicator = "❌";
      status = "failed";
    } else if (svc.active === "inactive" || svc.sub === "stopped") {
      statusIndicator = "⏸️";
      status = "stopped";
    } else {
      statusIndicator = "⚠️";
    }

    const displayStatus = `${statusIndicator} ${status}`;

    console.log(
      `${svc.name.padEnd(18)} ${displayStatus.padEnd(15)} ${svc.cpu.padEnd(10)} ${svc.memory.padEnd(12)} ${svc.uptime.padEnd(12)} ${(svc.tasks || "-").padEnd(8)} ${svc.description}`
    );
  }

  // Enhanced summary
  console.log("\n📊 Service Summary:");
  const totalServices = services.length;
  const runningServices = services.filter(s => s.active === "active").length;

  console.log(`  📈 Status: ${runningServices} running, ${totalServices - runningServices} not running`);
  console.log(`  📦 Total: ${runningServices}/${totalServices} services active`);
  console.log(`  🕒 Last updated: ${new Date().toLocaleString()}`);
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
