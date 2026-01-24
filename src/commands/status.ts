#!/usr/bin/env bun

import { execSync } from "node:child_process";
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
  const doStatus = () => {
    try {
      // Get all bsn-managed user services
      const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
      const lines = listOutput.split("\n").filter(line => line.includes(".service"));
      
      // Debug: show all lines
      // console.error("All service lines:", lines);
      
      const services: ServiceStatus[] = [];
      
      for (const line of lines) {
        // Skip empty lines
        if (!line.trim()) continue;
        
        // Try to match the line format - handle both ● and regular spaces
        const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
        if (!match) {
          continue;
        }
        
        const [, statusIndicator, name, loaded, active, sub, description] = match;
        
        // Only include services that look like BSN-managed (check for "Bun Service:" pattern)
        if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) {
          continue;
        }
        
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
          // Ignore metrics errors
        }
        
        services.push(status);
      }
      
      // Display table
      console.clear();
      console.log("🔍 BSN Service Status\n");
      
      if (services.length === 0) {
        console.log("No BSN-managed services running.");
        return;
      }
      
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
      
    } catch (err) {
      console.error(`❌ Failed to get status: ${err}`);
      process.exit(1);
    }
  };
  
  if (options.watch) {
    console.log("🔄 Watch mode (Ctrl+C to exit)\n");
    const interval = setInterval(doStatus, 2000);
    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\n👋 Exiting watch mode");
      process.exit(0);
    });
    doStatus();
  } else {
    doStatus();
  }
}

function formatCPU(nsec: number): string {
  const ms = nsec / 1_000_000;
  return `${ms.toFixed(1)}ms`;
}

function formatMemory(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(1)}${units[unit]}`;
}

function parseMemory(str: string): number {
  const match = str.match(/^([\d.]+)(B|KB|MB|GB)$/);
  if (!match) return 0;
  const [, value, unit] = match;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] || 1;
  return Number(value) * mult;
}

function formatUptime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  } catch {
    return "-";
  }
}
