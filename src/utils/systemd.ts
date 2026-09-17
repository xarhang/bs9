/**
 * BS9 - Systemd Service Unit Escaping & Formatting Utilities
 *
 * Provides safe escaping of environment variables, executable paths, and arguments
 * for systemd unit files, preventing newline directive injection and whitespace errors.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Escapes a string value for safe inclusion inside a systemd double-quoted string.
 * Strips all newline characters (\r, \n) to prevent directive injection.
 * Escapes backslashes (\ -> \\) and double quotes (" -> \").
 */
export function escapeSystemdValue(val: string): string {
  if (typeof val !== "string") {
    val = String(val ?? "");
  }
  // Strip all CR and LF to prevent directive injection
  const noNewlines = val.replace(/[\r\n]+/g, " ");
  // Escape backslash first, then double quote
  return noNewlines.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Formats an Environment directive for a systemd service unit:
 * Environment="KEY=ESCAPED_VALUE"
 */
export function escapeSystemdEnv(key: string, val: string): string {
  const cleanKey = key.replace(/[^A-Za-z0-9_]/g, "_");
  const escapedVal = escapeSystemdValue(val);
  return `Environment="${cleanKey}=${escapedVal}"`;
}

/**
 * Escapes an executable or argument token for systemd ExecStart syntax.
 * If the token contains whitespace, quotes, or backslashes, it is wrapped in double quotes.
 */
export function escapeSystemdArg(arg: string): string {
  if (typeof arg !== "string") {
    arg = String(arg ?? "");
  }
  const noNewlines = arg.replace(/[\r\n]+/g, " ");
  if (!/[\s"'\\]/.test(noNewlines)) {
    return noNewlines;
  }
  return `"${escapeSystemdValue(noNewlines)}"`;
}

/**
 * Formats a full ExecStart line from an executable path and argument array.
 */
export function formatSystemdExecStart(executable: string, args: string[] = []): string {
  const parts = [escapeSystemdArg(executable), ...args.map(escapeSystemdArg)];
  return parts.join(" ");
}

/**
 * Makes a user unit visible to systemd and starts it. BS9_HOME may place unit
 * files outside systemd's normal ~/.config/systemd/user search path, so those
 * units must first be linked explicitly.
 */
export function startUserSystemdUnit(unitPath: string, unitName: string): void {
  const absoluteUnitPath = resolve(unitPath);
  const defaultUnitDir = resolve(join(homedir(), ".config", "systemd", "user"));

  if (resolve(dirname(absoluteUnitPath)) !== defaultUnitDir) {
    execFileSync("systemctl", ["--user", "link", "--force", absoluteUnitPath], {
      stdio: "ignore",
    });
  }

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  execFileSync("systemctl", ["--user", "start", unitName], { stdio: "ignore" });
}

/**
 * Generates a complete systemd unit file with safe escaping throughout.
 */
export function generateSystemdUnit(options: {
  description: string;
  workingDir: string;
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  restartSec?: number;
}): string {
  const description = options.description.replace(/[\r\n]+/g, " ");
  const workingDir = escapeSystemdArg(options.workingDir);
  const execStart = formatSystemdExecStart(options.executable, options.args || []);
  const restartSec = options.restartSec ?? 2;

  const envLines: string[] = [];
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      envLines.push(escapeSystemdEnv(k, v));
    }
  }

  const envBlock = envLines.length > 0 ? `${envLines.join("\n")}\n` : "";

  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${execStart}
Restart=always
RestartSec=${restartSec}
${envBlock}
[Install]
WantedBy=default.target
`;
}
