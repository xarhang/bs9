#!/usr/bin/env bun

/**
 * BS9 - Native Model Context Protocol (MCP) Server
 * 
 * Exposes complete BS9 process management, live telemetry, log streaming,
 * dynamic scaling, and crash diagnostics to AI agents (Claude Desktop, Cursor, Antigravity).
 * 
 * Supports standard JSON-RPC 2.0 over stdio following the MCP Specification (2024-11-05).
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createInterface } from "node:readline";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { constants as osConstants, homedir } from "node:os";

const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

// Security: Path containment and service name validation
function isValidServiceName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-zA-Z0-9._-]+$/.test(name) &&
    !name.startsWith("-") &&
    name !== "." &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function isPathContained(targetPath: string, parentDir: string): boolean {
  try {
    const resolvedParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
    const resolvedTarget = resolve(targetPath);
    if (!(resolvedTarget.startsWith(resolvedParent + sep) || resolvedTarget === resolvedParent)) {
      return false;
    }
    if (existsSync(targetPath)) {
      const st = lstatSync(targetPath);
      if (st.isSymbolicLink()) return false;
      const realTarget = realpathSync(targetPath);
      return realTarget.startsWith(resolvedParent + sep) || realTarget === resolvedParent;
    }
    const targetParent = dirname(resolvedTarget);
    if (existsSync(targetParent)) {
      const realTargetParent = realpathSync(targetParent);
      return realTargetParent.startsWith(resolvedParent + sep) || realTargetParent === resolvedParent;
    }
    return true;
  } catch {
    return false;
  }
}

function readTailBounded(filePath: string, maxLines: number, maxBytes = 256 * 1024): string {
  let fd: number | undefined;
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return "";
    fd = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size === 0) return "";
    const bytesToRead = Math.min(fdStat.size, maxBytes);
    const offset = fdStat.size - bytesToRead;
    const buf = Buffer.allocUnsafe(bytesToRead);
    let total = 0;
    while (total < bytesToRead) {
      const n = readSync(fd, buf, total, bytesToRead - total, offset + total);
      if (n <= 0) break;
      total += n;
    }
    let text = buf.subarray(0, total).toString("utf-8");
    if (offset > 0) {
      const idx = text.indexOf("\n");
      text = idx >= 0 ? text.slice(idx + 1) : text;
    }
    const clampedLines = Number.isFinite(maxLines) ? Math.max(1, Math.min(5000, Math.floor(maxLines))) : 50;
    return text.split("\n").slice(-clampedLines).join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

import { listServices } from "../utils/service-discovery.js";
import { getPlatformInfo } from "../platform/detect.js";
import { getCrashState, forceResetCircuit, formatCrashState } from "../utils/crash-tracker.js";
import { stopCommand } from "../commands/stop.js";
import { restartCommand } from "../commands/restart.js";
import { reloadCommand } from "../commands/reload.js";
import { scaleCommand } from "../commands/scale.js";
import { deleteCommand } from "../commands/delete.js";
import { flushCommand } from "../commands/flush.js";
import { sendSignalCommand } from "../commands/send-signal.js";
import { readAuditEvents, recordAuditEvent } from "../utils/audit-log.js";
import { generateCaddyConfig, generateNginxConfig } from "../utils/proxy-config.js";
import { generateGrafanaDashboard } from "../utils/grafana-export.js";

export const MUTATING_MCP_TOOLS = new Set([
  "bs9_restart_process",
  "bs9_reload_process",
  "bs9_scale_process",
  "bs9_stop_process",
  "bs9_delete_process",
  "bs9_reset_crash",
  "bs9_flush_logs",
  "bs9_send_signal",
]);

const SENSITIVE_KEY_RE = /secret|token|password|passwd|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|encryption[_-]?key|master[_-]?key|credential|auth|cookie|session[_-]?id|jwt|bearer|database_url|db_url|redis_url|mongo_uri|postgres_url|connection_string/i;
const INLINE_SECRET_ASSIGN_RE = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_KEY|PRIVATE_KEY|ACCESS_KEY|ENCRYPTION_KEY|MASTER_KEY|CREDENTIAL|AUTH|COOKIE|SESSION_ID|JWT|CONNECTION_STRING|DATABASE_URL|DB_URL|REDIS_URL|MONGO_URI|POSTGRES_URL)[A-Z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'`]+))/gi;
const INLINE_FLAG_SECRET_RE = /(--?(?:token|password|passwd|secret|api-key|apikey|auth)(?:=|\s+))(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'`]+))/gi;
const INLINE_URI_CRED_RE = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi;
const INLINE_BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi;

export function redactSensitiveText(text: string): string {
  return text
    .replace(INLINE_SECRET_ASSIGN_RE, "$1=***REDACTED***")
    .replace(INLINE_FLAG_SECRET_RE, "$1***REDACTED***")
    .replace(INLINE_URI_CRED_RE, "$1***REDACTED***$3")
    .replace(INLINE_BEARER_RE, "$1***REDACTED***");
}

export function redactSensitiveEnv<T>(input: T): T {
  if (typeof input === "string") {
    return redactSensitiveText(input) as unknown as T;
  }
  if (input === null || input === undefined || typeof input !== "object") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveEnv(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k) && typeof v === "string" && v.length > 0) {
      out[k] = "***REDACTED***";
    } else if (typeof v === "string") {
      out[k] = redactSensitiveText(v);
    } else if (v && typeof v === "object") {
      out[k] = redactSensitiveEnv(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface McpServerOptions {
  readOnly?: boolean;
}

export const MCP_TOOLS = [
  {
    name: "bs9_list_processes",
    description: "List all services managed by BS9, including their status, PID, CPU, memory, uptime, and tasks.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bs9_describe_process",
    description: "Get detailed runtime metadata, configuration, environment variables, and crash tracking for a specific process.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The service name" }
      },
      required: ["name"]
    }
  },
  {
    name: "bs9_tail_logs",
    description: "Retrieve recent stdout and stderr log lines for a specific process or all processes combined.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (optional - if omitted, combined logs for all services)" },
        lines: { type: "number", description: "Number of lines to read (default 50)", default: 50 }
      }
    }
  },
  {
    name: "bs9_restart_process",
    description: "Restart a specific managed service or all services.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (or 'all')", default: "all" }
      }
    }
  },
  {
    name: "bs9_reload_process",
    description: "Perform zero-downtime rolling reload for clustered services, or graceful restart for single services.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service or cluster name (default 'all')", default: "all" }
      }
    }
  },
  {
    name: "bs9_scale_process",
    description: "Dynamically scale the number of cluster workers up or down without taking down the application.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The cluster base name" },
        instances: { type: "string", description: "Target instance count (e.g. '4', '+2', '-1')" }
      },
      required: ["name", "instances"]
    }
  },
  {
    name: "bs9_stop_process",
    description: "Stop a running service or all services gracefully.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (or 'all')" }
      },
      required: ["name"]
    }
  },
  {
    name: "bs9_delete_process",
    description: "Stop and permanently remove a service from BS9 process management.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" }
      },
      required: ["name"]
    }
  },
  {
    name: "bs9_diagnose_crash",
    description: "Analyze crash history, circuit breaker state, recent exit codes, and stderr traces to diagnose why a service failed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name to diagnose" }
      },
      required: ["name"]
    }
  },
  {
    name: "bs9_reset_crash",
    description: "Reset circuit breaker state, exponential backoff delay, and crash history for a service.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name" }
      },
      required: ["name"]
    }
  },
  {
    name: "bs9_flush_logs",
    description: "Empty and truncate log files for a specific service or all services.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (optional - if omitted, flushes all)" }
      }
    }
  },
  {
    name: "bs9_send_signal",
    description: "Send an OS signal (SIGUSR2, SIGINT, SIGTERM, SIGKILL) to a service process.",
    inputSchema: {
      type: "object",
      properties: {
        signal: { type: "string", description: "Signal name (e.g. SIGUSR2, SIGINT)" },
        name: { type: "string", description: "Target service name" }
      },
      required: ["signal", "name"]
    }
  },
  {
    name: "bs9_doctor",
    description: "Run environment and platform health diagnostics (Bun version, platform info, permissions, storage paths).",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bs9_get_issues",
    description: "Inspect runtime bugs, unhandled exceptions, and stack traces across services or for a specific service (PM2 Plus parity).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Service name (optional - if omitted, returns issues for all services)" },
        lines: { type: "number", description: "Number of log lines to analyze (default 100)", default: 100 }
      }
    }
  },
  {
    name: "bs9_audit_log",
    description: "Read recent tamper-safe security and lifecycle audit log events (who triggered start/stop/restart/login/mcp actions).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return (default 50)", default: 50 },
        action: { type: "string", description: "Optional action filter (e.g. start, web_login, bs9_restart_process)" }
      }
    }
  },
  {
    name: "bs9_export_config",
    description: "Generate hardened Nginx, Caddy, or Grafana configuration in memory without modifying the filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["nginx", "caddy", "grafana"], description: "Target format: nginx, caddy, or grafana" },
        serviceName: { type: "string", description: "Service name (default: app)" },
        domain: { type: "string", description: "Public domain name (for nginx/caddy)" },
        port: { type: "number", description: "Backend port (default: 3000)" },
        ssl: { type: "boolean", description: "Enable TLS block for nginx" }
      },
      required: ["format"]
    }
  }
];

export async function handleToolCall(
  name: string,
  args: Record<string, any> = {},
  options: McpServerOptions = {}
): Promise<string> {
  const isReadOnly = options.readOnly ?? process.env.BS9_MCP_READONLY === "true";
  const targetForAudit = typeof args?.name === "string" ? args.name : "all";
  if (isReadOnly && MUTATING_MCP_TOOLS.has(name)) {
    recordAuditEvent({
      action: name,
      target: targetForAudit,
      status: "denied",
      actor: "mcp-agent",
      details: "blocked_by_readonly_mode",
    });
    throw new Error(`Security: Tool '${name}' is blocked in BS9 MCP read-only mode`);
  }

  const platformInfo = getPlatformInfo();
  const isMutating = MUTATING_MCP_TOOLS.has(name);

  try {
    let resultText: string;

    switch (name) {
      case "bs9_list_processes": {
        const services = await listServices();
        resultText = JSON.stringify(redactSensitiveEnv(services), null, 2);
        break;
      }

      case "bs9_audit_log": {
        const rawLimit = Number(args.limit);
        const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 50;
        const actionFilter = typeof args.action === "string" && args.action.trim() ? args.action.trim().toLowerCase() : null;
        let events = readAuditEvents(actionFilter ? 1000 : limit);
        if (actionFilter) {
          events = events.filter((e) => e.action.toLowerCase() === actionFilter).slice(-limit);
        }
        resultText = JSON.stringify(events, null, 2);
        break;
      }

      case "bs9_export_config": {
        const format = String(args.format || "").toLowerCase();
        const serviceName = String(args.serviceName || "app");
        if (format === "grafana") {
          resultText = generateGrafanaDashboard({ serviceName });
          break;
        }
        const rawPort = Number(args.port);
        const port = Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? Math.floor(rawPort) : 3000;
        const domain = String(args.domain || "localhost");
        if (format === "nginx") {
          resultText = generateNginxConfig({
            serviceName,
            domain,
            upstreams: [{ host: "127.0.0.1", port }],
            ssl: Boolean(args.ssl),
          });
          break;
        }
        if (format === "caddy") {
          resultText = generateCaddyConfig({
            serviceName,
            domain,
            upstreams: [{ host: "127.0.0.1", port }],
          });
          break;
        }
        throw new Error(`Unsupported export format '${format}'. Use nginx, caddy, or grafana.`);
      }

      case "bs9_describe_process": {
        const target = args.name;
        if (typeof target !== "string" || !target) throw new Error("Missing or invalid 'name' argument");
        const clean = target.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${target}'`);
        const all = await listServices();
        const service = all.find(s => {
          const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
          return s.name === target || sClean === clean;
        });

        const crash = getCrashState(clean);

        let metadata: any = null;
        if (platformInfo.isWindows) {
          const servicesDir = join(homedir(), ".bs9", "services");
          const metaPath = join(servicesDir, `BS9_${clean}.json`);
          if (isPathContained(metaPath, servicesDir) && existsSync(metaPath)) {
            try { metadata = JSON.parse(readFileSync(metaPath, "utf-8")); } catch {}
          }
        }

        resultText = JSON.stringify({
          service: redactSensitiveEnv(service || { name: target, status: "stopped" }),
          crashTracker: crash ? {
            state: crash.state,
            consecutiveCrashes: crash.consecutiveCrashes,
            formatted: formatCrashState(crash),
            backoffMs: crash.backoffMs,
            recentCrashes: crash.crashes
          } : null,
          metadata: metadata ? redactSensitiveEnv(metadata) : null
        }, null, 2);
        break;
      }

      case "bs9_tail_logs": {
        const logDir = platformInfo.logDir;
        const rawLines = Number(args.lines);
        const count = Number.isFinite(rawLines) ? Math.max(1, Math.min(5000, Math.floor(rawLines))) : 50;
        const targetName = args.name;

        if (!existsSync(logDir)) {
          resultText = "No log directory found.";
          break;
        }

        if (targetName !== undefined && targetName !== null && targetName !== "") {
          if (typeof targetName !== "string") throw new Error("Invalid 'name' argument");
          const clean = targetName.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${targetName}'`);
          const prefix = platformInfo.isWindows ? `BS9_${clean}` : platformInfo.isMacOS ? `bs9.${clean}` : clean;
          const outPath = join(logDir, `${prefix}.out.log`);
          const errPath = join(logDir, `${prefix}.err.log`);

          if (!isPathContained(outPath, logDir) || !isPathContained(errPath, logDir)) {
            throw new Error("Access denied: path traversal detected");
          }

          let result = `=== LOGS FOR '${targetName}' (last ${count} lines) ===\n\n`;
          if (existsSync(outPath)) {
            const lines = redactSensitiveText(readTailBounded(outPath, count));
            result += `--- STDOUT ---\n${lines}\n\n`;
          }
          if (existsSync(errPath)) {
            const lines = redactSensitiveText(readTailBounded(errPath, count));
            result += `--- STDERR ---\n${lines}\n`;
          }
          resultText = result;
        } else {
          const files = readdirSync(logDir).filter(f => f.endsWith(".out.log") || f.endsWith(".err.log"));
          let result = `=== COMBINED LOGS (last ${count} lines each) ===\n\n`;
          for (const file of files) {
            const filePath = join(logDir, file);
            if (!isPathContained(filePath, logDir)) continue;
            const content = redactSensitiveText(readTailBounded(filePath, count));
            result += `--- [${file}] ---\n${content}\n\n`;
          }
          resultText = result;
        }
        break;
      }

      case "bs9_restart_process": {
        const target = args.name === undefined ? "all" : args.name;
        if (typeof target !== "string") throw new Error("Invalid 'name' argument");
        if (target !== "all") {
          const clean = target.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${target}'`);
        }
        await restartCommand([target], { force: true });
        resultText = `Restarted '${target}' successfully.`;
        break;
      }

      case "bs9_reload_process": {
        const target = args.name === undefined ? "all" : args.name;
        if (typeof target !== "string") throw new Error("Invalid 'name' argument");
        if (target !== "all") {
          const clean = target.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${target}'`);
        }
        await reloadCommand([target], { force: true });
        resultText = `Zero-downtime reload for '${target}' completed.`;
        break;
      }

      case "bs9_scale_process": {
        if (typeof args.name !== "string" || !args.name || args.instances === undefined || args.instances === null) {
          throw new Error("name and instances required");
        }
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        await scaleCommand(args.name, String(args.instances));
        resultText = `Scaled '${args.name}' to ${args.instances} worker(s).`;
        break;
      }

      case "bs9_stop_process": {
        if (typeof args.name !== "string" || !args.name) throw new Error("Missing or invalid 'name' argument");
        if (args.name !== "all") {
          const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        }
        await stopCommand([args.name], { force: true });
        resultText = `Stopped '${args.name}' successfully.`;
        break;
      }

      case "bs9_delete_process": {
        if (typeof args.name !== "string" || !args.name) throw new Error("Missing or invalid 'name' argument");
        if (args.name !== "all") {
          const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        }
        await deleteCommand([args.name], { force: true, remove: true });
        resultText = `Deleted '${args.name}' successfully.`;
        break;
      }

      case "bs9_diagnose_crash": {
        if (typeof args.name !== "string" || !args.name) throw new Error("Missing or invalid 'name' argument");
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        const crash = getCrashState(clean);
        const logDir = platformInfo.logDir;
        const prefix = platformInfo.isWindows ? `BS9_${clean}` : platformInfo.isMacOS ? `bs9.${clean}` : clean;
        const errPath = join(logDir, `${prefix}.err.log`);
        if (!isPathContained(errPath, logDir)) {
          throw new Error("Access denied: path traversal detected");
        }

        let lastErrorLines = "No error log available.";
        if (existsSync(errPath)) {
          lastErrorLines = redactSensitiveText(readTailBounded(errPath, 30)) || "No error log available.";
        }

        resultText = JSON.stringify({
          service: clean,
          circuitBreaker: crash.state,
          consecutiveCrashes: crash.consecutiveCrashes,
          backoffDelaySeconds: crash.backoffMs / 1000,
          crashHistory: crash.crashes,
          recentStderr: lastErrorLines,
          diagnosisSummary: crash.state === "circuit-open"
            ? `Circuit breaker is OPEN due to ${crash.crashes.length} crashes within 60 seconds. Fix the underlying crash before resetting with 'bs9_reset_crash'.`
            : crash.consecutiveCrashes > 0
              ? `Service experienced ${crash.consecutiveCrashes} crash(es). Currently in exponential backoff delay of ${crash.backoffMs / 1000}s.`
              : `Service is healthy with 0 consecutive crashes.`
        }, null, 2);
        break;
      }

      case "bs9_reset_crash": {
        if (typeof args.name !== "string" || !args.name) throw new Error("Missing or invalid 'name' argument");
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        forceResetCircuit(clean);
        resultText = `Reset crash tracking and circuit breaker for '${clean}'.`;
        break;
      }

      case "bs9_flush_logs": {
        if (args.name !== undefined && args.name !== null && args.name !== "") {
          if (typeof args.name !== "string") throw new Error("Invalid 'name' argument");
          const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
          if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        }
        await flushCommand(args.name);
        resultText = `Flushed logs for ${args.name || "all services"}.`;
        break;
      }

      case "bs9_send_signal": {
        if (typeof args.signal !== "string" || !args.signal || typeof args.name !== "string" || !args.name) {
          throw new Error("signal and name are required strings");
        }
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
        const trimmedSig = args.signal.trim();
        const allowedSignals = new Set([
          "SIGINT", "SIGTERM", "SIGKILL", "SIGUSR1", "SIGUSR2",
          "SIGHUP", "SIGQUIT", "SIGCONT", "SIGSTOP", "SIGABRT",
          "SIGALRM", "SIGPIPE", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGWINCH"
        ]);
        if (/^\d+$/.test(trimmedSig)) {
          const sigNum = parseInt(trimmedSig, 10);
          if (sigNum < 1 || sigNum > 31) throw new Error(`Invalid signal number: ${sigNum}`);
          const sigEntry = Object.entries(osConstants.signals).find(([, num]) => num === sigNum);
          if (!sigEntry || !allowedSignals.has(sigEntry[0])) {
            throw new Error(`Signal '${args.signal}' is not allowed`);
          }
        } else {
          const formatted = trimmedSig.toUpperCase().startsWith("SIG") ? trimmedSig.toUpperCase() : `SIG${trimmedSig.toUpperCase()}`;
          if (!allowedSignals.has(formatted)) throw new Error(`Signal '${args.signal}' is not allowed`);
        }
        const allServices = await listServices();
        const matched = allServices.filter(s => {
          const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
          const isWorker = sClean.startsWith(`${clean}-`) && /^\d+$/.test(sClean.slice(clean.length + 1));
          return sClean === clean || isWorker;
        });
        if (matched.length === 0) {
          throw new Error(`No running services found matching '${args.name}'`);
        }
        await sendSignalCommand(args.signal, args.name);
        resultText = `Sent signal ${args.signal} to '${args.name}'.`;
        break;
      }

      case "bs9_doctor": {
        resultText = JSON.stringify({
          status: "healthy",
          bunVersion: typeof Bun !== "undefined" ? Bun.version : "N/A",
          nodeVersion: process.version,
          platform: platformInfo.platform,
          serviceManager: platformInfo.serviceManager,
          directories: {
            configDir: platformInfo.configDir,
            logDir: platformInfo.logDir,
            serviceDir: platformInfo.serviceDir
          },
          uptime: process.uptime(),
          memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
        }, null, 2);
        break;
      }

      case "bs9_get_issues": {
        const { parseErrorLogs } = await import("../commands/issues.js");
        const logDir = platformInfo.logDir;
        if (!existsSync(logDir)) {
          resultText = "[]";
          break;
        }

        const allServices = await listServices();
        const targetName = args.name;
        if (targetName !== undefined && targetName !== null && typeof targetName !== "string") {
          throw new Error("Invalid 'name' argument");
        }
        const targetServices = targetName
          ? allServices.filter(s => {
              const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
              const tClean = targetName.replace(/^(BS9_|bs9\.)/, "");
              const escaped = tClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              return s.name === targetName || clean === tClean || new RegExp(`^${escaped}-\\d+(-g\\d+)?$`).test(clean);
            })
          : allServices;

        const rawLines = Number(args.lines);
        const maxLines = Number.isFinite(rawLines) ? Math.max(1, Math.min(5000, Math.floor(rawLines))) : 100;
        const issues: any[] = [];
        const seen = new Set<string>();

        for (const svc of targetServices) {
          const clean = svc.name.replace(/^(BS9_|bs9\.)/, "");
          if (seen.has(clean)) continue;
          seen.add(clean);

          const prefix = platformInfo.isWindows ? `BS9_${clean}` : platformInfo.isMacOS ? `bs9.${clean}` : clean;
          const errPath = join(logDir, `${prefix}.err.log`);
          if (!isPathContained(errPath, logDir)) continue;
          const crash = getCrashState(clean);

          if (existsSync(errPath)) {
            const recentLines = redactSensitiveText(readTailBounded(errPath, maxLines));
            const parsed = parseErrorLogs(recentLines, clean);
            for (const p of parsed) {
              p.crashCount = crash.consecutiveCrashes;
              p.circuitState = crash.state;
              issues.push(redactSensitiveEnv(p));
            }
          }
        }

        resultText = JSON.stringify(issues, null, 2);
        break;
      }

      default:
        throw new Error(`Unknown BS9 MCP tool: ${name}`);
    }

    if (isMutating) {
      recordAuditEvent({
        action: name,
        target: targetForAudit,
        status: "success",
        actor: "mcp-agent",
      });
    }
    return resultText;
  } catch (err: any) {
    if (isMutating) {
      recordAuditEvent({
        action: name,
        target: targetForAudit,
        status: "failure",
        actor: "mcp-agent",
        details: err?.message ? String(err.message) : "error",
      });
    }
    throw err;
  }
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const isReadOnly = options.readOnly ?? process.env.BS9_MCP_READONLY === "true";
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (msg: any) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  let requestQueue: Promise<void> = Promise.resolve();

  const processLine = async (line: string) => {
    if (!line.trim()) return;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" }
      });
      return;
    }

    if (!request || typeof request !== "object" || Array.isArray(request)) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      });
      return;
    }

    const { id, method, params } = request;
    const isNotification = id === undefined;

    try {
      if (method === "initialize") {
        if (!isNotification) {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: "bs9-mcp",
                version: "1.7.1"
              }
            }
          });
        }
      } else if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) {
        // Client notification, no response needed
      } else if (method === "ping") {
        if (!isNotification) send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        if (!isNotification) {
          const tools = isReadOnly
            ? MCP_TOOLS.filter((t) => !MUTATING_MCP_TOOLS.has(t.name))
            : MCP_TOOLS;
          send({
            jsonrpc: "2.0",
            id,
            result: {
              tools
            }
          });
        }
      } else if (method === "tools/call") {
        const toolName = params?.name;
        const rawArgs = params?.arguments;
        if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
          if (!isNotification) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Invalid params: arguments must be a plain object" }
            });
          }
          return;
        }
        const toolArgs = rawArgs || {};
        // Redirect console.log/info to stderr during tool execution so delegated CLI commands never corrupt stdio JSON-RPC
        const origLog = console.log;
        const origInfo = console.info;
        console.log = (...a: any[]) => console.error(...a);
        console.info = (...a: any[]) => console.error(...a);
        try {
          const output = await handleToolCall(toolName, toolArgs, { readOnly: isReadOnly });
          if (!isNotification) {
            send({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: output
                  }
                ]
              }
            });
          }
        } catch (err: any) {
          if (!isNotification) {
            send({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Error executing ${toolName}: ${err.message}`
                  }
                ],
                isError: true
              }
            });
          }
        } finally {
          console.log = origLog;
          console.info = origInfo;
        }
      } else {
        if (!isNotification) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method '${method}' not found` }
          });
        }
      }
    } catch (err: any) {
      if (!isNotification) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message || "Internal error" }
        });
      }
    }
  };

  rl.on("line", (line) => {
    requestQueue = requestQueue.then(() => processLine(line)).catch((err) => {
      process.stderr.write(`MCP line handler error: ${err?.message || err}\n`);
    });
  });

  process.stderr.write("BS9 Model Context Protocol (MCP) Server running on stdio.\n");
}
