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
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { createRequire } from "node:module";
import os from "node:os";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface PM2AppConfig {
  name?: string;
  script?: string;
  file?: string;
  instances?: number | "max";
  port?: number | string;
  host?: string;
  env?: Record<string, string>;
  env_production?: Record<string, string>;
  watch?: boolean | string[];
  max_memory_restart?: string;
  [key: string]: unknown;
}

export interface PM2EcosystemConfig {
  apps: PM2AppConfig[];
}

export interface BS9AppEntry {
  file: string;
  name?: string;
  instances?: number;
  port?: string;
  host?: string;
  env?: string[];
  otel?: boolean;
  prometheus?: boolean;
  https?: boolean;
  build?: boolean;
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
export async function parseEcosystemConfig(filePath: string): Promise<BS9AppEntry[]> {
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

  return config.apps.map((app, idx) => mapAppToBS9(app, idx, absPath));
}

// -------------------------------------------------------------------
// JS/TS config loader
// -------------------------------------------------------------------

async function loadJsConfig(absPath: string): Promise<PM2EcosystemConfig> {
  // Strategy 1: ESM dynamic import()
  try {
    const mod = await import(`file://${absPath}?t=${Date.now()}`);
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
// Field mapper: PM2 -> BS9
// -------------------------------------------------------------------

function mapAppToBS9(app: PM2AppConfig, idx: number, configPath: string): BS9AppEntry {
  const scriptField = app.script ?? app.file;
  if (!scriptField) {
    throw new Error(
      `App at index ${idx} in '${configPath}' is missing 'script' or 'file' field`
    );
  }

  const configDir = resolve(configPath, "..");
  const resolvedScript = resolve(configDir, scriptField);

  let instances: number | undefined;
  if (app.instances === "max") {
    instances = os.cpus().length;
  } else if (typeof app.instances === "number" && app.instances > 0) {
    instances = app.instances;
  }

  const port = app.port !== undefined ? String(app.port) : undefined;
  const host = app.host;

  const envObj: Record<string, string> = {
    ...(app.env || {}),
    ...(app.env_production || {}),
  };
  const env = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);

  const name =
    app.name ||
    basename(scriptField).replace(/\.(ts|js|mjs|cjs)$/, "");

  return {
    file: resolvedScript,
    name,
    instances,
    port,
    host,
    env: env.length > 0 ? env : undefined,
  };
}