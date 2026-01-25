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
  description: string;
  health?: string;
  lastError?: string;
}

export async function monitCommand(options: MonitOptions): Promise<void> {
  const refreshInterval = Number(options.refresh) || 2;
  
  // Clear screen and setup
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('🔍 BS9 Real-time Monitoring Dashboard');
  console.log('='.repeat(80));
  console.log(`Refresh: ${refreshInterval}s | Press Ctrl+C to exit`);
  console.log('');

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
        };
        
        // Get additional metrics
        try {
          const showOutput = execSync(`systemctl --user show ${name} -p CPUUsageNSec MemoryCurrent ActiveEnterTimestamp TasksCurrent State`, { encoding: "utf-8" });
          const cpuMatch = showOutput.match(/CPUUsageNSec=(\d+)/);
          const memMatch = showOutput.match(/MemoryCurrent=(\d+)/);
          const timeMatch = showOutput.match(/ActiveEnterTimestamp=(.+)/);
          const tasksMatch = showOutput.match(/TasksCurrent=(\d+)/);
          const stateMatch = showOutput.match(/State=(.+)/);
          
          if (cpuMatch) {
            const cpuNs = Number(cpuMatch[1]);
            service.cpu = `${(cpuNs / 1000000).toFixed(1)}ms`;
          }
          if (memMatch) {
            const memBytes = Number(memMatch[1]);
            service.memory = formatMemory(memBytes);
          }
          if (timeMatch) {
            service.uptime = formatUptime(timeMatch[1]);
          }
          if (tasksMatch) {
            service.tasks = tasksMatch[1];
          }
          if (stateMatch) {
            service.state = stateMatch[1].trim();
          }
        } catch {
          // Ignore metrics errors
        }
        
        // Check health endpoint
        try {
          const portMatch = description.match(/port[=:]?\s*(\d+)/i);
          if (portMatch) {
            const port = portMatch[1];
            const healthCheck = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/healthz`, { encoding: "utf-8", timeout: 1000 });
            service.health = healthCheck === "200" ? "✅ OK" : "❌ FAIL";
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

  const renderDashboard = () => {
    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');
    
    // Header
    console.log('🔍 BS9 Real-time Monitoring Dashboard');
    console.log('='.repeat(120));
    console.log(`Refresh: ${refreshInterval}s | Last update: ${new Date().toLocaleTimeString()} | Press Ctrl+C to exit`);
    console.log('');
    
    const services = getMetrics();
    
    if (services.length === 0) {
      console.log('No BS9-managed services running.');
      return;
    }
    
    // Table header
    console.log('SERVICE'.padEnd(20) + 
                'STATE'.padEnd(15) + 
                'HEALTH'.padEnd(10) + 
                'CPU'.padEnd(10) + 
                'MEMORY'.padEnd(12) + 
                'UPTIME'.padEnd(12) + 
                'TASKS'.padEnd(8) + 
                'DESCRIPTION');
    console.log('-'.repeat(120));
    
    // Service rows
    for (const service of services) {
      const stateColor = service.active === 'active' ? '\x1b[32m' : '\x1b[31m';
      const resetColor = '\x1b[0m';
      
      const state = `${stateColor}${service.sub}${resetColor}`;
      const health = service.health || '-';
      
      console.log(
        service.name.padEnd(20) +
        state.padEnd(15) +
        health.padEnd(10) +
        service.cpu.padEnd(10) +
        service.memory.padEnd(12) +
        service.uptime.padEnd(12) +
        service.tasks.padEnd(8) +
        service.description
      );
    }
    
    // Summary
    console.log('');
    console.log('='.repeat(120));
    
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
    
    console.log(`📊 Summary: ${running}/${services.length} services running | Total Memory: ${formatMemory(totalMemory)} | Services: ${services.length}`);
    
    // Alerts
    const failed = services.filter(s => s.active !== 'active');
    const unhealthy = services.filter(s => s.health === '❌ FAIL');
    
    if (failed.length > 0 || unhealthy.length > 0) {
      console.log('');
      console.log('⚠️  ALERTS:');
      if (failed.length > 0) {
        console.log(`   Failed services: ${failed.map(s => s.name).join(', ')}`);
      }
      if (unhealthy.length > 0) {
        console.log(`   Unhealthy services: ${unhealthy.map(s => s.name).join(', ')}`);
      }
    }
  };

  // Initial render
  renderDashboard();
  
  // Setup refresh loop
  const refresh = async () => {
    while (true) {
      await setTimeout(refreshInterval * 1000);
      renderDashboard();
    }
  };
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n👋 Monitoring stopped');
    process.exit(0);
  });
  
  // Start monitoring
  refresh().catch(error => {
    console.error('Monitoring error:', error);
    process.exit(1);
  });
}
