#!/usr/bin/env bun

/**
 * BS9 - Reset Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { resetCommand } from "../src/commands/reset.js";
import { recordCrash, getCrashState } from "../src/utils/crash-tracker.js";

describe("Reset Command", () => {
  it("should be exported as a function", () => {
    expect(typeof resetCommand).toBe("function");
  });

  it("should reset crash record for specific service name", async () => {
    const testApp = `reset-test-${Date.now()}`;
    // Induce a crash
    recordCrash(testApp, 1);
    expect(getCrashState(testApp).consecutiveCrashes).toBe(1);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    try {
      await resetCommand([testApp]);
      expect(getCrashState(testApp).consecutiveCrashes).toBe(0);
      expect(getCrashState(testApp).state).toBe("healthy");
      expect(logs.some(l => l.includes("Reset complete"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
