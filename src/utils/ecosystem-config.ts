#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * PM2 ecosystem.config.js Drop-in Parser
 *
 * Loads PM2-compatible ecosystem config files and maps them to BS9 StartOptions.
 * Supports: ecosystem.config.js (CJS/ESM), bs9.config.ts, bs9.config.json
 *
 * PM2 -> BS9 field mapping:
 *   script / file  -> file (script path)
 *   name           -> --name
 *   instances      -> --instances (-i)
 *   env            -> --env KEY=VAL (merged)
 *   port           -> --port
 *   host           -> --host
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import os from "node:os";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface PM2AppConfig {
  name?: string;
  script?: string;
  file?: string;
  cwd?: string;
  args?: string | string[];
  node_args?: string | string[];
  interpreter_args?: string | string[];
  instances?: number | "max";
  exec_mode?: "cluster" | "cluster_mode" | "fork" | "fork_mode" | string;
  port?: number | string;
  host?: string;
  env?: Record<string, string | number | boolean>;
  env_production?: Record<string, string | number | boolean>;
  env_file?: string;
  watch?: boolean | string[];
  ignore_watch?: string | string[];
  max_memory_restart?: string | number;
  restart_delay?: number | string;
  autorestart?: boolean;
  cron_restart?: string;
  cron?: string;
  time?: boolean;
  max_log_size?: string;
  maxLogSize?: string;
  max_log_files?: number | string;
  maxLogFiles?: number | string;
  wait_ready?: boolean;
  waitReady?: boolean;
  listen_timeout?: number | string;
  readyTimeout?: number | string;
  interpreter?: string;
  otel?: boolean;
  prometheus?: boolean;
  https?: boolean;
  build?: boolean;
  windowsServiceAccount?: "LocalService" | "LocalSystem";
  [key: string]: unknown;
}

export interface PM2EcosystemConfig {
  apps: PM2AppConfig[];
  deploy?: Record<string, unknown>;
}

export interface ParseEcosystemOptions {
  envProfile?: string;
}

export interface BS9AppEntry {
  file: string;
  name?: string;
  cwd?: string;
  args?: string[];
  interpreterArgs?: string[];
  instances?: number;
  port?: string;
  host?: string;
  env?: string[];
  watch?: boolean;
  maxMemoryRestart?: string;
  restartDelay?: string;
  autorestart?: boolean;
  cron?: string;
  time?: boolean;
  maxLogSize?: string;
  maxLogFiles?: string;
  waitReady?: boolean;
  readyTimeout?: string;
  otel?: boolean;
  prometheus?: boolean;
  https?: boolean;
  build?: boolean;
  interpreter?: string;
  windowsServiceAccount?: "LocalService" | "LocalSystem";
  warnings?: string[];
}

// -------------------------------------------------------------------
// Detection
// -------------------------------------------------------------------

/** Returns true if the given filepath should be treated as a BS9/PM2 config file */
export function isEcosystemConfig(filePath: string): boolean {
  const b = basename(filePath);
  const ext = extname(filePath);

  if (
    b === "ecosystem.config.js" ||
    b === "ecosystem.config.cjs" ||
    b === "ecosystem.config.mjs" ||
    b === "ecosystem.config.ts" ||
    b === "ecosystem.config.json" ||
    b === "bs9.config.js" ||
    b === "bs9.config.ts" ||
    b === "bs9.config.json"
  ) {
    return true;
  }

  // Any .json with "config" in the name that has an `apps` array
  if (ext === ".json" && b.includes("config")) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      return Array.isArray(parsed?.apps);
    } catch {
      return false;
    }
  }

  return false;
}

// -------------------------------------------------------------------
// Loader
// -------------------------------------------------------------------

/**
 * Load and parse an ecosystem config file.
 * Returns an array of BS9AppEntry objects ready to pass to startCommand().
 */
export async function parseEcosystemConfig(
  filePath: string,
  options: ParseEcosystemOptions = {}
): Promise<BS9AppEntry[]> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Ecosystem config not found: ${absPath}`);
  }

  const ext = extname(absPath);
  let config: PM2EcosystemConfig;

  if (ext === ".json") {
    try {
      config = JSON.parse(readFileSync(absPath, "utf-8")) as PM2EcosystemConfig;
    } catch (e) {
      throw new Error(`Failed to parse JSON config: ${e}`);
    }
  } else {
    config = await loadJsConfig(absPath);
  }

  if (!config || !Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error(
      `Invalid ecosystem config: expected '{ apps: [...] }' structure in ${absPath}`
    );
  }

  const envProfile = options.envProfile ?? process.env.BS9_ENV_PROFILE;
  return config.apps.map((app, idx) => mapAppToBS9(app, idx, absPath, envProfile));
}

// -------------------------------------------------------------------
// JS/TS config loader
// -------------------------------------------------------------------

async function loadJsConfig(absPath: string): Promise<PM2EcosystemConfig> {
  // Strategy 1: ESM dynamic import()
  try {
    const fileUrl = `${pathToFileURL(absPath).href}?t=${Date.now()}`;
    const mod = await import(fileUrl);
    const exported = mod.default ?? mod;
    if (exported?.apps) return exported as PM2EcosystemConfig;
  } catch {
    // Fall through to CJS
  }

  // Strategy 2: CJS require() for classic module.exports = { apps: [...] }
  try {
    const requireFn = createRequire(import.meta.url);
    const mod = requireFn(absPath);
    const exported = mod?.default ?? mod;
    if (exported?.apps) return exported as PM2EcosystemConfig;
  } catch (e) {
    throw new Error(
      `Failed to load ecosystem config '${absPath}'.\n` +
      `Make sure the file exports { apps: [...] } as default or module.exports.\n` +
      `Error: ${e}`
    );
  }

  throw new Error(`Ecosystem config '${absPath}' did not export a valid { apps: [...] } object`);
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function parseArgsList(raw: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(raw)) {
    const mapped = raw.map(String).filter((s) => s.length > 0);
    return mapped.length > 0 ? mapped : undefined;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().split(/\s+/);
  }
  return undefined;
}

function parseDotEnvFile(envFilePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  const content = readFileSync(envFilePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

const UNSUPPORTED_PM2_FIELDS: Record<string, string> = {
  out_file: "managed automatically by BS9 log directory",
  error_file: "managed automatically by BS9 log directory",
  log_file: "managed automatically by BS9 log directory",
  merge_logs: "BS9 separates per-worker logs automatically",
  kill_timeout: "BS9 uses a fixed 30s stop timeout",
  max_restarts: "BS9 uses built-in circuit breaker (5 crashes / 60s)",
  min_uptime: "BS9 uses built-in circuit breaker & exponential backoff",
  ignore_watch: "BS9 --watch monitors the script directory without ignore globs",
  post_update: "not executed automatically by BS9",
};

// -------------------------------------------------------------------
// Field mapper: PM2 -> BS9
// -------------------------------------------------------------------

function mapAppToBS9(
  app: PM2AppConfig,
  idx: number,
  configPath: string,
  envProfile?: string
): BS9AppEntry {
  if (app.windowsServiceAccount !== undefined &&
      app.windowsServiceAccount !== "LocalService" &&
      app.windowsServiceAccount !== "LocalSystem") {
    throw new Error(`App at index ${idx} in '${configPath}' has invalid windowsServiceAccount; use LocalService or LocalSystem`);
  }

  const scriptField = app.script ?? app.file;
  if (!scriptField) {
    throw new Error(
      `App at index ${idx} in '${configPath}' is missing 'script' or 'file' field`
    );
  }

  const configDir = resolve(configPath, "..");
  const resolvedScript = resolve(configDir, scriptField);
  const warnings: string[] = [];

  // Instances & exec_mode
  let instances: number | undefined;
  if (app.instances === "max") {
    instances = os.cpus().length;
  } else if (typeof app.instances === "number" && app.instances > 0) {
    instances = app.instances;
  } else if (typeof app.instances === "string" && /^\d+$/.test(app.instances)) {
    const parsed = parseInt(app.instances, 10);
    if (parsed > 0) instances = parsed;
  } else if (app.exec_mode === "cluster" || app.exec_mode === "cluster_mode") {
    instances = os.cpus().length;
  } else if (app.exec_mode === "fork" || app.exec_mode === "fork_mode") {
    instances = 1;
  }

  // Env merging: env_file -> env -> env_<profile> (default env_production)
  const envObj: Record<string, string> = {};
  if (typeof app.env_file === "string" && app.env_file.trim().length > 0) {
    const resolvedEnvFile = resolve(configDir, app.env_file);
    if (existsSync(resolvedEnvFile)) {
      Object.assign(envObj, parseDotEnvFile(resolvedEnvFile));
    } else {
      warnings.push(`env_file '${app.env_file}' not found at ${resolvedEnvFile}`);
    }
  }

  const assignEnvRecord = (rec: unknown) => {
    if (!rec || typeof rec !== "object") return;
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      if (v !== undefined && v !== null) envObj[k] = String(v);
    }
  };

  assignEnvRecord(app.env);
  const profileKey = envProfile ? `env_${envProfile}` : "env_production";
  if (profileKey in app && app[profileKey]) {
    assignEnvRecord(app[profileKey]);
  }

  const env = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);

  const port =
    app.port !== undefined
      ? String(app.port)
      : envObj.PORT !== undefined
        ? String(envObj.PORT)
        : undefined;
  const host = app.host;

  const name =
    app.name ||
    basename(scriptField).replace(/\.[a-zA-Z0-9]+$/, "");

  const cwd = app.cwd ? resolve(configDir, app.cwd) : configDir;
  const args = parseArgsList(app.args);
  const interpreterArgs = parseArgsList(app.node_args ?? app.interpreter_args);

  // Lifecycle & monitoring fields
  let watch: boolean | undefined;
  if (typeof app.watch === "boolean") {
    watch = app.watch;
  } else if (Array.isArray(app.watch)) {
    watch = app.watch.length > 0;
  }

  const maxMemoryRestart =
    app.max_memory_restart !== undefined ? String(app.max_memory_restart) : undefined;
  const restartDelay =
    app.restart_delay !== undefined ? String(app.restart_delay) : undefined;
  const autorestart =
    typeof app.autorestart === "boolean" ? app.autorestart : undefined;
  const cron =
    typeof app.cron_restart === "string"
      ? app.cron_restart
      : typeof app.cron === "string"
        ? app.cron
        : undefined;
  const time = typeof app.time === "boolean" ? app.time : undefined;

  const rawMaxLogSize = app.max_log_size ?? app.maxLogSize;
  const maxLogSize = rawMaxLogSize !== undefined ? String(rawMaxLogSize) : undefined;

  const rawMaxLogFiles = app.max_log_files ?? app.maxLogFiles;
  const maxLogFiles = rawMaxLogFiles !== undefined ? String(rawMaxLogFiles) : undefined;

  const waitReady =
    typeof app.wait_ready === "boolean"
      ? app.wait_ready
      : typeof app.waitReady === "boolean"
        ? app.waitReady
        : undefined;

  const rawReadyTimeout = app.listen_timeout ?? app.readyTimeout;
  const readyTimeout = rawReadyTimeout !== undefined ? String(rawReadyTimeout) : undefined;

  for (const [field, note] of Object.entries(UNSUPPORTED_PM2_FIELDS)) {
    if (app[field] !== undefined) {
      warnings.push(`PM2 field '${field}' is ignored (${note})`);
    }
  }

  return {
    file: resolvedScript,
    name,
    cwd,
    args,
    interpreterArgs,
    instances,
    port,
    host,
    env: env.length > 0 ? env : undefined,
    watch,
    maxMemoryRestart,
    restartDelay,
    autorestart,
    cron,
    time,
    maxLogSize,
    maxLogFiles,
    waitReady,
    readyTimeout,
    otel: typeof app.otel === "boolean" ? app.otel : undefined,
    prometheus: typeof app.prometheus === "boolean" ? app.prometheus : undefined,
    https: typeof app.https === "boolean" ? app.https : undefined,
    build: typeof app.build === "boolean" ? app.build : undefined,
    interpreter: typeof app.interpreter === "string" ? app.interpreter : undefined,
    windowsServiceAccount: app.windowsServiceAccount,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
