#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, getMultipleServiceInfo, confirmAction } from "../utils/array-parser.js";

// Security: Host validation function
function isValidHost(host: string): boolean {
  // Allow localhost, 0.0.0.0, and valid IP addresses
  const localhostRegex = /^(localhost|127\.0\.0\.1|::1)$/;
  const anyIPRegex = /^(0\.0\.0\.0|::)$/;
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
  
  if (localhostRegex.test(host) || anyIPRegex.test(host)) {
    return true;
  }
  
  if (ipv4Regex.test(host)) {
    const parts = host.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  if (ipv6Regex.test(host)) {
    return true;
  }
  
  if (hostnameRegex.test(host) && host.length <= 253) {
    return true;
  }
  
  return false;
}

interface StartOptions {
  name?: string;
  port?: string;
  host?: string;
  env?: string[];
  otel?: boolean;
  prometheus?: boolean;
  build?: boolean;
  https?: boolean;
}

export async function startCommand(files: string[], options: StartOptions): Promise<void> {
  const platformInfo = getPlatformInfo();
  
  // Handle multiple arguments
  const file = files.length > 0 ? files.join(' ') : '';
  
  // Handle multi-service operations
  if (file.includes('[') || file === 'all') {
    await handleMultiServiceStart(file, options);
    return;
  }
  
  // Single service operation (existing logic)
  await handleSingleServiceStart(file, options);
}

async function handleMultiServiceStart(file: string, options: StartOptions): Promise<void> {
  const services = await parseServiceArray(file);
  
  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }
  
  console.log(`🚀 Starting ${services.length} services...`);
  
  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        // For multi-service, we need to find the service file
        const serviceFile = findServiceFile(serviceName);
        if (!serviceFile) {
          throw new Error(`Service file not found for: ${serviceName}`);
        }
        
        await handleSingleServiceStart(serviceFile, { ...options, name: serviceName });
        return { service: serviceName, status: 'success', error: null };
      } catch (error) {
        return { service: serviceName, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  
  displayBatchResults(results, 'start');
}

async function handleSingleServiceStart(file: string, options: StartOptions): Promise<void> {
  const platformInfo = getPlatformInfo();
  
  // Security: Validate and sanitize file path
  const fullPath = resolve(file);
  if (!existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    process.exit(1);
  }
  
  // Security: Prevent directory traversal and ensure file is within allowed paths
  const allowedPaths = [process.cwd(), homedir()];
  const isAllowedPath = allowedPaths.some(allowed => fullPath.startsWith(allowed));
  if (!isAllowedPath) {
    console.error(`❌ Security: File path outside allowed directories: ${fullPath}`);
    process.exit(1);
  }
  
  // Security: Validate and sanitize service name
  const rawServiceName = options.name || basename(fullPath, fullPath.endsWith('.ts') ? '.ts' : '.js');
  const serviceName = rawServiceName.replace(/[^a-zA-Z0-9-_]/g, "_").replace(/^[^a-zA-Z]/, "_").substring(0, 64);
  
  // Security: Validate port number
  const port = options.port || "3000";
  const portNum = Number(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    console.error(`❌ Security: Invalid port number: ${port}. Must be 1-65535`);
    process.exit(1);
  }
  
  // Security: Validate host
  const host = options.host || "localhost";
  if (!isValidHost(host)) {
    console.error(`❌ Security: Invalid host: ${host}`);
    process.exit(1);
  }
  
  const protocol = options.https ? "https" : "http";

  // Port warning for privileged ports
  if (portNum < 1024) {
    console.warn(`⚠️  Port ${port} is privileged (< 1024).`);
    console.warn("   Options:");
    console.warn("   - Use port >= 1024 (recommended)");
    if (platformInfo.isWindows) {
      console.warn("   - Run as Administrator (not recommended)");
    } else {
      console.warn("   - Run with sudo (not recommended for user services)");
      console.warn("   - Use port forwarding: `sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000`");
    }
  }

  // Handle TypeScript files and build option
  let execPath = fullPath;
  let isBuilt = false;

  if (fullPath.endsWith('.ts')) {
    if (options.build) {
      // AOT: Build TypeScript to single executable
      console.log("🔨 Building TypeScript for production...");
      const buildDir = join(dirname(fullPath), ".bs9-build");
      mkdirSync(buildDir, { recursive: true });
      
      const outputFile = join(buildDir, `${serviceName}.js`);
      try {
        execSync(`bun build ${fullPath} --outdir ${buildDir} --target bun --minify --splitting`, { stdio: "inherit" });
        execPath = outputFile;
        isBuilt = true;
        console.log(`✅ Built to: ${execPath}`);
      } catch (err) {
        console.error(`❌ Build failed: ${err}`);
        process.exit(1);
      }
    } else {
      // JIT: Run TypeScript directly (default)
      console.log("⚡ Running TypeScript in JIT mode");
    }
  }

  // Phase 2: Pre-start Security Audit
  const auditResult = await securityAudit(execPath);
  if (auditResult.critical.length > 0) {
    console.error("🚨 Critical security issues found:");
    auditResult.critical.forEach(issue => console.error(`  - ${issue}`));
    console.error("\nRefusing to start. Fix issues or use --force to override.");
    process.exit(1);
  }

  if (auditResult.warning.length > 0) {
    console.warn("⚠️  Security warnings:");
    auditResult.warning.forEach(issue => console.warn(`  - ${issue}`));
  }

  // Platform-specific service creation
  if (platformInfo.isLinux) {
    await createLinuxService(serviceName, execPath, host, port, protocol, options);
  } else if (platformInfo.isMacOS) {
    await createMacOSService(serviceName, execPath, host, port, protocol, options);
  } else if (platformInfo.isWindows) {
    await createWindowsService(serviceName, execPath, host, port, protocol, options);
  } else {
    console.error(`❌ Platform ${platformInfo.platform} is not supported`);
    process.exit(1);
  }
}

function findServiceFile(serviceName: string): string | null {
  // Try to find the service file in common locations
  const possiblePaths = [
    join(process.cwd(), `${serviceName}.js`),
    join(process.cwd(), `${serviceName}.ts`),
    join(process.cwd(), 'src', `${serviceName}.js`),
    join(process.cwd(), 'src', `${serviceName}.ts`),
    join(process.cwd(), 'app', `${serviceName}.js`),
    join(process.cwd(), 'app', `${serviceName}.ts`),
  ];
  
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }
  
  return null;
}

function displayBatchResults(results: PromiseSettledResult<{ service: string; status: string; error: string | null }>[], operation: string): void {
  console.log(`\n📊 Batch ${operation} Results`);
  console.log("=".repeat(50));
  
  const successful = results.filter(r => r.status === 'fulfilled' && r.value.status === 'success');
  const failed = results.filter(r => r.status === 'fulfilled' && r.value.status === 'failed');
  
  successful.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`✅ ${result.value.service} - ${operation} successful`);
    }
  });
  
  failed.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`❌ ${result.value.service} - Failed: ${result.value.error}`);
    }
  });
  
  console.log(`\n📈 Summary:`);
  console.log(`   Total: ${results.length} services`);
  console.log(`   Success: ${successful.length}/${results.length} (${((successful.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`   Failed: ${failed.length}/${results.length} (${((failed.length / results.length) * 100).toFixed(1)}%)`);
}

async function createLinuxService(serviceName: string, execPath: string, host: string, port: string, protocol: string, options: StartOptions): Promise<void> {
  // Phase 1: Generate hardened systemd unit
  const unitContent = generateSystemdUnit({
    serviceName,
    fullPath: execPath,
    host,
    port,
    protocol,
    env: options.env || [],
    otel: options.otel ?? true,
    prometheus: options.prometheus ?? true,
  });

  const platformInfo = getPlatformInfo();
  const unitPath = join(platformInfo.serviceDir, `${serviceName}.service`);
  
  // Create user systemd directory if it doesn't exist
  if (!existsSync(platformInfo.serviceDir)) {
    mkdirSync(platformInfo.serviceDir, { recursive: true });
    console.log(`📁 Created user systemd directory: ${platformInfo.serviceDir}`);
  }
  
  try {
    writeFileSync(unitPath, unitContent);
    console.log(`✅ Systemd user unit written to: ${unitPath}`);
    
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${serviceName}`);
    execSync(`systemctl --user start ${serviceName}`);
    
    console.log(`🚀 Service '${serviceName}' started successfully`);
    console.log(`   Health: ${protocol}://${host}:${port}/healthz`);
    console.log(`   Metrics: ${protocol}://${host}:${port}/metrics`);
  } catch (error) {
    console.error(`❌ Failed to start service: ${error}`);
    process.exit(1);
  }
}

async function createMacOSService(serviceName: string, execPath: string, host: string, port: string, protocol: string, options: StartOptions): Promise<void> {
  const { launchdCommand } = await import("../macos/launchd.js");
  
  const envVars: Record<string, string> = {
    PORT: port,
    HOST: host,
    PROTOCOL: protocol,
    NODE_ENV: "production",
    SERVICE_NAME: serviceName,
    ...(options.env || []).reduce((acc, env) => {
      const [key, value] = env.split('=');
      if (key && value) acc[key] = value;
      return acc;
    }, {} as Record<string, string>)
  };
  
  if (options.otel) {
    envVars.OTEL_SERVICE_NAME = serviceName;
    envVars.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
  }
  
  try {
    await launchdCommand('create', {
      name: `bs9.${serviceName}`,
      file: execPath,
      workingDir: dirname(execPath),
      env: JSON.stringify(envVars),
      autoStart: true,
      keepAlive: true,
      logOut: `${getPlatformInfo().logDir}/${serviceName}.out.log`,
      logErr: `${getPlatformInfo().logDir}/${serviceName}.err.log`
    });
    
    console.log(`🚀 Service '${serviceName}' started successfully`);
    console.log(`   Health: ${protocol}://${host}:${port}/healthz`);
    console.log(`   Metrics: ${protocol}://${host}:${port}/metrics`);
  } catch (error) {
    console.error(`❌ Failed to start macOS service: ${error}`);
    process.exit(1);
  }
}

async function createWindowsService(serviceName: string, execPath: string, host: string, port: string, protocol: string, options: StartOptions): Promise<void> {
  const { windowsCommand } = await import("../windows/service.js");
  
  const envVars: Record<string, string> = {
    PORT: port,
    HOST: host,
    PROTOCOL: protocol,
    NODE_ENV: "production",
    SERVICE_NAME: serviceName,
    ...(options.env || []).reduce((acc, env) => {
      const [key, value] = env.split('=');
      if (key && value) acc[key] = value;
      return acc;
    }, {} as Record<string, string>)
  };
  
  if (options.otel) {
    envVars.OTEL_SERVICE_NAME = serviceName;
    envVars.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
  }
  
  try {
    await windowsCommand('create', {
      name: `BS9_${serviceName}`,
      file: execPath,
      displayName: `BS9 Service: ${serviceName}`,
      description: `BS9 managed service: ${serviceName}`,
      workingDir: dirname(execPath),
      args: ['run', execPath],
      env: JSON.stringify(envVars)
    });
    
    console.log(`🚀 Service '${serviceName}' started successfully`);
    console.log(`   Health: ${protocol}://${host}:${port}/healthz`);
    console.log(`   Metrics: ${protocol}://${host}:${port}/metrics`);
  } catch (error) {
    console.error(`❌ Failed to start Windows service: ${error}`);
    process.exit(1);
  }
}

interface SecurityAuditResult {
  critical: string[];
  warning: string[];
}

async function securityAudit(filePath: string): Promise<SecurityAuditResult> {
  const result: SecurityAuditResult = { critical: [], warning: [] };
  const content = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);

  // Check file permissions
  if (stat.mode & 0o002) {
    result.critical.push("File is world-writable");
  }

  // Check for dangerous patterns
  const dangerousPatterns = [
    { pattern: /eval\s*\(/, msg: "Use of eval() detected" },
    { pattern: /Function\s*\(/, msg: "Dynamic function construction detected" },
    { pattern: /child_process\.exec\s*\(/, msg: "Unsafe child_process.exec() detected" },
    { pattern: /require\s*\(\s*["']fs["']\s*\)/, msg: "Direct fs module usage (potential file system access)" },
    { pattern: /process\.env\.\w+\s*\+\s*["']/, msg: "Potential command injection via env concatenation" },
    { pattern: /require\s*\(\s*["']child_process["']\s*\)/, msg: "Child process module usage detected" },
    { pattern: /spawn\s*\(/, msg: "Process spawning detected" },
    { pattern: /execSync\s*\(/, msg: "Synchronous execution detected" },
  ];

  for (const { pattern, msg } of dangerousPatterns) {
    if (pattern.test(content)) {
      result.critical.push(msg);
    }
  }

  // Check for network access patterns
  if (content.includes("fetch(") || content.includes("http.request")) {
    result.warning.push("Network access detected - ensure outbound rules are in place");
  }

  // Check for file system writes
  if (content.includes("writeFileSync") || content.includes("createWriteStream")) {
    result.warning.push("File system write access detected - ensure proper sandboxing");
  }

  return result;
}

interface SystemdUnitOptions {
  serviceName: string;
  fullPath: string;
  host: string;
  port: string;
  protocol: string;
  env: string[];
  otel: boolean;
  prometheus: boolean;
}

function generateSystemdUnit(opts: SystemdUnitOptions): string {
  const envVars = [
    `PORT=${opts.port}`,
    `HOST=${opts.host}`,
    `PROTOCOL=${opts.protocol}`,
    `NODE_ENV=production`,
    `SERVICE_NAME=${opts.serviceName}`,
    ...opts.env,
  ];

  if (opts.otel) {
    envVars.push("OTEL_SERVICE_NAME=" + opts.serviceName);
    envVars.push("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces");
  }

  const envSection = envVars.map(e => `Environment=${e}`).join("\n");
  const workingDir = dirname(opts.fullPath);

  const bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  return `[Unit]
Description=BS9 Service: ${opts.serviceName}
After=network.target
Documentation=https://github.com/bs9/bs9

[Service]
Type=simple
Restart=on-failure
RestartSec=2s
TimeoutStartSec=30s
TimeoutStopSec=30s
WorkingDirectory=${workingDir}
ExecStart=${bunPath} run ${opts.fullPath}
${envSection}

# Security hardening (user systemd compatible)
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${workingDir}
UMask=0022

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=default.target
`;
}
