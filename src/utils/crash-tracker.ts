#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * Crash Loop Detector with Exponential Backoff
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CRASH_WINDOW_MS = 60_000;
const CRASH_THRESHOLD = 5;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_UPTIME_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;

export type CrashState = "healthy" | "backoff" | "circuit-open";

export interface CrashEvent {
  timestamp: number;
  exitCode: number | null;
}

export interface CrashRecord {
  name: string;
  crashes: CrashEvent[];
  consecutiveCrashes: number;
  backoffMs: number;
  state: CrashState;
  circuitOpenAt?: number;
  lastStartedAt?: number;
}

export interface RestartDecision {
  shouldRestart: boolean;
  delayMs: number;
  state: CrashState;
  reason: string;
}

function getCrashHistoryDir(): string {
  return join(homedir(), ".bs9", "crash-history");
}

function getCrashFilePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9-_]/g, "_").substring(0, 64);
  return join(getCrashHistoryDir(), `${safe}.json`);
}

function loadCrashRecord(name: string): CrashRecord {
  const path = getCrashFilePath(name);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")) as CrashRecord; } catch {}
  }
  return { name, crashes: [], consecutiveCrashes: 0, backoffMs: BACKOFF_BASE_MS, state: "healthy" };
}

function saveCrashRecord(record: CrashRecord): void {
  const dir = getCrashHistoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getCrashFilePath(record.name), JSON.stringify(record, null, 2));
}

export function recordCrash(name: string, exitCode: number | null = null): RestartDecision {
  const record = loadCrashRecord(name);
  const now = Date.now();
  record.crashes = record.crashes.filter((c) => now - c.timestamp < CRASH_WINDOW_MS);
  record.crashes.push({ timestamp: now, exitCode });
  record.consecutiveCrashes++;

  if (record.crashes.length >= CRASH_THRESHOLD) {
    record.state = "circuit-open";
    record.circuitOpenAt = now;
    record.backoffMs = MAX_BACKOFF_MS;
    saveCrashRecord(record);
    return {
      shouldRestart: false, delayMs: 0, state: "circuit-open",
      reason: `Crash loop detected: ${record.crashes.length} crashes in ${CRASH_WINDOW_MS / 1000}s. Circuit breaker OPEN.`,
    };
  }

  const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, record.consecutiveCrashes - 1), MAX_BACKOFF_MS);
  record.backoffMs = delayMs;
  record.state = "backoff";
  record.lastStartedAt = now;
  saveCrashRecord(record);
  return {
    shouldRestart: true, delayMs, state: "backoff",
    reason: `Service crashed (exit: ${exitCode ?? "signal"}). Backoff ${delayMs / 1000}s (attempt ${record.consecutiveCrashes}).`,
  };
}

export function resetCrash(name: string): void {
  const record = loadCrashRecord(name);
  if (record.state !== "healthy" || record.consecutiveCrashes > 0) {
    record.crashes = [];
    record.consecutiveCrashes = 0;
    record.backoffMs = BACKOFF_BASE_MS;
    record.state = "healthy";
    record.circuitOpenAt = undefined;
    saveCrashRecord(record);
  }
}

export function forceResetCircuit(name: string): void {
  const record = loadCrashRecord(name);
  record.crashes = [];
  record.consecutiveCrashes = 0;
  record.backoffMs = BACKOFF_BASE_MS;
  record.state = "healthy";
  record.circuitOpenAt = undefined;
  saveCrashRecord(record);
  console.log(`Circuit breaker reset for '${name}'`);
}

export function getCrashState(name: string): CrashRecord {
  return loadCrashRecord(name);
}

export function formatCrashState(record: CrashRecord): string {
  switch (record.state) {
    case "healthy": return "healthy";
    case "backoff": return `backoff (${record.consecutiveCrashes} crashes, next: ${record.backoffMs / 1000}s)`;
    case "circuit-open": return "CIRCUIT OPEN (manual reset required)";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startHealthyTimer(name: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => { resetCrash(name); }, HEALTHY_UPTIME_MS);
}