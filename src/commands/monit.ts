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
import { setTimeout } from "node:timers/promises";

interface MonitOptions {
  refresh?: string;
}

interface ServiceMetrics {
  name: string;
  loaded: string;
  active: string;
  sub: string;
  state: string;
  cpu: string;
  memory: string;
  uptime: string;
  tasks: string;
  pid: string;
  description: string;
  health?: string;
  lastError?: string;
}

interface PreviousState {
  [key: string]: ServiceMetrics;
}

export async function monitCommand(options: MonitOptions): Promise<void> {
  const refreshInterval = Number(options.refresh) || 2;
  
  // Setup initial state
  let previousState: PreviousState = {};
  
  const getMetrics = (): ServiceMetrics[] => {
    try {
      const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
      const lines = listOutput.split("\n").filter(line => line.includes(".service"));
      
      const services: ServiceMetrics[] = [];
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
        if (!match) continue;
        
        const [, statusIndicator, name, loaded, active, sub, description] = match;
        
        if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;
        
        const service: ServiceMetrics = {
          name,
          loaded,
          active,
          sub,
          state: `${active}/${sub}`,
          description,
          cpu: '-',
          memory: '-',
          uptime: '-',
          tasks: '-',
          pid: '-',
        };
        
        // Get additional metrics
        try {
          // Query each property individually to avoid parsing issues
          const cpuOutput = execSync(`systemctl --user show ${name} -p CPUUsageNSec`, { encoding: "utf-8" });
          const memOutput = execSync(`systemctl --user show ${name} -p MemoryCurrent`, { encoding: "utf-8" });
          const timeOutput = execSync(`systemctl --user show ${name} -p ActiveEnterTimestamp`, { encoding: "utf-8" });
          const tasksOutput = execSync(`systemctl --user show ${name} -p TasksCurrent`, { encoding: "utf-8" });
          const pidOutput = execSync(`systemctl --user show ${name} -p MainPID`, { encoding: "utf-8" });
          const stateOutput = execSync(`systemctl --user show ${name} -p State`, { encoding: "utf-8" });
          
          const cpuMatch = cpuOutput.match(/CPUUsageNSec=(\d+)/);
          const memMatch = memOutput.match(/MemoryCurrent=(\d+)/);
          const timeMatch = timeOutput.match(/ActiveEnterTimestamp=(.+)/);
          const tasksMatch = tasksOutput.match(/TasksCurrent=(\d+)/);
          const pidMatch = pidOutput.match(/MainPID=(\d+)/);
          const stateMatch = stateOutput.match(/State=(.+)/);
          
          if (cpuMatch) {
            const cpuNs = Number(cpuMatch[1]);
            service.cpu = `${(cpuNs / 1000000).toFixed(1)}ms`;
          }
          if (memMatch) {
            const memValue = memMatch[1];
            if (memValue !== '[not set]' && memValue !== '') {
              const memBytes = Number(memValue);
              service.memory = formatMemory(memBytes);
            }
          }
          if (timeMatch) {
            service.uptime = formatUptime(timeMatch[1]);
          }
          if (tasksMatch) {
            const tasksValue = tasksMatch[1];
            if (tasksValue !== '[not set]' && tasksValue !== '') {
              service.tasks = tasksValue;
            }
          }
          if (pidMatch) {
            const pidValue = pidMatch[1];
            if (pidValue !== '0' && pidValue !== '[not set]' && pidValue !== '') {
              service.pid = pidValue;
            }
          }
          if (stateMatch) {
            service.state = stateMatch[1].trim();
          }
        } catch (error: any) {
          // Ignore metrics errors
        }
        
        // Check health endpoint
        try {
          let port: string | null = null;
          
          // First try to get port from description
          const portMatch = description.match(/port[=:]?\s*(\d+)/i);
          if (portMatch) {
            port = portMatch[1];
          } else {
            // If not in description, check environment variables
            const envOutput = execSync(`systemctl --user show ${name} -p Environment`, { encoding: "utf-8" });
            const envPortMatch = envOutput.match(/PORT=(\d+)/);
            if (envPortMatch) {
              port = envPortMatch[1];
            }
          }
          
          if (port) {
            const healthCheck = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/healthz`, { encoding: "utf-8", timeout: 1000 });
            service.health = healthCheck === "200" ? "✅ OK" : "❌ FAIL";
          } else {
            service.health = "⚠️  NO_PORT";
          }
        } catch {
          service.health = "⚠️  UNKNOWN";
        }
        
        services.push(service);
      }
      
      return services;
    } catch (error) {
      console.error('Error fetching metrics:', error);
      return [];
    }
  };

  const formatMemory = (bytes: number): string => {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${sizes[i]}`;
  };

  const formatUptime = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      
      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      }
      return `${minutes}m`;
    } catch {
      return '-';
    }
  };

  const renderDashboard = (services: ServiceMetrics[], isInitial: boolean = false) => {
    // Clear screen and move to top
    process.stdout.write('\x1b[2J\x1b[H');
    
    // Dark theme colors
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const dim = '\x1b[2m';
    const bgDark = '\x1b[48;5;236m';
    const textLight = '\x1b[38;5;15m';
    const textGreen = '\x1b[38;5;46m';
    const textRed = '\x1b[38;5;196m';
    const textYellow = '\x1b[38;5;226m';
    const textBlue = '\x1b[38;5;39m';
    const textCyan = '\x1b[38;5;51m';
    const textGray = '\x1b[38;5;245m';
    
    // Header with dark background
    console.log(`${bgDark}${textLight}${bold}╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗${reset}`);
    console.log(`${bgDark}${textLight}${bold}║${reset} ${textCyan}${bold}🔍 SYSTEM SERVICE MONITOR${reset} ${textGray}│${reset} ${textLight}Refresh: ${textCyan}${refreshInterval}s${reset} ${textGray}│${reset} ${textLight}Last: ${textCyan}${new Date().toLocaleTimeString()}${reset} ${textGray}│${reset} ${textLight}Services: ${textCyan}${services.length}${reset} ${bgDark}${textLight}${bold}║${reset}`);
    console.log(`${bgDark}${textLight}${bold}╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝${reset}`);
    console.log('');
    
    if (services.length === 0) {
      console.log(`${textGray}  No BS9-managed services running.${reset}`);
      return;
    }
    
    // Table header with modern styling
    console.log(`${textGray}┌──────────────────┬─────────────────┬──────────┬───────────┬───────────┬───────────┬───────┬───────┬─────────────────────────────────┐${reset}`);
    console.log(`${textGray}│${reset}${bold}${textBlue}SERVICE${reset}...........${textGray}│${reset}${bold}${textBlue}STATE${reset}............${textGray}│${reset}${bold}${textBlue}HEALTH${reset}....${textGray}│${reset}${bold}${textBlue}CPU${reset}........${textGray}│${reset}${bold}${textBlue}MEMORY${reset}.....${textGray}│${reset}${bold}${textBlue}UPTIME${reset}.....${textGray}│${reset}${bold}${textBlue}TASKS${reset}..${textGray}│${reset}${bold}${textBlue}PID${reset}....${textGray}│${reset}${bold}${textBlue}DESCRIPTION${reset}......................${textGray}│${reset}`);
    console.log(`${textGray}├──────────────────┼─────────────────┼──────────┼───────────┼───────────┼───────────┼───────┼───────┼─────────────────────────────────┤${reset}`);
    
    // Service rows
    for (const service of services) {
      const stateColor = service.active === 'active' ? textGreen : textRed;
      const stateIcon = service.active === 'active' ? '●' : '●';
      const state = `${stateColor}${bold}${stateIcon} ${service.sub}${reset}`;
      
      // Health status with icons
      let health = '';
      if (service.health === '✅ OK') {
        health = `${textGreen}✓ OK${reset}`;
      } else if (service.health === '❌ FAIL') {
        health = `${textRed}✗ FAIL${reset}`;
      } else if (service.health === '⚠️  UNKNOWN') {
        health = `${textYellow}⚠ UNKNOWN${reset}`;
      } else {
        health = `${textGray}? UNKNOWN${reset}`;
      }
      
      // CPU with color coding
      const cpuMs = parseFloat(service.cpu);
      const cpuColor = cpuMs > 20000 ? textRed : cpuMs > 10000 ? textYellow : textGreen;
      const cpu = `${cpuColor}${service.cpu}${reset}`;
      
      // Memory with color coding
      const memColor = service.memory !== '-' && parseFloat(service.memory) > 50 ? textYellow : textLight;
      const memory = `${memColor}${service.memory.padEnd(8)}${reset}`;
      
      // Uptime styling
      const uptime = service.uptime !== '-' ? `${textCyan}${service.uptime}${reset}` : `${textGray}-${reset}`;
      
      // Tasks and PID
      const tasks = service.tasks !== '-' ? `${textLight}${service.tasks}${reset}` : `${textGray}-${reset}`;
      const pid = service.pid !== '-' ? `${textLight}${service.pid}${reset}` : `${textGray}-${reset}`;
      
      // Service name in bold
      const serviceName = `${bold}${textLight}${service.name}${reset}`;
      
      // Description in dim gray
      const description = service.description ? `${dim}${service.description}${reset}` : '';
      
      // Remove color codes temporarily to see pure alignment
      const plainServiceName = service.name;
      const plainState = `${stateIcon} ${service.sub}`;
      const plainHealth = service.health === '✅ OK' ? '✓ OK' : service.health === '❌ FAIL' ? '✗ FAIL' : service.health === '⚠️  UNKNOWN' ? '⚠ UNKNOWN' : service.health || '-';
      const plainCpu = service.cpu;
      const plainMemory = service.memory;
      const plainUptime = service.uptime;
      const plainTasks = service.tasks;
      const plainPid = service.pid;
      const plainDescription = service.description || '';
      
      console.log(`${textGray}│${reset}${plainServiceName.padEnd(18, '.')}${textGray}│${reset}${plainState.padEnd(17, '.')}${textGray}│${reset}${plainHealth.padEnd(10, '.')}${textGray}│${reset}${plainCpu.padEnd(11, '.')}${textGray}│${reset}${plainMemory.padEnd(11, '.')}${textGray}│${reset}${plainUptime.padEnd(11, '.')}${textGray}│${reset}${plainTasks.padEnd(7, '.')}${textGray}│${reset}${plainPid.padEnd(7, '.')}${textGray}│${reset}${plainDescription.padEnd(33, '.')}${textGray}│${reset}`);
    }
    
    console.log(`${textGray}└──────────────────┴─────────────────┴──────────┴───────────┴───────────┴───────────┴───────┴───────┴─────────────────────────────────┘${reset}`);
    
    // Summary section with modern styling
    console.log('');
    console.log(`${bgDark}${textLight}${bold}╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗${reset}`);
    
    const running = services.filter(s => s.active === 'active').length;
    const totalMemory = services.reduce((sum, s) => {
      if (s.memory !== '-') {
        const match = s.memory.match(/([\d.]+)(B|KB|MB|GB)/);
        if (match) {
          const [, value, unit] = match;
          const bytes = Number(value) * Math.pow(1024, ['B', 'KB', 'MB', 'GB'].indexOf(unit));
          return sum + bytes;
        }
      }
      return sum;
    }, 0);
    
    console.log(`${bgDark}${textLight}${bold}║${reset} ${textCyan}📊 SUMMARY:${reset} ${textGreen}● ${running}/${services.length} services running${reset} ${textGray}│${reset} ${textCyan}💾 Total Memory:${reset} ${textYellow}${formatMemory(totalMemory)}${reset} ${bgDark}${textLight}${bold}║${reset}`);
    
    // Alerts section
    const failed = services.filter(s => s.active !== 'active');
    const unhealthy = services.filter(s => s.health === '❌ FAIL');
    
    if (failed.length > 0 || unhealthy.length > 0) {
      console.log(`${bgDark}${textLight}${bold}║${reset} ${textRed}⚠️  ALERTS:${reset}`);
      if (failed.length > 0) {
        console.log(`${bgDark}${textLight}${bold}║${reset}   ${textRed}Failed services:${reset} ${textRed}${failed.map(s => s.name).join(', ')}${reset}`);
      }
      if (unhealthy.length > 0) {
        console.log(`${bgDark}${textLight}${bold}║${reset}   ${textRed}Unhealthy services:${reset} ${textRed}${unhealthy.map(s => s.name).join(', ')}${reset}`);
      }
    }
    
    console.log(`${bgDark}${textLight}${bold}╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝${reset}`);
  };

  // Setup refresh loop with change detection
  const refresh = async () => {
    try {
      while (true) {
        await setTimeout(refreshInterval * 1000);
        const currentServices = getMetrics();
        
        // Check if anything changed (exclude CPU from comparison as it always changes)
        let hasChanges = false;
        for (const service of currentServices) {
          const prev = previousState[service.name];
          if (!prev || 
              prev.active !== service.active ||
              prev.sub !== service.sub ||
              prev.memory !== service.memory ||
              prev.uptime !== service.uptime ||
              prev.health !== service.health) {
            hasChanges = true;
            break;
          }
        }
        
        // Update previous state
        previousState = {};
        for (const service of currentServices) {
          previousState[service.name] = { ...service };
        }
        
        // Always re-render to show updated timestamp
        renderDashboard(currentServices, false);
      }
    } catch (error) {
      console.error('Monitoring error:', error);
      process.exit(1);
    }
  };
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n👋 Monitoring stopped');
    process.exit(0);
  });

  // Initial render
  renderDashboard(getMetrics(), true);
  
  // Start refresh loop
  await refresh();
}