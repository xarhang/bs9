#!/usr/bin/env bun

/**
 * BS9 - Issues & Exception Tracker Dashboard
 * 
 * Inspects, parses, and aggregates runtime bugs, crashes, stack traces, and unhandled exceptions.
 * Equivalent to PM2 Plus "Issue Dashboard" ($39/mo) — 100% Free & Built-in for BS9.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { listServices } from "../utils/service-discovery.js";
import { getCrashState, forceResetCircuit } from "../utils/crash-tracker.js";
import { escapeRegExp } from "../utils/array-parser.js";

function isValidServiceName(name: string): boolean {
  const clean = name.replace(/^(BS9_|bs9\.)/, "");
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(clean) && clean.length <= 64 && !clean.includes('..') && !clean.includes('/');
}

export interface ParsedIssue {
  service: string;
  errorType: string;
  message: string;
  fileLocation?: string;
  stackTrace: string[];
  crashCount: number;
  circuitState: string;
  suggestedFix?: string;
  timestamp?: string;
}

export interface IssuesOptions {
  clear?: boolean;
  json?: boolean;
  lines?: string;
}

export function parseErrorLogs(rawContent: string, serviceName: string): ParsedIssue[] {
  if (!rawContent || !rawContent.trim()) return [];

  const lines = rawContent.split("\n");
  const issues: ParsedIssue[] = [];

  let currentError: Partial<ParsedIssue> | null = null;
  let currentStack: string[] = [];

  const flushCurrent = () => {
    if (currentError && currentError.message) {
      issues.push({
        service: serviceName,
        errorType: currentError.errorType || "Error",
        message: currentError.message,
        fileLocation: currentError.fileLocation,
        stackTrace: currentStack.slice(0, 10),
        crashCount: 0,
        circuitState: "unknown",
        suggestedFix: generateDiagnosticHint(currentError.errorType || "", currentError.message)
      });
      currentError = null;
      currentStack = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect JavaScript/TypeScript/Bun error
    const jsErrorMatch = trimmed.match(/^(?:\[.*?\]\s*)?([A-Z][a-zA-Z0-9_]*(?:Error|Exception)?):\s*(.*)$/);
    // Detect Python Traceback
    const pyTraceback = trimmed.includes("Traceback (most recent call last):");
    // Detect Go panic
    const goPanic = trimmed.startsWith("panic:");

    if (jsErrorMatch || pyTraceback || goPanic) {
      flushCurrent();

      if (jsErrorMatch) {
        currentError = {
          errorType: jsErrorMatch[1],
          message: jsErrorMatch[2]
        };
      } else if (pyTraceback) {
        currentError = {
          errorType: "PythonTraceback",
          message: "Unhandled Python Exception"
        };
      } else if (goPanic) {
        currentError = {
          errorType: "GoPanic",
          message: trimmed.replace("panic:", "").trim()
        };
      }
      continue;
    }

    // Stack line or location
    if (currentError) {
      currentStack.push(trimmed);
      if (!currentError.fileLocation) {
        const atMatch = trimmed.match(/at\s+(?:.*?\(|)(.+?:\d+(?::\d+)?)\)?$/);
        const pyFileMatch = trimmed.match(/File "(.+?)", line (\d+)/);
        if (atMatch) {
          currentError.fileLocation = atMatch[1];
        } else if (pyFileMatch) {
          currentError.fileLocation = `${pyFileMatch[1]}:${pyFileMatch[2]}`;
        }
      }
    }
  }

  flushCurrent();

  // If no structured error could be parsed but content exists, treat last few lines as an issue
  if (issues.length === 0 && lines.filter(l => l.trim()).length > 0) {
    const lastLines = lines.filter(l => l.trim()).slice(-5);
    issues.push({
      service: serviceName,
      errorType: "ProcessCrashLog",
      message: lastLines[lastLines.length - 1],
      stackTrace: lastLines,
      crashCount: 0,
      circuitState: "unknown",
      suggestedFix: generateDiagnosticHint("General", lastLines[lastLines.length - 1])
    });
  }

  return issues;
}

function generateDiagnosticHint(errorType: string, msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("econnrefused")) {
    return "💡 Database or remote service is unreachable. Verify host, port, and network credentials.";
  }
  if (m.includes("eaddrinuse")) {
    return "💡 Port is already bound by another process. Kill conflicting process or configure a different port.";
  }
  if (m.includes("cannot find module") || m.includes("modulenotfounderror")) {
    return "💡 Missing package or module dependency. Run 'bun install' or install the missing module.";
  }
  if (m.includes("out of memory") || m.includes("heap limit")) {
    return "💡 Out of memory crash. Check for memory leaks or use '--max-memory-restart' to auto-heal.";
  }
  if (m.includes("permission denied") || m.includes("eacces")) {
    return "💡 File system or port permission denied. Check file permissions or use port >= 1024.";
  }
  if (errorType === "TypeError") {
    return "💡 Type error in code. Check for undefined or null variables before accessing properties.";
  }
  if (errorType === "SyntaxError") {
    return "💡 Code syntax error. Inspect indicated line number and rebuild or format source code.";
  }
  return "💡 Inspect error trace and application logic around the failure location.";
}

export async function issuesCommand(name?: string, options: IssuesOptions = {}): Promise<void> {
  const platformInfo = getPlatformInfo();
  const logDir = platformInfo.logDir;

  if (!existsSync(logDir)) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("📋 No BS9 logs directory found. No issues detected.");
    return;
  }

  // If --clear requested:
  if (options.clear) {
    const files = readdirSync(logDir).filter(f => f.endsWith(".err.log"));
    const tClean = name ? name.replace(/^(BS9_|bs9\.)/, "") : "";
    let cleared = 0;
    for (const f of files) {
      if (!name) {
        writeFileSync(join(logDir, f), "");
        cleared++;
      } else {
        const fileBase = f.replace(/\.err\.log$/, "").replace(/^(BS9_|bs9\.)/, "");
        const isWorker = new RegExp(`^${tClean}-\\d+$`).test(fileBase);
        if (fileBase === tClean || isWorker) {
          writeFileSync(join(logDir, f), "");
          cleared++;
        }
      }
    }
    if (name) {
      forceResetCircuit(tClean);
    }
    console.log(`🧹 Cleared error logs and reset issue records (${cleared} file(s) truncated).`);
    return;
  }

  if (name && !isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const allServices = await listServices();
  const targetServices = name
    ? allServices.filter(s => {
        const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
        const tClean = name.replace(/^(BS9_|bs9\.)/, "");
        const safeTClean = escapeRegExp(tClean);
        const isWorker = new RegExp(`^${safeTClean}-\\d+$`).test(clean);
        return s.name === name || clean === tClean || isWorker;
      })
    : allServices;

  const maxLines = Number(options.lines) || 100;
  const allIssues: ParsedIssue[] = [];

  // Check services
  const checkedNames = new Set<string>();

  for (const svc of targetServices) {
    const clean = svc.name.replace(/^(BS9_|bs9\.)/, "");
    if (checkedNames.has(clean)) continue;
    checkedNames.add(clean);

    const prefix = platformInfo.isWindows ? `BS9_${clean}` : platformInfo.isMacOS ? `bs9.${clean}` : clean;
    const errPath = join(logDir, `${prefix}.err.log`);
    const crash = getCrashState(clean);

    if (existsSync(errPath)) {
      const content = readFileSync(errPath, "utf-8");
      const recentLines = content.split("\n").slice(-maxLines).join("\n");
      const parsed = parseErrorLogs(recentLines, clean);

      for (const issue of parsed) {
        issue.crashCount = crash.consecutiveCrashes;
        issue.circuitState = crash.state;
        allIssues.push(issue);
      }
    } else if (crash.consecutiveCrashes > 0) {
      allIssues.push({
        service: clean,
        errorType: "CrashLoop",
        message: `Service encountered ${crash.consecutiveCrashes} crash(es). State: ${crash.state}`,
        stackTrace: [],
        crashCount: crash.consecutiveCrashes,
        circuitState: crash.state,
        suggestedFix: "💡 Inspect service startup script and runtime logs."
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(allIssues, null, 2));
    return;
  }

  console.log("\n================================================================================");
  console.log("🐛 BS9 Issue & Exception Dashboard (Free PM2 Plus Parity)");
  console.log("================================================================================");

  if (allIssues.length === 0) {
    console.log("\n✨ No active issues or exceptions detected across monitored services!\n");
    console.log("================================================================================\n");
    return;
  }

  console.log(`\nFound ${allIssues.length} issue(s) across monitored services:\n`);

  for (let i = 0; i < allIssues.length; i++) {
    const issue = allIssues[i];
    const circuitBadge = issue.circuitState === "circuit-open" ? "🚨 CIRCUIT OPEN" : issue.circuitState === "backoff" ? "⚠️ BACKOFF" : "✅ HEALTHY";

    console.log(`[Issue #${i + 1}] Service: ${issue.service.toUpperCase()} | Status: ${circuitBadge} (${issue.crashCount} crashes)`);
    console.log(`  🔴 Error:    ${issue.errorType}: ${issue.message}`);
    if (issue.fileLocation) {
      console.log(`  📍 Location: ${issue.fileLocation}`);
    }
    if (issue.stackTrace.length > 0) {
      console.log(`  📜 Trace:`);
      issue.stackTrace.slice(0, 4).forEach(st => console.log(`     ${st}`));
    }
    if (issue.suggestedFix) {
      console.log(`  ${issue.suggestedFix}`);
    }
    console.log("─".repeat(80));
  }

  console.log(`💡 Clear issues with: bs9 issues --clear`);
  console.log("================================================================================\n");
}
