#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { MetricsStorage } from "../storage/metrics.js";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { generateCaddyConfig, generateNginxConfig } from "../utils/proxy-config.js";

interface ExportOptions {
  format?: string;
  hours?: string;
  output?: string;
  service?: string;
  domain?: string;
  port?: string;
  rateLimit?: string;
  ssl?: boolean;
}

function isContainedExportPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  const allowedRoots = [resolve(process.cwd()), resolve(homedir()), resolve(tmpdir())];
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(root + sep));
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const format = (options.format || 'json').toLowerCase();
  const hours = Number(options.hours) || 24;
  const serviceName = options.service;

  if (options.output && !isContainedExportPath(options.output)) {
    console.error(`❌ Security: Output path '${options.output}' must be inside workspace, home, or temp directory.`);
    process.exitCode = 1;
    return;
  }

  if (format === 'nginx' || format === 'caddy') {
    try {
      const targetService = serviceName || 'app';
      const basePort = options.port ? parseInt(options.port, 10) : 3000;
      const proxyOpts = {
        serviceName: targetService,
        domain: options.domain || 'localhost',
        upstreams: [{ host: '127.0.0.1', port: basePort }],
        rateLimitRps: options.rateLimit ? parseInt(options.rateLimit, 10) : 50,
        ssl: Boolean(options.ssl),
      };
      const config = format === 'nginx' ? generateNginxConfig(proxyOpts) : generateCaddyConfig(proxyOpts);
      if (options.output) {
        writeFileSync(resolve(options.output), config, 'utf-8');
        console.log(`✅ ${format.toUpperCase()} config exported to: ${options.output}`);
      } else {
        console.log(config);
      }
    } catch (error) {
      console.error(`❌ Failed to generate ${format} config: ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  const storage = new MetricsStorage();
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
    
    const outputFile = resolve(options.output || `bs9-metrics-${Date.now()}.${format}`);
    writeFileSync(outputFile, data);
    
    console.log(`✅ Metrics exported to: ${outputFile}`);
    console.log(`   Size: ${(data.length / 1024).toFixed(2)} KB`);
    console.log(`   Records: ${serviceName ? storage.getServiceMetrics(serviceName, hours).length : 'all services'}`);
    
  } catch (error) {
    console.error(`❌ Failed to export metrics: ${error}`);
    process.exitCode = 1;
    return;
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
