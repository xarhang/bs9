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
import { getPlatformInfo } from "../platform/detect.js";
import { readFileSync } from "node:fs";

interface StatusOptions {
  watch?: boolean;
}

interface ServiceStatus {
  name: string;
  loaded: string;
  active: string;
  sub: string;
  description: string;
  cpu?: string;
  memory?: string;
  uptime?: string;
  tasks?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const platformInfo = getPlatformInfo();
  
  try {
    let services: ServiceStatus[] = [];
    
    if (platformInfo.isLinux) {
      services = await getLinuxServices();
    } else if (platformInfo.isMacOS) {
      services = await getMacOSServices();
    } else if (platformInfo.isWindows) {
      services = await getWindowsServices();
    }
    
    displayServices(services);
    
    if (options.watch) {
      console.log("\n🔄 Watching for changes (Ctrl+C to stop)...");
      setInterval(async () => {
        console.clear();
        console.log("🔍 BS9 Service Status");
        console.log("=".repeat(80));
        
        let updatedServices: ServiceStatus[] = [];
        if (platformInfo.isLinux) {
          updatedServices = await getLinuxServices();
        } else if (platformInfo.isMacOS) {
          updatedServices = await getMacOSServices();
        } else if (platformInfo.isWindows) {
          updatedServices = await getWindowsServices();
        }
        
        displayServices(updatedServices);
      }, 2000);
    }
  } catch (err) {
    console.error("❌ Failed to get service status:", err);
    process.exit(1);
  }
}

async function getLinuxServices(): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];
  
  try {
    const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
    const lines = listOutput.split("\n").filter(line => line.includes(".service"));
    
    for (const line of lines) {
      const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
      if (!match) continue;
      
      const [, statusIndicator, name, loaded, active, sub, description] = match;
      
      if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;
      
      const status: ServiceStatus = {
        name,
        loaded,
        active,
        sub,
        description,
      };
      
      // Get additional metrics
      try {
        const showOutput = execSync(`systemctl --user show ${name} -p CPUUsageNSec MemoryCurrent ActiveEnterTimestamp TasksCurrent`, { encoding: "utf-8" });
        const cpuMatch = showOutput.match(/CPUUsageNSec=(\d+)/);
        const memMatch = showOutput.match(/MemoryCurrent=(\d+)/);
        const timeMatch = showOutput.match(/ActiveEnterTimestamp=(.+)/);
        const tasksMatch = showOutput.match(/TasksCurrent=(\d+)/);
        
        if (cpuMatch) status.cpu = formatCPU(Number(cpuMatch[1]));
        if (memMatch) status.memory = formatMemory(Number(memMatch[1]));
        if (timeMatch) status.uptime = formatUptime(timeMatch[1]);
        if (tasksMatch) status.tasks = tasksMatch[1];
      } catch {
        // Metrics might not be available
      }
      
      services.push(status);
    }
  } catch (error) {
    console.warn("Failed to get Linux services:", error);
  }
  
  return services;
}

async function getMacOSServices(): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];
  
  try {
    const { launchdCommand } = await import("../macos/launchd.js");
    // For now, return empty array - would need to implement status in launchd.ts
  } catch (error) {
    console.warn("Failed to get macOS services:", error);
  }
  
  return services;
}

async function getWindowsServices(): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];
  
  try {
    const { windowsCommand } = await import("../windows/service.js");
    // For now, return empty array - would need to implement status in windows/service.ts
  } catch (error) {
    console.warn("Failed to get Windows services:", error);
  }
  
  return services;
}

function displayServices(services: ServiceStatus[]): void {
  // Header
  console.log(`${"SERVICE".padEnd(20)} ${"STATE".padEnd(12)} ${"CPU".padEnd(8)} ${"MEMORY".padEnd(10)} ${"UPTIME".padEnd(12)} ${"TASKS".padEnd(6)} DESCRIPTION`);
  console.log("-".repeat(90));
  
  for (const svc of services) {
    const state = `${svc.active}/${svc.sub}`;
    console.log(
      `${svc.name.padEnd(20)} ${state.padEnd(12)} ${(svc.cpu || "-").padEnd(8)} ${(svc.memory || "-").padEnd(10)} ${(svc.uptime || "-").padEnd(12)} ${(svc.tasks || "-").padEnd(6)} ${svc.description}`
    );
  }
  
  console.log("\n📊 SRE Metrics Summary:");
  const totalServices = services.length;
  const runningServices = services.filter(s => s.active === "active").length;
  const totalMemory = services.reduce((sum, s) => sum + (s.memory ? parseMemory(s.memory) : 0), 0);
  
  console.log(`  Services: ${runningServices}/${totalServices} running`);
  console.log(`  Memory: ${formatMemory(totalMemory)}`);
  console.log(`  Last updated: ${new Date().toISOString()}`);
}

function formatCPU(nsec: number): string {
  const ms = nsec / 1_000_000;
  return `${ms.toFixed(1)}ms`;
}

function formatMemory(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)}${units[unitIndex]}`;
}

function parseMemory(memStr: string): number {
  const match = memStr.match(/^([\d.]+)(B|KB|MB|GB)$/);
  if (!match) return 0;
  
  const [, value, unit] = match;
  const num = parseFloat(value);
  
  switch (unit) {
    case "KB": return num * 1024;
    case "MB": return num * 1024 * 1024;
    case "GB": return num * 1024 * 1024 * 1024;
    default: return num;
  }
}

function formatUptime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
