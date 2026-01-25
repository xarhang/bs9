#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { MetricsStorage } from "../storage/metrics.js";
import { writeFileSync } from "node:fs";

interface ExportOptions {
  format?: string;
  hours?: string;
  output?: string;
  service?: string;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const storage = new MetricsStorage();
  const format = options.format || 'json';
  const hours = Number(options.hours) || 24;
  const serviceName = options.service;
  
  console.log(`📊 Exporting BS9 metrics (${format.toUpperCase()} format)`);
  
  try {
    let data: string;
    
    if (serviceName) {
      // Export specific service metrics
      const serviceMetrics = storage.getServiceMetrics(serviceName, hours);
      data = format === 'csv' ? serviceMetricsToCsv(serviceMetrics, serviceName) : JSON.stringify(serviceMetrics, null, 2);
      console.log(`📈 Exporting metrics for service: ${serviceName}`);
    } else {
      // Export all metrics
      data = storage.exportData(format as 'json' | 'csv');
      console.log(`📈 Exporting all metrics for last ${hours} hours`);
    }
    
    const outputFile = options.output || `bs9-metrics-${Date.now()}.${format}`;
    writeFileSync(outputFile, data);
    
    console.log(`✅ Metrics exported to: ${outputFile}`);
    console.log(`   Size: ${(data.length / 1024).toFixed(2)} KB`);
    console.log(`   Records: ${serviceName ? storage.getServiceMetrics(serviceName, hours).length : 'all services'}`);
    
  } catch (error) {
    console.error(`❌ Failed to export metrics: ${error}`);
    process.exit(1);
  }
}

function serviceMetricsToCsv(metrics: any[], serviceName: string): string {
  const headers = ['timestamp', 'service_name', 'cpu_ms', 'memory_bytes', 'uptime', 'tasks', 'health', 'state'];
  const rows = [headers.join(',')];
  
  for (const metric of metrics) {
    const cpuMatch = metric.cpu.match(/([\d.]+)ms/);
    const cpuMs = cpuMatch ? cpuMatch[1] : '0';
    
    rows.push([
      new Date().toISOString(),
      serviceName,
      cpuMs,
      metric.memory.toString(),
      metric.uptime,
      metric.tasks.toString(),
      metric.health,
      metric.state,
    ].join(','));
  }
  
  return rows.join('\n');
}
