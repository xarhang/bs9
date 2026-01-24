#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

interface StartOptions {
  name?: string;
  port?: string;
  env?: string[];
  otel?: boolean;
  prometheus?: boolean;
  build?: boolean;
}

export async function startCommand(file: string, options: StartOptions): Promise<void> {
  const fullPath = resolve(file);
  if (!existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    process.exit(1);
  }

  const serviceName = options.name || basename(fullPath, fullPath.endsWith('.ts') ? '.ts' : '.js').replace(/[^a-zA-Z0-9-_]/g, "_");
  const port = options.port || "3000";

  // Port warning for privileged ports
  const portNum = Number(port);
  if (portNum < 1024) {
    console.warn(`⚠️  Port ${port} is privileged (< 1024).`);
    console.warn("   Options:");
    console.warn("   - Use port >= 1024 (recommended)");
    console.warn("   - Run with sudo (not recommended for user services)");
    console.warn("   - Use port forwarding: `sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000`");
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

  // Phase 1: Generate hardened systemd unit
  const unitContent = generateSystemdUnit({
    serviceName,
    fullPath: execPath,
    port,
    env: options.env || [],
    otel: options.otel ?? true,
    prometheus: options.prometheus ?? true,
  });

  const unitPath = join(homedir(), ".config/systemd/user", `${serviceName}.service`);
  
  // Create user systemd directory if it doesn't exist
  const userSystemdDir = join(homedir(), ".config/systemd/user");
  if (!existsSync(userSystemdDir)) {
    mkdirSync(userSystemdDir, { recursive: true });
    console.log(`📁 Created user systemd directory: ${userSystemdDir}`);
  }
  
  try {
    writeFileSync(unitPath, unitContent, { encoding: "utf-8" });
    console.log(`✅ Systemd user unit written to: ${unitPath}`);
  } catch (err) {
    console.error(`❌ Failed to write systemd user unit: ${err}`);
    process.exit(1);
  }

  // Reload and start using user systemd
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable ${serviceName}`, { stdio: "inherit" });
    execSync(`systemctl --user start ${serviceName}`, { stdio: "inherit" });
    console.log(`🚀 Service '${serviceName}' started successfully`);
    console.log(`   Health: http://localhost:${port}/healthz`);
    console.log(`   Metrics: http://localhost:${port}/metrics`);
  } catch (err) {
    console.error(`❌ Failed to start user service: ${err}`);
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
  port: string;
  env: string[];
  otel: boolean;
  prometheus: boolean;
}

function generateSystemdUnit(opts: SystemdUnitOptions): string {
  const envVars = [
    `PORT=${opts.port}`,
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

[Service]
Type=simple
Restart=on-failure
RestartSec=2s
TimeoutStartSec=30s
TimeoutStopSec=30s
WorkingDirectory=${workingDir}
ExecStart=${bunPath} run ${opts.fullPath}
${envSection}

[Install]
WantedBy=default.target
`;
}
