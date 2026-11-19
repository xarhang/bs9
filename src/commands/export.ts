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
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { generateCaddyConfig, generateNginxConfig } from "../utils/proxy-config.js";
import { generateGrafanaDashboard } from "../utils/grafana-export.js";

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

const ALLOWED_EXPORT_FORMATS = new Set(['json', 'csv', 'grafana', 'nginx', 'caddy']);

function isContainedExportPath(filePath: string): boolean {
  try {
    const resolved = resolve(filePath);
    const allowedRoots = [process.cwd(), homedir(), tmpdir()].map((r) =>
      existsSync(r) ? realpathSync(r) : resolve(r)
    );
    if (existsSync(resolved)) {
      if (lstatSync(resolved).isSymbolicLink()) return false;
      const real = realpathSync(resolved);
      return allowedRoots.some((root) => real === root || real.startsWith(root + sep));
    }
    const parent = dirname(resolved);
    const realParent = existsSync(parent) ? realpathSync(parent) : resolve(parent);
    return allowedRoots.some((root) => realParent === root || realParent.startsWith(root + sep));
  } catch {
    return false;
  }
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const format = (options.format || 'json').toLowerCase();
  if (!ALLOWED_EXPORT_FORMATS.has(format)) {
    console.error(`❌ Unsupported export format '${format}'. Use json, csv, grafana, nginx, or caddy.`);
    process.exitCode = 1;
    return;
  }
  const rawHours = Number(options.hours);
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.floor(rawHours) : 24;
  const serviceName = options.service;

  if (options.output && !isContainedExportPath(options.output)) {
    console.error(`❌ Security: Output path '${options.output}' must be inside workspace, home, or temp directory.`);
    process.exitCode = 1;
    return;
  }

  if (format === 'grafana') {
    const json = generateGrafanaDashboard({ serviceName });
    if (options.output) {
      writeFileSync(resolve(options.output), json, 'utf-8');
      console.log(`✅ Grafana dashboard exported to: ${options.output}`);
    } else {
      console.log(json);
    }
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
    let recordCount: number | string = 'all services';
    
    if (serviceName) {
      // Export specific service metrics
      const serviceMetrics = storage.getServiceMetrics(serviceName, hours);
      recordCount = serviceMetrics.length;
      data = format === 'csv' ? serviceMetricsToCsv(serviceMetrics, serviceName) : JSON.stringify(serviceMetrics, null, 2);
      console.log(`📈 Exporting metrics for service: ${serviceName}`);
    } else {
      // Export all metrics
      data = storage.exportData(format as 'json' | 'csv', hours);
      console.log(`📈 Exporting all metrics for last ${hours} hours`);
    }
    
    const outputFile = resolve(options.output || `bs9-metrics-${Date.now()}.${format}`);
    writeFileSync(outputFile, data);
    
    console.log(`✅ Metrics exported to: ${outputFile}`);
    console.log(`   Size: ${(data.length / 1024).toFixed(2)} KB`);
    console.log(`   Records: ${recordCount}`);
    
  } catch (error) {
    console.error(`❌ Failed to export metrics: ${error}`);
    process.exitCode = 1;
    return;
  }
}

function escapeCsvCell(val: unknown): string {
  let str = String(val ?? "");
  // Prevent CSV formula injection in spreadsheet applications
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function serviceMetricsToCsv(metrics: any[], serviceName: string): string {
  const headers = ['timestamp', 'service_name', 'cpu_ms', 'memory_bytes', 'uptime', 'tasks', 'health', 'state'];
  const rows = [headers.join(',')];
  
  for (const metric of metrics) {
    const cpuStr = typeof metric?.cpu === 'string' ? metric.cpu : '';
    const cpuMatch = cpuStr.match(/([\d.]+)ms/);
    const cpuMs = cpuMatch ? cpuMatch[1] : '0';
    
    rows.push([
      new Date().toISOString(),
      serviceName,
      cpuMs,
      metric?.memory ?? 0,
      metric?.uptime ?? '',
      metric?.tasks ?? 0,
      metric?.health ?? '',
      metric?.state ?? '',
    ].map(escapeCsvCell).join(','));
  }
  
  return rows.join('\n');
}
