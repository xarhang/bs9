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
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir, cpus } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import { parseServiceArray, getMultipleServiceInfo, confirmAction, displayBatchResults } from "../utils/array-parser.js";
import { isEcosystemConfig, parseEcosystemConfig } from "../utils/ecosystem-config.js";
import { resolveRuntime } from "../utils/runtime-resolver.js";

// Security: Host validation function
export function isValidHost(host: string): boolean {
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

export interface StartOptions {
  name?: string;
  port?: string;
  host?: string;
  env?: string[];
  otel?: boolean;
  prometheus?: boolean;
  build?: boolean;
  https?: boolean;
  instances?: string;  // "1", "4", "max"
  watch?: boolean;
  maxMemoryRestart?: string;
  restartDelay?: string;
  autorestart?: boolean;
  cron?: string;
  time?: boolean;
  interpreter?: string;
}

/** Resolve "max" or numeric string to an integer instance count */
export function resolveInstances(raw: string | undefined): number {
  if (!raw || raw === "1") return 1;
  if (raw === "max") return cpus().length;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return 1;
  return n;
}

export async function startCommand(files: string[], options: StartOptions): Promise<void> {
  const platformInfo = getPlatformInfo();

  // --- Feature: ecosystem.config.js / bs9.config.json detection ---
  if (files.length === 1 && isEcosystemConfig(resolve(files[0]))) {
    await handleEcosystemStart(files[0], options);
    return;
  }

  // Multi-service if: multiple files, single file with array syntax, or 'all' keyword
  if (files.length > 1 || (files.length === 1 && (files[0].includes('[') || files[0] === 'all'))) {
    await handleMultiServiceStart(files, options);
    return;
  }

  const instanceCount = resolveInstances(options.instances);

  // --- Feature: Cluster mode (instances > 1) ---
  if (instanceCount > 1) {
    await handleClusterStart(files[0] || '', options, instanceCount);
    return;
  }

  // Single service operation
  await handleSingleServiceStart(files[0] || '', options);
}

/** Handle ecosystem.config.js / bs9.config.json */
async function handleEcosystemStart(configFile: string, options: StartOptions): Promise<void> {
  console.log(`📋 Loading ecosystem config: ${configFile}`);
  let entries;
  try {
    entries = await parseEcosystemConfig(configFile);
  } catch (err) {
    console.error(`❌ Failed to parse ecosystem config: ${err}`);
    process.exit(1);
  }

  console.log(`🚀 Starting ${entries.length} app(s) from ecosystem config...`);

  const results = await Promise.allSettled(
    entries.map(async (app) => {
      try {
        const instanceCount = app.instances ?? resolveInstances(options.instances);
        const appOptions: StartOptions = {
          name: app.name,
          port: app.port ?? options.port,
          host: app.host ?? options.host,
          env: app.env ?? options.env,
          otel: app.otel ?? options.otel,
          prometheus: app.prometheus ?? options.prometheus,
          https: app.https ?? options.https,
          build: app.build ?? options.build,
          instances: String(instanceCount),
          interpreter: app.interpreter ?? options.interpreter,
        };

        if (instanceCount > 1) {
          await handleClusterStart(app.file, appOptions, instanceCount);
        } else {
          await handleSingleServiceStart(app.file, appOptions);
        }
        return { service: app.name || app.file, status: 'success', error: null };
      } catch (error) {
        return { service: app.name || app.file, status: 'failed', error: (error as Error).message };
      }
    })
  );

  displayBatchResults(results, 'start');
}

/** Handle cluster mode: spawn N workers sharing the same port via reusePort preload */
async function handleClusterStart(file: string, options: StartOptions, instanceCount: number): Promise<void> {
  const baseName = options.name || basename(file).replace(/\.[a-zA-Z0-9]+$/, '');
  const port = options.port || '3000';

  console.log(`🔀 Starting ${instanceCount} cluster workers for '${baseName}' on port ${port}...`);
  console.log(`   Using Bun reusePort — kernel load balances across all workers`);

  const results = await Promise.allSettled(
    Array.from({ length: instanceCount }, async (_, i) => {
      const workerName = `${baseName}-${i}`;
      try {
        await handleSingleServiceStart(file, {
          ...options,
          name: workerName,
          env: [
            ...(options.env || []),
            `BS9_CLUSTER=true`,
            `BS9_CLUSTER_ID=${i}`,
            `BS9_CLUSTER_TOTAL=${instanceCount}`,
            `BS9_REUSE_PORT=true`,
          ],
          instances: '1', // each worker is a single service
        });
        return { service: workerName, status: 'success', error: null };
      } catch (error) {
        return { service: workerName, status: 'failed', error: (error as Error).message };
      }
    })
  );

  displayBatchResults(results, 'start');
  console.log(`\n✅ Cluster '${baseName}' — ${instanceCount} workers running on port ${port}`);
  console.log(`   Stop all workers: bs9 stop [${baseName}-0..${baseName}-${instanceCount - 1}]`);
  console.log(`   Status: bs9 status [${baseName}-*]`);
}


async function handleMultiServiceStart(file: string | string[], options: StartOptions): Promise<void> {
  const services = await parseServiceArray(file);

  if (services.length === 0) {
    console.log("❌ No services found matching the pattern");
    return;
  }

  console.log(`🚀 Starting ${services.length} services...`);

  const results = await Promise.allSettled(
    services.map(async (serviceName) => {
      try {
        const platformInfo = getPlatformInfo();

        // First check if service already exists
        const serviceExists = await checkServiceExists(serviceName, platformInfo);

        if (serviceExists) {
          // Service exists, start it directly
          await startExistingService(serviceName, platformInfo);
          return { service: serviceName, status: 'success', error: null };
        } else {
          // Service doesn't exist, look for file
          const serviceFile = findServiceFile(serviceName);
          if (!serviceFile) {
            throw new Error(`Service file not found for: ${serviceName}`);
          }

          await handleSingleServiceStart(serviceFile, { ...options, name: serviceName });
          return { service: serviceName, status: 'success', error: null };
        }
      } catch (error) {
        return { service: serviceName, status: 'failed', error: (error as Error).message };
      }
    })
  );

  displayBatchResults(results, 'start');
}

async function handleSingleServiceStart(file: string, options: StartOptions): Promise<void> {
  const platformInfo = getPlatformInfo();

  // First, try to start existing service without file
  const serviceName = options.name || file;

  const serviceExists = await checkServiceExists(serviceName, platformInfo);

  if (serviceExists) {
    console.log(`📋 Service '${serviceName}' already exists, starting...`);
    try {
      await startExistingService(serviceName, platformInfo);
      return;
    } catch (error) {
      console.log(`⚠️  Failed to start existing service: ${error}`);
      console.log(`📁 Looking for application file: ${file}`);
    }
  }

  // Security: Validate and sanitize file path
  const fullPath = resolve(file);
  if (!existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    process.exit(1);
  }

  // Security: Prevent directory traversal and ensure file is within allowed paths
  const allowedPaths = [
    process.cwd(),
    homedir(),
    "/var/www",
    "/srv",
    "/opt",
    process.platform === "win32" ? "D:\\" : "",
    process.platform === "win32" ? "E:\\" : "",
  ].filter(Boolean);
  const isAllowedPath = allowedPaths.some(allowed => fullPath.toLowerCase().startsWith(allowed.toLowerCase()));
  if (!isAllowedPath) {
    console.error(`❌ Security: File path outside allowed directories: ${fullPath}`);
    process.exit(1);
  }

  // Security: Validate and sanitize service name
  const rawServiceName = options.name || basename(fullPath).replace(/\.[a-zA-Z0-9]+$/, '');
  const finalServiceName = rawServiceName.replace(/[^a-zA-Z0-9-_]/g, "_").replace(/^[^a-zA-Z]/, "_").substring(0, 64);

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

      const outputFile = join(buildDir, basename(fullPath, '.ts') + '.js');
      const res = spawnSync("bun", ["build", fullPath, "--outdir", buildDir, "--target", "bun", "--minify", "--splitting"], { stdio: "inherit" });
      if (res.status !== 0) {
        console.error(`❌ Build failed`);
        process.exit(1);
      }
      execPath = outputFile;
      isBuilt = true;
      console.log(`✅ Built to: ${execPath}`);
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
    await createLinuxService(finalServiceName, execPath, host, port, protocol, options);
  } else if (platformInfo.isMacOS) {
    await createMacOSService(finalServiceName, execPath, host, port, protocol, options);
  } else if (platformInfo.isWindows) {
    await createWindowsService(finalServiceName, execPath, host, port, protocol, options);
  } else {
    console.error(`❌ Platform ${platformInfo.platform} is not supported`);
    process.exit(1);
  }
}

async function checkServiceExists(serviceName: string, platformInfo: any): Promise<boolean> {
  try {
    if (platformInfo.isLinux) {
      // Check if service exists in systemctl list-units
      const listOutput = execSync("systemctl --user list-units --type=service --all --no-pager --no-legend", { encoding: "utf-8" });
      const serviceExists = listOutput.includes(`${serviceName}.service`);
      return serviceExists;
    } else if (platformInfo.isMacOS) {
      // Check if launchd service exists
      const servicePath = join(platformInfo.serviceDir, `bs9.${serviceName}.plist`);
      return existsSync(servicePath);
    } else if (platformInfo.isWindows) {
      // Check if Windows service exists
      const { windowsCommand } = await import("../windows/service.js");
      try {
        await windowsCommand('show', { name: `BS9_${serviceName}` });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function startExistingService(serviceName: string, platformInfo: any): Promise<void> {
  try {
    if (platformInfo.isLinux) {
      spawnSync("systemctl", ["--user", "start", serviceName], { stdio: "inherit" });
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('start', { name: `bs9.${serviceName}` });
    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('start', { name: `BS9_${serviceName}` });
    }
    console.log(`🚀 Service '${serviceName}' started successfully`);
  } catch (error) {
    throw error;
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
    interpreter: options.interpreter
  });

  const platformInfo = getPlatformInfo();
  const unitPath = join(platformInfo.serviceDir, `${serviceName}.service`);

  // Create user systemd directory if it doesn't exist
  if (!existsSync(platformInfo.serviceDir)) {
    mkdirSync(platformInfo.serviceDir, { recursive: true });
    console.log(`📁 Created user systemd directory: ${platformInfo.serviceDir}`);
  }

  try {
    // Check if service already exists
    const serviceExists = existsSync(unitPath);

    if (!serviceExists) {
      // First time: Create service file
      writeFileSync(unitPath, unitContent);
      console.log(`✅ Systemd user unit written to: ${unitPath}`);
      spawnSync("systemctl", ["--user", "daemon-reload"]);
      spawnSync("systemctl", ["--user", "enable", serviceName]);
      console.log(`🔧 Service '${serviceName}' created and enabled`);
    } else {
      console.log(`📋 Service '${serviceName}' already exists, starting...`);
    }

    // Always start the service
    spawnSync("systemctl", ["--user", "start", serviceName], { stdio: "inherit" });

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

  const isClusterWorker = (options.env || []).some(e => e.includes("BS9_REUSE_PORT=true"));
  const preloadPath = resolve(join(dirname(import.meta.path), '..', 'utils', 'cluster-preload.ts'));
  const preloadArgs = isClusterWorker && existsSync(preloadPath) ? ['--preload', preloadPath] : [];

  const runtime = resolveRuntime(execPath, options.interpreter, preloadArgs);

  try {
    await launchdCommand('create', {
      name: `bs9.${serviceName}`,
      file: runtime.executable,
      args: runtime.args,
      workingDir: dirname(execPath),
      env: JSON.stringify(envVars),
      autoStart: true,
      keepAlive: true,
      logOut: `${getPlatformInfo().logDir}/${serviceName}.out.log`,
      logErr: `${getPlatformInfo().logDir}/${serviceName}.err.log`
    });

    console.log(`🚀 Service '${serviceName}' [${runtime.runtimeName}] started successfully`);
    console.log(`   Health: ${protocol}://${host}:${port}/healthz`);
    console.log(`   Metrics: ${protocol}://${host}:${port}/metrics`);
  } catch (error) {
    console.error(`❌ Failed to start macOS service: ${error}`);
    process.exit(1);
  }
}

async function createWindowsService(serviceName: string, execPath: string, host: string, port: string, protocol: string, options: StartOptions): Promise<void> {
  const { windowsCommand } = await import("../windows/service.js");

  const isClusterWorker = (options.env || []).some(e => e.includes("BS9_REUSE_PORT=true"));
  const preloadPath = resolve(join(dirname(import.meta.path), '..', 'utils', 'cluster-preload.ts'));
  const preloadArgs = isClusterWorker && existsSync(preloadPath) ? ['--preload', preloadPath] : [];

  const runtime = resolveRuntime(execPath, options.interpreter, preloadArgs);

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
    // windowsCommand internally handles admin vs non-admin (background process)
    await windowsCommand('create', {
      name: `BS9_${serviceName}`,
      file: runtime.executable,
      displayName: `BS9 Service: ${serviceName}`,
      description: `BS9 managed service: ${serviceName} (${runtime.runtimeName}, port ${port})`,
      workingDir: resolve(dirname(execPath)),
      args: runtime.args,
      env: JSON.stringify(envVars),
      watch: options.watch,
      maxMemoryRestart: options.maxMemoryRestart,
      restartDelay: options.restartDelay ? parseInt(options.restartDelay, 10) : undefined,
      noAutorestart: options.autorestart === false,
      time: options.time,
      scriptFile: execPath
    });

    console.log(`🚀 Service '${serviceName}' [${runtime.runtimeName}] initialization complete`);
    console.log(`   Health: ${protocol}://${host}:${port}/healthz`);
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

  // Check file permissions (Unix-style world-writable check is unreliable on Windows)
  if (process.platform !== "win32" && (stat.mode & 0o002)) {
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
  interpreter?: string;
}

function generateSystemdUnit(opts: SystemdUnitOptions): string {
  // Security: Check for newline characters in env to prevent Systemd Unit directive injection
  for (const envEntry of opts.env) {
    if (/[\r\n]/.test(envEntry)) {
      throw new Error(`Security: Environment variable contains illegal newline character: ${JSON.stringify(envEntry)}`);
    }
  }

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

  const isClusterWorker = opts.env.some(e => e.includes("BS9_REUSE_PORT=true"));
  const preloadPath = resolve(join(dirname(import.meta.path), '..', 'utils', 'cluster-preload.ts'));
  const preloadFlag = isClusterWorker && existsSync(preloadPath) ? `--preload "${preloadPath}"` : "";

  const runtime = resolveRuntime(opts.fullPath, opts.interpreter, preloadFlag ? [preloadFlag] : []);
  const execStart = runtime.isBinary
    ? opts.fullPath
    : `${runtime.executable} ${runtime.args.join(' ')}`;

  return `[Unit]
Description=BS9 Service: ${opts.serviceName}
After=network.target
Documentation=https://github.com/xarhang/bs9

[Service]
Type=simple
Restart=on-failure
RestartSec=2s
TimeoutStartSec=30s
TimeoutStopSec=30s
WorkingDirectory=${workingDir}
ExecStart=${execStart}
${envSection}

# Security hardening (user systemd compatible)
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${workingDir}
UMask=0022

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=default.target
`;
}
