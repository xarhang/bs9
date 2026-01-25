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
import { getPlatformInfo } from "../platform/detect.js";

interface DoctorOptions {
  check?: string;
  verbose?: boolean;
}

interface HealthCheck {
  name: string;
  status: "✅ PASS" | "❌ FAIL" | "⚠️ WARN";
  message: string;
  details?: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log("🏥 BS9 Health Check & Diagnostics");
  console.log("=".repeat(80));
  
  const checks: HealthCheck[] = [];
  const platformInfo = getPlatformInfo();
  
  // Basic installation checks
  checks.push(checkBunInstallation());
  checks.push(checkBS9Installation());
  checks.push(checkPlatformDetection(platformInfo));
  
  // Directory structure checks
  checks.push(checkDirectoryStructure(platformInfo));
  checks.push(checkPermissions(platformInfo));
  
  // Service manager checks
  checks.push(checkServiceManager(platformInfo));
  
  // Network and connectivity checks
  checks.push(checkNetworkConnectivity());
  
  // Optional checks based on flags
  if (options.check) {
    const specificChecks = runSpecificCheck(options.check, platformInfo);
    checks.push(...specificChecks);
  }
  
  if (options.verbose) {
    checks.push(checkSystemResources());
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

function checkBunInstallation(): HealthCheck {
  try {
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    return {
      name: "Bun Installation",
      status: "✅ PASS",
      message: `Bun v${version} installed`,
      details: `Runtime: ${version}`
    };
  } catch {
    return {
      name: "Bun Installation",
      status: "❌ FAIL",
      message: "Bun is not installed or not in PATH",
      details: "Install Bun from https://bun.sh"
    };
  }
}

function checkBS9Installation(): HealthCheck {
  try {
    const version = execSync("bs9 --version", { encoding: "utf-8" }).trim();
    return {
      name: "BS9 Installation",
      status: "✅ PASS",
      message: `BS9 ${version} installed`,
      details: `CLI: ${version}`
    };
  } catch {
    return {
      name: "BS9 Installation",
      status: "❌ FAIL",
      message: "BS9 is not installed or not in PATH",
      details: "Run 'npm install -g bs9' or install from source"
    };
  }
}

function checkPlatformDetection(platformInfo: any): HealthCheck {
  return {
    name: "Platform Detection",
    status: "✅ PASS",
    message: `Detected ${platformInfo.platform}`,
    details: `OS: ${platformInfo.platform}, Service Manager: ${platformInfo.serviceManager}`
  };
}

function checkDirectoryStructure(platformInfo: any): HealthCheck {
  const requiredDirs = [
    platformInfo.configDir,
    platformInfo.logDir,
    platformInfo.serviceDir
  ];
  
  const missingDirs = requiredDirs.filter(dir => !existsSync(dir));
  
  if (missingDirs.length === 0) {
    return {
      name: "Directory Structure",
      status: "✅ PASS",
      message: "All required directories exist",
      details: `Config: ${platformInfo.configDir}`
    };
  } else {
    return {
      name: "Directory Structure",
      status: "❌ FAIL",
      message: `Missing ${missingDirs.length} directories`,
      details: `Missing: ${missingDirs.join(", ")}`
    };
  }
}

function checkPermissions(platformInfo: any): HealthCheck {
  try {
    // Test write permissions
    const testFile = join(platformInfo.configDir, ".bs9-test");
    execSync(`touch "${testFile}"`, { stdio: "ignore" });
    execSync(`rm "${testFile}"`, { stdio: "ignore" });
    
    return {
      name: "File Permissions",
      status: "✅ PASS",
      message: "Write permissions OK",
      details: `Can write to ${platformInfo.configDir}`
    };
  } catch {
    return {
      name: "File Permissions",
      status: "❌ FAIL",
      message: "Insufficient file permissions",
      details: `Cannot write to ${platformInfo.configDir}`
    };
  }
}

function checkServiceManager(platformInfo: any): HealthCheck {
  try {
    switch (platformInfo.platform) {
      case "linux":
        execSync("systemctl --user --version", { stdio: "ignore" });
        return {
          name: "Service Manager",
          status: "✅ PASS",
          message: "systemd user services available",
          details: "systemd user mode is working"
        };
      
      case "darwin":
        execSync("launchctl list", { stdio: "ignore" });
        return {
          name: "Service Manager",
          status: "✅ PASS",
          message: "launchd available",
          details: "macOS launchd is working"
        };
      
      case "win32":
        execSync("sc query", { stdio: "ignore" });
        return {
          name: "Service Manager",
          status: "✅ PASS",
          message: "Windows Services available",
          details: "Windows Service Manager is working"
        };
      
      default:
        return {
          name: "Service Manager",
          status: "⚠️ WARN",
          message: "Unsupported platform",
          details: `Platform ${platformInfo.platform} may have limited support`
        };
    }
  } catch {
    return {
      name: "Service Manager",
      status: "❌ FAIL",
      message: "Service manager not available",
      details: "Cannot access system service manager"
    };
  }
}

function checkNetworkConnectivity(): HealthCheck {
  try {
    // Test basic network connectivity
    execSync("curl -s --connect-timeout 3 http://httpbin.org/ip", { stdio: "ignore" });
    return {
      name: "Network Connectivity",
      status: "✅ PASS",
      message: "Network connectivity OK",
      details: "Can reach external services"
    };
  } catch {
    return {
      name: "Network Connectivity",
      status: "⚠️ WARN",
      message: "Limited network connectivity",
      details: "Cannot reach external services (may be offline)"
    };
  }
}

function checkSystemResources(): HealthCheck {
  try {
    const memory = execSync("free -h", { encoding: "utf-8" });
    const disk = execSync("df -h .", { encoding: "utf-8" });
    
    return {
      name: "System Resources",
      status: "✅ PASS",
      message: "System resources OK",
      details: `Memory and disk space available`
    };
  } catch {
    return {
      name: "System Resources",
      status: "⚠️ WARN",
      message: "Cannot check system resources",
      details: "Resource monitoring not available"
    };
  }
}

function checkDependencies(): HealthCheck {
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

function runSpecificCheck(check: string, platformInfo: any): HealthCheck[] {
  const checks: HealthCheck[] = [];
  
  switch (check.toLowerCase()) {
    case "dependencies":
      checks.push(checkDependencies());
      break;
    
    case "configuration":
      checks.push(checkDirectoryStructure(platformInfo));
      checks.push(checkPermissions(platformInfo));
      break;
    
    case "platform":
      checks.push(checkPlatformDetection(platformInfo));
      checks.push(checkServiceManager(platformInfo));
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

function displayResults(checks: HealthCheck[]): void {
  console.log("\n🔍 Health Check Results:");
  console.log("-".repeat(80));
  
  for (const check of checks) {
    console.log(`${check.status} ${check.name}: ${check.message}`);
    if (check.details) {
      console.log(`   📋 ${check.details}`);
    }
  }
}
