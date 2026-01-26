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
import { listServices } from "../utils/service-discovery.js";

interface ProfileOptions {
  duration?: string;
  output?: string;
  service?: string;
  interval?: string;
}

interface ProfileData {
  timestamp: number;
  cpu: number;
  memory: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  eventLoopLag: number;
  activeHandles: number;
  activeRequests: number;
}

interface PerformanceProfile {
  serviceName: string;
  duration: number;
  interval: number;
  samples: ProfileData[];
  summary: {
    avgCpu: number;
    maxCpu: number;
    avgMemory: number;
    maxMemory: number;
    avgHeapUsed: number;
    maxHeapUsed: number;
    avgEventLoopLag: number;
    maxEventLoopLag: number;
  };
}

export async function profileCommand(options: ProfileOptions): Promise<void> {
  const duration = Number(options.duration) || 60; // Default 60 seconds
  const interval = Number(options.interval) || 1000; // Default 1 second
  const serviceName = options.service;

  if (!serviceName) {
    console.error('❌ Service name is required. Use --service <name>');
    process.exit(1);
  }

  console.log(`📊 Performance Profiling for Service: ${serviceName}`);
  console.log(`⏱️  Duration: ${duration}s | Interval: ${interval}ms`);
  console.log('='.repeat(80));

  try {
    // Check if service is running
    const serviceStatus = await checkServiceStatus(serviceName);
    if (serviceStatus !== 'active') {
      console.error(`❌ Service '${serviceName}' is not running (status: ${serviceStatus})`);
      process.exit(1);
    }

    // Get service port for metrics
    const port = getServicePort(serviceName);
    if (!port) {
      console.error(`❌ Could not determine port for service '${serviceName}'`);
      process.exit(1);
    }

    console.log(`🔍 Collecting metrics from http://localhost:${port}/metrics`);
    console.log('Press Ctrl+C to stop profiling early\n');

    const profile = await collectPerformanceData(serviceName, port, duration, interval);

    // Display results
    displayProfileResults(profile);

    // Save to file if requested
    if (options.output) {
      await saveProfileData(profile, options.output);
      console.log(`💾 Profile data saved to: ${options.output}`);
    }

  } catch (error) {
    console.error(`❌ Failed to profile service: ${error}`);
    process.exit(1);
  }
}

async function checkServiceStatus(serviceName: string): Promise<string> {
  try {
    const services = await listServices();
    const service = services.find(s => s.name === serviceName);

    if (service) {
      return service.active === 'active' ? 'active' : service.active;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getServicePort(serviceName: string): number | null {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const platform = os.platform();
  const userHome = os.homedir();

  try {
    let serviceContent = '';

    if (platform === 'win32') {
      // Windows: Read from BS9 service config
      const configPath = path.join(userHome, '.bs9', 'services', `${serviceName}.json`);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return config.port || 3000;
      }
      // Fallback: Try to read from backup
      const backupPath = path.join(userHome, '.bs9', 'backups', `${serviceName}.json`);
      if (fs.existsSync(backupPath)) {
        const config = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
        return config.port || 3000;
      }
      return 3000; // Default port
    } else if (platform === 'darwin') {
      // macOS: Read from launchd plist
      const plistPath = path.join(userHome, 'Library', 'LaunchAgents', `${serviceName}.plist`);
      serviceContent = fs.readFileSync(plistPath, 'utf-8');
    } else {
      // Linux: Read from systemd service
      const servicePath = path.join(userHome, '.config', 'systemd', 'user', `${serviceName}.service`);
      serviceContent = fs.readFileSync(servicePath, 'utf-8');
    }

    // Extract port from environment variables
    const portMatch = serviceContent.match(/PORT[=:]?\s*(\d+)/i);
    if (portMatch) {
      return Number(portMatch[1]);
    }

    // Extract port from description
    const descMatch = serviceContent.match(/port[=:]?\s*(\d+)/i);
    if (descMatch) {
      return Number(descMatch[1]);
    }

    return 3000; // Default port
  } catch {
    return 3000; // Default port on error
  }
}

async function collectPerformanceData(
  serviceName: string,
  port: number,
  duration: number,
  interval: number
): Promise<PerformanceProfile> {
  const samples: ProfileData[] = [];
  const startTime = Date.now();
  const endTime = startTime + (duration * 1000);

  while (Date.now() < endTime) {
    try {
      const sample = await collectSample(port);
      samples.push(sample);

      // Show progress
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const progress = Math.round((elapsed / duration) * 100);
      process.stdout.write(`\r⏳ Progress: ${elapsed}s/${duration}s (${progress}%) | Samples: ${samples.length}`);

      await setTimeout(interval);
    } catch (error) {
      console.error(`\n⚠️  Failed to collect sample: ${error}`);
      break;
    }
  }

  console.log('\n'); // New line after progress

  // Calculate summary
  const summary = calculateSummary(samples);

  return {
    serviceName,
    duration,
    interval,
    samples,
    summary,
  };
}

async function collectSample(port: number): Promise<ProfileData> {
  const response = await fetch(`http://localhost:${port}/metrics`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const metricsText = await response.text();
  const metrics = parsePrometheusMetrics(metricsText);

  return {
    timestamp: Date.now(),
    cpu: metrics.cpu || 0,
    memory: metrics.memory || 0,
    heapUsed: metrics.heapUsed || 0,
    heapTotal: metrics.heapTotal || 0,
    external: metrics.external || 0,
    eventLoopLag: metrics.eventLoopLag || 0,
    activeHandles: metrics.activeHandles || 0,
    activeRequests: metrics.activeRequests || 0,
  };
}

function parsePrometheusMetrics(metricsText: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  const lines = metricsText.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;

    const match = line.match(/^(.+)\s+([\d.]+)$/);
    if (!match) continue;

    const [, name, value] = match;

    // Map Prometheus metrics to our internal names
    switch (name) {
      case 'process_cpu_seconds_total':
        metrics.cpu = parseFloat(value);
        break;
      case 'process_resident_memory_bytes':
        metrics.memory = parseFloat(value);
        break;
      case 'nodejs_heap_size_used_bytes':
        metrics.heapUsed = parseFloat(value);
        break;
      case 'nodejs_heap_size_total_bytes':
        metrics.heapTotal = parseFloat(value);
        break;
      case 'nodejs_external_memory_bytes':
        metrics.external = parseFloat(value);
        break;
      case 'nodejs_eventloop_lag_seconds':
        metrics.eventLoopLag = parseFloat(value) * 1000; // Convert to ms
        break;
      case 'nodejs_active_handles_total':
        metrics.activeHandles = parseFloat(value);
        break;
      case 'nodejs_active_requests_total':
        metrics.activeRequests = parseFloat(value);
        break;
    }
  }

  return metrics;
}

function calculateSummary(samples: ProfileData[]): PerformanceProfile['summary'] {
  if (samples.length === 0) {
    return {
      avgCpu: 0, maxCpu: 0,
      avgMemory: 0, maxMemory: 0,
      avgHeapUsed: 0, maxHeapUsed: 0,
      avgEventLoopLag: 0, maxEventLoopLag: 0,
    };
  }

  const sum = samples.reduce((acc, sample) => ({
    cpu: acc.cpu + sample.cpu,
    memory: acc.memory + sample.memory,
    heapUsed: acc.heapUsed + sample.heapUsed,
    eventLoopLag: acc.eventLoopLag + sample.eventLoopLag,
  }), { cpu: 0, memory: 0, heapUsed: 0, eventLoopLag: 0 });

  const count = samples.length;

  return {
    avgCpu: sum.cpu / count,
    maxCpu: Math.max(...samples.map(s => s.cpu)),
    avgMemory: sum.memory / count,
    maxMemory: Math.max(...samples.map(s => s.memory)),
    avgHeapUsed: sum.heapUsed / count,
    maxHeapUsed: Math.max(...samples.map(s => s.heapUsed)),
    avgEventLoopLag: sum.eventLoopLag / count,
    maxEventLoopLag: Math.max(...samples.map(s => s.eventLoopLag)),
  };
}

function displayProfileResults(profile: PerformanceProfile): void {
  console.log('\n📊 Performance Profile Results');
  console.log('='.repeat(80));

  console.log(`\n🔧 Service: ${profile.serviceName}`);
  console.log(`⏱️  Duration: ${profile.duration}s | Samples: ${profile.samples.length}`);
  console.log(`📏 Interval: ${profile.interval}ms`);

  console.log('\n💾 Memory Usage:');
  console.log(`   Average: ${formatBytes(profile.summary.avgMemory)} | Peak: ${formatBytes(profile.summary.maxMemory)}`);
  console.log(`   Heap Avg: ${formatBytes(profile.summary.avgHeapUsed)} | Heap Peak: ${formatBytes(profile.summary.maxHeapUsed)}`);
  console.log(`   External: ${formatBytes(profile.samples[0]?.external || 0)}`);

  console.log('\n⚡ Performance:');
  console.log(`   CPU Avg: ${profile.summary.avgCpu.toFixed(2)}s | Peak: ${profile.summary.maxCpu.toFixed(2)}s`);
  console.log(`   Event Loop Avg: ${profile.summary.avgEventLoopLag.toFixed(2)}ms | Peak: ${profile.summary.maxEventLoopLag.toFixed(2)}ms`);

  console.log('\n🔗 Resources:');
  const lastSample = profile.samples[profile.samples.length - 1];
  if (lastSample) {
    console.log(`   Active Handles: ${lastSample.activeHandles} | Active Requests: ${lastSample.activeRequests}`);
  }

  // Performance recommendations
  console.log('\n💡 Performance Insights:');

  if (profile.summary.maxMemory > 500 * 1024 * 1024) { // > 500MB
    console.log('   ⚠️  High memory usage detected - consider memory optimization');
  }

  if (profile.summary.maxEventLoopLag > 100) { // > 100ms
    console.log('   ⚠️  High event loop lag detected - consider optimizing async operations');
  }

  if (profile.samples.length > 0) {
    const firstSample = profile.samples[0];
    if (firstSample.heapTotal > 0 && profile.summary.avgHeapUsed / firstSample.heapTotal > 0.8) { // > 80%
      console.log('   ⚠️  High heap usage ratio - potential memory leak');
    }
  }

  if (profile.samples.length < profile.duration * 1000 / profile.interval * 0.9) {
    console.log('   ⚠️  Some samples failed to collect - check service health');
  }

  console.log('\n📈 Sample Timeline (last 10 samples):');
  const recentSamples = profile.samples.slice(-10);
  for (let i = 0; i < recentSamples.length; i++) {
    const sample = recentSamples[i];
    const time = new Date(sample.timestamp).toLocaleTimeString();
    console.log(`   ${time} | CPU: ${sample.cpu.toFixed(2)}s | Memory: ${formatBytes(sample.memory)} | Heap: ${formatBytes(sample.heapUsed)}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${sizes[i]}`;
}

async function saveProfileData(profile: PerformanceProfile, filename: string): Promise<void> {
  const data = {
    metadata: {
      serviceName: profile.serviceName,
      duration: profile.duration,
      interval: profile.interval,
      sampleCount: profile.samples.length,
      timestamp: new Date().toISOString(),
    },
    summary: profile.summary,
    samples: profile.samples,
  };

  const json = JSON.stringify(data, null, 2);
  await Bun.write(filename, json);
}
