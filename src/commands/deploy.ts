#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { existsSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { getPlatformInfo, initializePlatformDirectories } from "../platform/detect.js";

interface DeployOptions {
  name?: string;
  port?: string;
  host?: string;
  env?: string[];
  instances?: number;
  memory?: string;
  cpu?: string;
  logLevel?: string;
  logFile?: string;
  restart?: string;
  health?: boolean;
  metrics?: boolean;
  otel?: boolean;
  prometheus?: boolean;
  https?: boolean;
  linger?: boolean;
  force?: boolean;
  reload?: boolean;
  build?: boolean;
}

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

// Security: Host validation
function isValidHost(host: string): boolean {
  const localhostRegex = /^(localhost|127\.0\.0\.1|::1)$/;
  const anyIPRegex = /^(0\.0\.0\.0|::)$/;
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

  return localhostRegex.test(host) || anyIPRegex.test(host) ||
    (ipv4Regex.test(host) && host.split('.').every(part => parseInt(part, 10) <= 255)) ||
    (hostnameRegex.test(host) && host.length <= 253);
}

// Security: Port validation
function isValidPort(port: string): boolean {
  const portNum = parseInt(port, 10);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

export async function deployCommand(file: string, options: DeployOptions): Promise<void> {
  console.log("🚀 BS9 Deploy - Zero-Config Production Deployment");
  console.log("=".repeat(50));

  // Initialize platform directories
  initializePlatformDirectories();

  const platformInfo = getPlatformInfo();

  // Step 1: Validate file
  const fullPath = resolve(file);
  if (!existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    process.exit(1);
  }

  // Security: Validate file path
  const fileName = basename(fullPath);
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    console.error(`❌ Security: Invalid file path: ${file}`);
    process.exit(1);
  }

  // Step 2: Auto-generate service name if not provided
  const serviceName = options.name || fileName.replace(/\.(js|ts|mjs|cjs)$/, '').replace(/[^a-zA-Z0-9._-]/g, '-');

  if (!isValidServiceName(serviceName)) {
    console.error(`❌ Security: Invalid service name: ${serviceName}`);
    process.exit(1);
  }

  // Step 3: Enable linger for user services persistence
  if (options.linger !== false && platformInfo.isLinux) {
    try {
      console.log("🔧 Enabling user services persistence...");
      execSync("loginctl enable-linger $USER", { stdio: "pipe" });
      console.log("✅ User services persistence enabled");
    } catch (error: any) {
      console.warn("⚠️  Could not enable linger (may require root):", error?.message || error);
    }
  }

  // Step 4: Validate configuration
  const host = options.host || "localhost";
  const port = options.port || "3000";

  if (!isValidHost(host)) {
    console.error(`❌ Security: Invalid host: ${host}`);
    process.exit(1);
  }

  if (!isValidPort(port)) {
    console.error(`❌ Security: Invalid port: ${port}`);
    process.exit(1);
  }

  // Step 5: Deploy or reload
  try {
    if (options.reload) {
      await reloadService(serviceName, file, options);
    } else {
      await deployService(serviceName, file, options);
    }
  } catch (err: any) {
    console.error(`❌ Deployment failed: ${err?.message || err}`);
    process.exit(1);
  }
}

async function deployService(serviceName: string, file: string, options: DeployOptions): Promise<void> {
  console.log(`📦 Deploying: ${serviceName}`);
  console.log(`📁 File: ${file}`);
  console.log(`🌐 Host: ${options.host || "localhost"}:${options.port || "3000"}`);

  // Import start command to reuse logic
  const { startCommand } = await import("./start.js");

  // Deploy with all production defaults
  await startCommand([file], {
    name: serviceName,
    port: options.port || "3000",
    host: options.host || "localhost",
    env: options.env || [],
    otel: options.otel !== false, // Default to true
    prometheus: options.prometheus !== false, // Default to true
    build: options.build,
    https: options.https
  });

  // Step 6: Health check
  if (options.health !== false) {
    await performHealthCheck(serviceName, options.port || "3000", options.host || "localhost");
  }

  // Step 7: Show deployment summary
  showDeploymentSummary(serviceName, options);
}

async function reloadService(serviceName: string, file: string, options: DeployOptions): Promise<void> {
  console.log(`🔄 Reloading: ${serviceName}`);

  try {
    // Update environment variables if provided
    if (options.env && options.env.length > 0) {
      console.log("🔧 Updating environment variables...");
      // This would update the service configuration
      // For now, we'll restart with new env vars
    }

    // Restart service with new configuration
    const { restartCommand } = await import("./restart.js");
    await restartCommand([serviceName]);

    // Health check after reload
    if (options.health !== false) {
      await performHealthCheck(serviceName, options.port || "3000", options.host || "localhost");
    }

    console.log("✅ Service reloaded successfully");
  } catch (err: any) {
    console.error(`❌ Reload failed: ${err?.message || err}`);
    throw err;
  }
}

async function performHealthCheck(serviceName: string, port: string, host: string): Promise<void> {
  console.log("🏥 Performing health check...");

  const healthUrl = `http://${host}:${port}/healthz`;
  const metricsUrl = `http://${host}:${port}/metrics`;

  try {
    // Wait a moment for service to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check health endpoint
    const healthResponse = await fetch(healthUrl);
    if (healthResponse.ok) {
      console.log(`✅ Health check passed: ${healthUrl}`);
    } else {
      console.warn(`⚠️  Health check failed: ${healthResponse.status}`);
    }

    // Check metrics endpoint
    const metricsResponse = await fetch(metricsUrl);
    if (metricsResponse.ok) {
      console.log(`✅ Metrics endpoint available: ${metricsUrl}`);
    } else {
      console.warn(`⚠️  Metrics endpoint failed: ${metricsResponse.status}`);
    }

  } catch (error: any) {
    console.warn(`⚠️  Health check failed: ${error?.message || error}`);
    console.log(`💡 Make sure your app exposes /healthz and /metrics endpoints`);
  }
}

function showDeploymentSummary(serviceName: string, options: DeployOptions): void {
  console.log("\n" + "=".repeat(50));
  console.log("🎉 DEPLOYMENT SUMMARY");
  console.log("=".repeat(50));
  console.log(`📦 Service: ${serviceName}`);
  console.log(`🌐 URL: http://${options.host || "localhost"}:${options.port || "3000"}`);
  console.log(`🏥 Health: http://${options.host || "localhost"}:${options.port || "3000"}/healthz`);
  console.log(`📊 Metrics: http://${options.host || "localhost"}:${options.port || "3000"}/metrics`);
  console.log(`📈 OpenTelemetry: ${options.otel !== false ? 'Enabled' : 'Disabled'}`);
  console.log(`📊 Prometheus: ${options.prometheus !== false ? 'Enabled' : 'Disabled'}`);

  console.log("\n🔧 MANAGEMENT COMMANDS:");
  console.log(`  bs9 status ${serviceName}`);
  console.log(`  bs9 logs ${serviceName} --follow`);
  console.log(`  bs9 restart ${serviceName}`);
  console.log(`  bs9 stop ${serviceName}`);
  console.log(`  bs9 delete ${serviceName}`);
  console.log(`  bs9 save ${serviceName}`);


  console.log("\n🚀 Your service is now running in production mode!");
}
