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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo, PlatformInfo } from "../platform/detect.js";
import * as health from "../utils/health.js";

interface DoctorOptions {
  check?: string;
  verbose?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log("🏥 BS9 Health Check & Diagnostics");
  console.log("=".repeat(80));

  const checks: health.HealthCheckResult[] = [];
  const platformInfo = getPlatformInfo();

  // Basic installation checks
  checks.push(health.checkBunInstallation());
  checks.push(health.checkBS9Installation());
  checks.push(health.checkPlatformDetection(platformInfo));

  // Directory structure checks
  checks.push(health.checkDirectoryStructure(platformInfo));
  checks.push(health.checkPermissions(platformInfo));

  // Service manager checks
  checks.push(health.checkServiceManager(platformInfo));

  // Network and connectivity checks
  checks.push(health.checkNetworkConnectivity());

  // Optional checks based on flags
  if (options.check) {
    const specificChecks = runSpecificCheck(options.check, platformInfo);
    checks.push(...specificChecks);
  }

  if (options.verbose) {
    checks.push(health.checkSystemResources());
    checks.push(checkDependencies());
  }

  // Display results
  displayResults(checks);

  // Summary
  const passed = checks.filter(c => c.status === "✅ PASS").length;
  const failed = checks.filter(c => c.status === "❌ FAIL").length;
  const warnings = checks.filter(c => c.status === "⚠️ WARN").length;

  console.log("\n" + "=".repeat(80));
  console.log(`📊 Health Check Summary:`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⚠️ Warnings: ${warnings}`);
  console.log(`   📈 Total: ${checks.length}`);

  if (failed > 0) {
    console.log(`\n❌ Health check FAILED with ${failed} error(s)`);
    console.log("💡 Run 'bs9 doctor --verbose' for more details");
    process.exit(1);
  } else {
    console.log(`\n✅ Health check PASSED - BS9 is ready to use!`);
  }
}

function checkDependencies(): health.HealthCheckResult {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    const deps = Object.keys(packageJson.dependencies || {});

    return {
      name: "Dependencies",
      status: "✅ PASS",
      message: `${deps.length} dependencies found`,
      details: `Dependencies: ${deps.slice(0, 3).join(", ")}${deps.length > 3 ? "..." : ""}`
    };
  } catch {
    return {
      name: "Dependencies",
      status: "⚠️ WARN",
      message: "No package.json found",
      details: "Not in a Node.js project directory"
    };
  }
}

function runSpecificCheck(check: string, platformInfo: PlatformInfo): health.HealthCheckResult[] {
  const checks: health.HealthCheckResult[] = [];

  switch (check.toLowerCase()) {
    case "dependencies":
      checks.push(checkDependencies());
      break;

    case "configuration":
      checks.push(health.checkDirectoryStructure(platformInfo));
      checks.push(health.checkPermissions(platformInfo));
      break;

    case "platform":
      checks.push(health.checkPlatformDetection(platformInfo));
      checks.push(health.checkServiceManager(platformInfo));
      break;

    default:
      checks.push({
        name: "Specific Check",
        status: "❌ FAIL",
        message: `Unknown check: ${check}`,
        details: "Available checks: dependencies, configuration, platform"
      });
  }

  return checks;
}

function displayResults(checks: health.HealthCheckResult[]): void {
  console.log("\n🔍 Health Check Results:");
  console.log("-".repeat(80));

  for (const check of checks) {
    console.log(`${check.status} ${check.name}: ${check.message}`);
    if (check.details) {
      console.log(`   📋 ${check.details}`);
    }
  }
}
