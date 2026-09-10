#!/usr/bin/env bun

/**
 * BS9 - Crash Tracker & Circuit Breaker Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  recordCrash,
  resetCrash,
  forceResetCircuit,
  getCrashState,
  formatCrashState,
  sleep,
  startHealthyTimer
} from "../src/utils/crash-tracker.js";

describe("Crash Tracker & Circuit Breaker", () => {
  const testServiceName = `test-crash-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const crashFile = join(homedir(), ".bs9", "crash-history", `${testServiceName}.json`);

  const cleanup = () => {
    try {
      if (existsSync(crashFile)) {
        unlinkSync(crashFile);
      }
    } catch {}
  };

  beforeEach(() => {
    cleanup();
    resetCrash(testServiceName);
  });

  afterEach(() => {
    cleanup();
  });

  it("should return healthy state by default for a new service", () => {
    const state = getCrashState(testServiceName);
    expect(state.state).toBe("healthy");
    expect(state.consecutiveCrashes).toBe(0);
    expect(state.crashes.length).toBe(0);
    expect(formatCrashState(state)).toBe("healthy");
  });

  it("should record first crash with exponential backoff (1s)", () => {
    const decision = recordCrash(testServiceName, 1);
    expect(decision.shouldRestart).toBe(true);
    expect(decision.state).toBe("backoff");
    expect(decision.delayMs).toBe(1000);
    expect(decision.reason).toContain("Backoff 1s");

    const state = getCrashState(testServiceName);
    expect(state.consecutiveCrashes).toBe(1);
    expect(state.crashes.length).toBe(1);
    expect(state.crashes[0].exitCode).toBe(1);
    expect(formatCrashState(state)).toContain("backoff (1 crashes, next: 1s)");
  });

  it("should double backoff on consecutive crashes (1s -> 2s -> 4s -> 8s)", () => {
    const d1 = recordCrash(testServiceName, 1);
    expect(d1.delayMs).toBe(1000);

    const d2 = recordCrash(testServiceName, 1);
    expect(d2.delayMs).toBe(2000);

    const d3 = recordCrash(testServiceName, 1);
    expect(d3.delayMs).toBe(4000);

    const d4 = recordCrash(testServiceName, 1);
    expect(d4.delayMs).toBe(8000);
  });

  it("should trip circuit breaker after 5 crashes in 60s window", () => {
    recordCrash(testServiceName, 1);
    recordCrash(testServiceName, 1);
    recordCrash(testServiceName, 1);
    recordCrash(testServiceName, 1);
    const d5 = recordCrash(testServiceName, 1);

    expect(d5.shouldRestart).toBe(false);
    expect(d5.state).toBe("circuit-open");
    expect(d5.delayMs).toBe(0);
    expect(d5.reason).toContain("Circuit breaker OPEN");

    const state = getCrashState(testServiceName);
    expect(state.state).toBe("circuit-open");
    expect(state.circuitOpenAt).toBeDefined();
    expect(formatCrashState(state)).toBe("CIRCUIT OPEN (manual reset required)");
  });

  it("should reset crash state back to healthy via resetCrash", () => {
    recordCrash(testServiceName, 1);
    recordCrash(testServiceName, 1);
    expect(getCrashState(testServiceName).consecutiveCrashes).toBe(2);

    resetCrash(testServiceName);
    const state = getCrashState(testServiceName);
    expect(state.state).toBe("healthy");
    expect(state.consecutiveCrashes).toBe(0);
    expect(state.crashes.length).toBe(0);
  });

  it("should force reset circuit even when tripped", () => {
    for (let i = 0; i < 5; i++) {
      recordCrash(testServiceName, 1);
    }
    expect(getCrashState(testServiceName).state).toBe("circuit-open");

    forceResetCircuit(testServiceName);
    const state = getCrashState(testServiceName);
    expect(state.state).toBe("healthy");
    expect(state.consecutiveCrashes).toBe(0);
    expect(state.circuitOpenAt).toBeUndefined();
  });

  it("should handle null exit code (signal kill)", () => {
    const decision = recordCrash(testServiceName, null);
    expect(decision.shouldRestart).toBe(true);
    expect(decision.reason).toContain("signal");
  });

  it("sleep helper should resolve after timeout", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("startHealthyTimer should return a timer handle and can be cleared", () => {
    const timer = startHealthyTimer(testServiceName);
    expect(timer).toBeDefined();
    clearTimeout(timer);
  });
});
