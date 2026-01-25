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
import { readFileSync } from "node:fs";
import { parseServiceArray, getMultipleServiceInfo } from "../utils/array-parser.js";

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
  pid?: string;
  port?: string;
  exitCode?: string;
  lastRestart?: string;
}

export async function statusCommand(options: StatusOptions, names?: string[]): Promise<void> {
  const platformInfo = getPlatformInfo();
  
  // Handle multiple arguments
  const name = names && names.length > 0 ? names.join(' ') : undefined;
  
  // Handle multi-service status
  if (name && (name.includes('[') || name === 'all')) {
    await handleMultiServiceStatus(name, options);
    return;
  }
  
  // Single service or all services status (existing logic)
  await handleStatus(options, name);
}

async function handleMultiServiceStatus(name: string, options: StatusOptions): Promise<void> {
  const services = await parseServiceArray(name);
  
  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }
  
  console.log(`📊 Multi-Service Status: ${name}`);
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
      console.log(`📊 Multi-Service Status: ${name}`);
      console.log("=".repeat(80));
      
      const updatedServiceInfo = await getMultipleServiceInfo(services);
      displayMultiServiceStatus(updatedServiceInfo, name);
    }, 2000);
  }
}

async function handleStatus(options: StatusOptions, name?: string): Promise<void> {
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
        
        let updatedServices: ServiceStatus[] = [];
        if (platformInfo.isLinux) {
          updatedServices = await getLinuxServices();
        } else if (platformInfo.isMacOS) {
          updatedServices = await getMacOSServices();
        } else if (platformInfo.isWindows) {
          updatedServices = await getWindowsServices();
        }
        
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

function displayServices(services: ServiceStatus[]): void {
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
    } else if (svc.active === "activating" && svc.sub.includes("auto-restart")) {
      statusIndicator = "🔄";
      status = "restarting";
    } else if (svc.active === "failed" || svc.sub === "failed") {
      statusIndicator = "❌";
      status = "failed";
    } else if (svc.active === "inactive") {
      statusIndicator = "⏸️";
      status = "stopped";
    } else {
      statusIndicator = "⚠️";
    }

    const displayStatus = `${statusIndicator} ${status}`;
    
    // Format memory and uptime better
    const formattedMemory = svc.memory ? formatMemory(parseMemory(svc.memory)) : "-";
    const formattedUptime = svc.uptime || "-";
    const formattedCPU = svc.cpu || "-";
    
    console.log(
      `${svc.name.padEnd(18)} ${displayStatus.padEnd(15)} ${formattedCPU.padEnd(10)} ${formattedMemory.padEnd(12)} ${formattedUptime.padEnd(12)} ${(svc.tasks || "-").padEnd(8)} ${svc.description}`
    );
  }
  
  // Enhanced summary with better formatting
  console.log("\n📊 Service Summary:");
  const totalServices = services.length;
  const runningServices = services.filter(s => s.active === "active" && s.sub === "running").length;
  const failedServices = services.filter(s => s.active === "failed" || s.sub === "failed").length;
  const restartingServices = services.filter(s => s.active === "activating" && s.sub.includes("auto-restart")).length;
  const totalMemory = services.reduce((sum, s) => sum + (s.memory ? parseMemory(s.memory) : 0), 0);
  
  console.log(`  📈 Status: ${runningServices} running, ${failedServices} failed, ${restartingServices} restarting`);
  console.log(`  📦 Total: ${runningServices}/${totalServices} services running`);
  console.log(`  💾 Memory: ${formatMemory(totalMemory)}`);
  console.log(`  🕒 Last updated: ${new Date().toLocaleString()}`);

  // Show failed services details with better formatting
  if (failedServices > 0) {
    console.log("\n🚨 Failed Services:");
    console.log("-".repeat(80));
    
    services.filter(s => s.active === "failed" || s.sub === "failed").forEach(svc => {
      console.log(`  ❌ ${svc.name} - ${svc.description}`);
    });
  }
}

function displayMultiServiceStatus(serviceInfo: any[], pattern: string): void {
  const running = serviceInfo.filter(s => s.status === 'active');
  const failed = serviceInfo.filter(s => s.status === 'failed');
  const inactive = serviceInfo.filter(s => s.status === 'inactive');
  
  console.log(`\n📊 Services matching pattern: ${pattern}`);
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

async function getLinuxServices(): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];
  const platformInfo = getPlatformInfo();
  
  try {
    const listOutput = execSync("systemctl --user list-units --type=service --all --no-pager --no-legend", { encoding: "utf-8" });
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
      
      // Get additional metrics with better error handling
      try {
        // Get comprehensive service information
        const showOutput = execSync(`systemctl --user show ${name} --property=CPUUsageNSec --property=MemoryCurrent --property=ActiveEnterTimestamp --property=MainPID --property=TasksCurrent`, { encoding: "utf-8" });
        
        // Extract CPU usage (nanoseconds to milliseconds)
        const cpuMatch = showOutput.match(/CPUUsageNSec=(\d+)/);
        if (cpuMatch) {
          const cpuNsec = Number(cpuMatch[1]);
          status.cpu = formatCPU(cpuNsec);
        }
        
        // Extract memory usage (bytes to human readable)
        const memMatch = showOutput.match(/MemoryCurrent=(\d+)/);
        if (memMatch) {
          const memoryBytes = Number(memMatch[1]);
          status.memory = formatMemory(memoryBytes);
        }
        
        // Extract startup time and calculate uptime
        const timeMatch = showOutput.match(/ActiveEnterTimestamp=(.+)/);
        if (timeMatch) {
          status.uptime = formatUptime(timeMatch[1]);
        }
        
        // Extract task count
        const tasksMatch = showOutput.match(/TasksCurrent=(\d+)/);
        if (tasksMatch) {
          status.tasks = tasksMatch[1];
        }
        
        // Get process ID for additional info
        const pidMatch = showOutput.match(/MainPID=(\d+)/);
        if (pidMatch && pidMatch[1] !== "0") {
          status.pid = pidMatch[1];
        }
        
        // Extract port from service file if available
        const serviceFile = join(platformInfo.serviceDir, `${name}.service`);
        if (require('node:fs').existsSync(serviceFile)) {
          const serviceContent = require('node:fs').readFileSync(serviceFile, 'utf8');
          const portMatch = serviceContent.match(/Environment=PORT=(\d+)/);
          if (portMatch) {
            status.port = portMatch[1];
          }
        }
        
        // Extract exit code if available
        const exitCodeMatch = showOutput.match(/Result=(\d+)/);
        if (exitCodeMatch) {
          status.exitCode = exitCodeMatch[1];
        }
        
        // Extract last restart time if available
        const restartMatch = showOutput.match(/Result=since=(.+)/);
        if (restartMatch) {
          status.lastRestart = restartMatch[1];
        }
        
        // Also try to get additional properties that might be available
        const cpuMatchAlt = showOutput.match(/CPUUsageNSec=(\d+)/);
        const memMatchAlt = showOutput.match(/MemoryCurrent=(\d+)/);
        if (!status.cpu && cpuMatchAlt) {
          status.cpu = formatCPU(Number(cpuMatchAlt[1]));
        }
        if (!status.memory && memMatchAlt) {
          status.memory = formatMemory(Number(memMatchAlt[1]));
        }
        
      } catch (metricsError: any) {
        // If metrics fail, at least we have basic status
        console.warn(`⚠️  Could not get metrics for ${name}: ${metricsError?.message || metricsError}`);
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
