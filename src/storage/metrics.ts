#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface MetricSnapshot {
  timestamp: number;
  services: ServiceMetric[];
}

interface ServiceMetric {
  name: string;
  cpu: string;
  memory: number; // in bytes
  uptime: string;
  tasks: number;
  health: 'healthy' | 'unhealthy' | 'unknown';
  state: string;
}

class MetricsStorage {
  private storageDir: string;
  private maxSnapshots: number = 1000; // Keep last 1000 snapshots
  
  constructor() {
    this.storageDir = join(homedir(), ".config", "bs9", "metrics");
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }
  
  storeSnapshot(services: ServiceMetric[]): void {
    const snapshot: MetricSnapshot = {
      timestamp: Date.now(),
      services,
    };
    
    const filename = `metrics-${snapshot.timestamp}.json`;
    const filepath = join(this.storageDir, filename);
    
    try {
      writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
      
      // Cleanup old snapshots
      this.cleanupOldSnapshots();
    } catch (error) {
      console.error('Failed to store metrics snapshot:', error);
    }
  }
  
  getHistoricalData(hours: number = 24): MetricSnapshot[] {
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    const snapshots: MetricSnapshot[] = [];
    
    try {
      const files = this.getMetricFiles();
      
      for (const file of files) {
        const filepath = join(this.storageDir, file);
        const content = readFileSync(filepath, 'utf-8');
        const snapshot: MetricSnapshot = JSON.parse(content);
        
        if (snapshot.timestamp >= cutoffTime) {
          snapshots.push(snapshot);
        }
      }
    } catch (error) {
      console.error('Failed to read historical data:', error);
    }
    
    return snapshots.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  getServiceMetrics(serviceName: string, hours: number = 24): ServiceMetric[] {
    const snapshots = this.getHistoricalData(hours);
    const metrics: ServiceMetric[] = [];
    
    for (const snapshot of snapshots) {
      const serviceMetric = snapshot.services.find(s => s.name === serviceName);
      if (serviceMetric) {
        metrics.push(serviceMetric);
      }
    }
    
    return metrics;
  }
  
  getAggregatedMetrics(hours: number = 24): {
    avgCpu: number;
    avgMemory: number;
    uptime: number;
    totalRequests: number;
    errorRate: number;
  } {
    const snapshots = this.getHistoricalData(hours);
    
    if (snapshots.length === 0) {
      return {
        avgCpu: 0,
        avgMemory: 0,
        uptime: 0,
        totalRequests: 0,
        errorRate: 0,
      };
    }
    
    let totalCpu = 0;
    let totalMemory = 0;
    let healthyCount = 0;
    let totalCount = 0;
    
    for (const snapshot of snapshots) {
      for (const service of snapshot.services) {
        // Parse CPU from string like "12.3ms" to number
        const cpuMatch = service.cpu.match(/([\d.]+)ms/);
        if (cpuMatch) {
          totalCpu += parseFloat(cpuMatch[1]);
        }
        
        totalMemory += service.memory;
        totalCount++;
        
        if (service.health === 'healthy') {
          healthyCount++;
        }
      }
    }
    
    return {
      avgCpu: totalCpu / (snapshots.length * Math.max(1, snapshots[0]?.services.length || 1)),
      avgMemory: totalMemory / Math.max(1, snapshots.length * Math.max(1, snapshots[0]?.services.length || 1)),
      uptime: (healthyCount / Math.max(1, totalCount)) * 100,
      totalRequests: totalCount,
      errorRate: ((totalCount - healthyCount) / Math.max(1, totalCount)) * 100,
    };
  }
  
  private getMetricFiles(): string[] {
    try {
      const { readdirSync } = require("node:fs");
      const files = readdirSync(this.storageDir);
      return files
        .filter((file: string) => file.startsWith('metrics-') && file.endsWith('.json'))
        .sort((a: string, b: string) => {
          const timeA = parseInt(a.split('-')[1].split('.')[0]);
          const timeB = parseInt(b.split('-')[1].split('.')[0]);
          return timeB - timeA;
        });
    } catch (error) {
      return [];
    }
  }
  
  private cleanupOldSnapshots(): void {
    const files = this.getMetricFiles();
    
    if (files.length > this.maxSnapshots) {
      const filesToDelete = files.slice(this.maxSnapshots);
      
      for (const file of filesToDelete) {
        try {
          const { unlinkSync } = require("node:fs");
          unlinkSync(join(this.storageDir, file));
        } catch (error) {
          console.error(`Failed to delete old metrics file ${file}:`, error);
        }
      }
    }
  }
  
  exportData(format: 'json' | 'csv' = 'json'): string {
    const snapshots = this.getHistoricalData(24 * 7); // Last week
    
    if (format === 'csv') {
      const headers = ['timestamp', 'service_name', 'cpu_ms', 'memory_bytes', 'uptime', 'tasks', 'health', 'state'];
      const rows = [headers.join(',')];
      
      for (const snapshot of snapshots) {
        for (const service of snapshot.services) {
          const cpuMatch = service.cpu.match(/([\d.]+)ms/);
          const cpuMs = cpuMatch ? cpuMatch[1] : '0';
          
          rows.push([
            new Date(snapshot.timestamp).toISOString(),
            service.name,
            cpuMs,
            service.memory.toString(),
            service.uptime,
            service.tasks.toString(),
            service.health,
            service.state,
          ].join(','));
        }
      }
      
      return rows.join('\n');
    }
    
    return JSON.stringify(snapshots, null, 2);
  }
}

export { MetricsStorage, ServiceMetric, MetricSnapshot };
