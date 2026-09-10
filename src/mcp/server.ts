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
 * Licensed under the MIT License
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Security: Path containment and service name validation
function isValidServiceName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length <= 64 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function isPathContained(targetPath: string, parentDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedParent = resolve(parentDir);
  return resolvedTarget.startsWith(resolvedParent + sep) || resolvedTarget === resolvedParent;
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
  }
];

export async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<string> {
  const platformInfo = getPlatformInfo();

  switch (name) {
    case "bs9_list_processes": {
      const services = await listServices();
      return JSON.stringify(services, null, 2);
    }

    case "bs9_describe_process": {
      const target = args.name;
      if (!target) throw new Error("Missing 'name' argument");
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

      return JSON.stringify({
        service: service || { name: target, status: "stopped" },
        crashTracker: crash ? {
          state: crash.state,
          consecutiveCrashes: crash.consecutiveCrashes,
          formatted: formatCrashState(crash),
          backoffMs: crash.backoffMs,
          recentCrashes: crash.crashes
        } : null,
        metadata: metadata || null
      }, null, 2);
    }

    case "bs9_tail_logs": {
      const logDir = platformInfo.logDir;
      const count = Number(args.lines) || 50;
      const targetName = args.name;

      if (!existsSync(logDir)) return "No log directory found.";

      if (targetName) {
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
          const lines = readFileSync(outPath, "utf-8").split("\n").slice(-count).join("\n");
          result += `--- STDOUT ---\n${lines}\n\n`;
        }
        if (existsSync(errPath)) {
          const lines = readFileSync(errPath, "utf-8").split("\n").slice(-count).join("\n");
          result += `--- STDERR ---\n${lines}\n`;
        }
        return result;
      } else {
        const files = readdirSync(logDir).filter(f => f.endsWith(".out.log") || f.endsWith(".err.log"));
        let result = `=== COMBINED LOGS (last ${count} lines each) ===\n\n`;
        for (const file of files) {
          const content = readFileSync(join(logDir, file), "utf-8").split("\n").slice(-count).join("\n");
          result += `--- [${file}] ---\n${content}\n\n`;
        }
        return result;
      }
    }

    case "bs9_restart_process": {
      const target = args.name || "all";
      if (target !== "all") {
        const clean = target.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${target}'`);
      }
      await restartCommand([target], { force: true });
      return `Restarted '${target}' successfully.`;
    }

    case "bs9_reload_process": {
      const target = args.name || "all";
      if (target !== "all") {
        const clean = target.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${target}'`);
      }
      await reloadCommand([target], { force: true });
      return `Zero-downtime reload for '${target}' completed.`;
    }

    case "bs9_scale_process": {
      if (!args.name || !args.instances) throw new Error("name and instances required");
      const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
      if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
      await scaleCommand(args.name, String(args.instances));
      return `Scaled '${args.name}' to ${args.instances} worker(s).`;
    }

    case "bs9_stop_process": {
      if (!args.name) throw new Error("Missing 'name' argument");
      if (args.name !== "all") {
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
      }
      await stopCommand([args.name], { force: true });
      return `Stopped '${args.name}' successfully.`;
    }

    case "bs9_delete_process": {
      if (!args.name) throw new Error("Missing 'name' argument");
      if (args.name !== "all") {
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
      }
      await deleteCommand([args.name], { force: true, remove: true });
      return `Deleted '${args.name}' successfully.`;
    }

    case "bs9_diagnose_crash": {
      const clean = (args.name || "").replace(/^(BS9_|bs9\.)/, "");
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
        lastErrorLines = readFileSync(errPath, "utf-8").split("\n").slice(-30).join("\n");
      }

      return JSON.stringify({
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
    }

    case "bs9_reset_crash": {
      const clean = (args.name || "").replace(/^(BS9_|bs9\.)/, "");
      if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
      forceResetCircuit(clean);
      return `Reset crash tracking and circuit breaker for '${clean}'.`;
    }

    case "bs9_flush_logs": {
      if (args.name) {
        const clean = args.name.replace(/^(BS9_|bs9\.)/, "");
        if (!isValidServiceName(clean)) throw new Error(`Invalid service name: '${args.name}'`);
      }
      await flushCommand(args.name);
      return `Flushed logs for ${args.name || "all services"}.`;
    }

    case "bs9_send_signal": {
      if (!args.signal || !args.name) throw new Error("signal and name are required");
      await sendSignalCommand(args.signal, args.name);
      return `Sent signal ${args.signal} to '${args.name}'.`;
    }

    case "bs9_doctor": {
      return JSON.stringify({
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
    }

    case "bs9_get_issues": {
      const { parseErrorLogs } = await import("../commands/issues.js");
      const logDir = platformInfo.logDir;
      if (!existsSync(logDir)) return "[]";

      const allServices = await listServices();
      const targetName = args.name;
      const targetServices = targetName
        ? allServices.filter(s => {
            const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
            const tClean = targetName.replace(/^(BS9_|bs9\.)/, "");
            return s.name === targetName || clean === tClean || clean.startsWith(`${tClean}-`);
          })
        : allServices;

      const maxLines = Number(args.lines) || 100;
      const issues: any[] = [];
      const seen = new Set<string>();

      for (const svc of targetServices) {
        const clean = svc.name.replace(/^(BS9_|bs9\.)/, "");
        if (seen.has(clean)) continue;
        seen.add(clean);

        const prefix = platformInfo.isWindows ? `BS9_${clean}` : platformInfo.isMacOS ? `bs9.${clean}` : clean;
        const errPath = join(logDir, `${prefix}.err.log`);
        const crash = getCrashState(clean);

        if (existsSync(errPath)) {
          const content = readFileSync(errPath, "utf-8");
          const recentLines = content.split("\n").slice(-maxLines).join("\n");
          const parsed = parseErrorLogs(recentLines, clean);
          for (const p of parsed) {
            p.crashCount = crash.consecutiveCrashes;
            p.circuitState = crash.state;
            issues.push(p);
          }
        }
      }

      return JSON.stringify(issues, null, 2);
    }

    default:
      throw new Error(`Unknown BS9 MCP tool: ${name}`);
  }
}

export async function runMcpServer(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (msg: any) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  rl.on("line", async (line) => {
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

    const { id, method, params } = request;

    try {
      if (method === "initialize") {
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
              version: "1.6.0"
            }
          }
        });
      } else if (method === "notifications/initialized") {
        // Client ack, no response needed
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS
          }
        });
      } else if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const output = await handleToolCall(toolName, toolArgs);
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
        } catch (err: any) {
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
      } else {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method '${method}' not found` }
        });
      }
    } catch (err: any) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message || "Internal error" }
      });
    }
  });

  process.stderr.write("BS9 Model Context Protocol (MCP) Server running on stdio.\n");
}
