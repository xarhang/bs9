#!/usr/bin/env bun

/**
 * BS9 - Logs Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { logsCommand } from "../src/commands/logs.js";

describe("Logs Command", () => {
  it("should be exported as a function", () => {
    expect(typeof logsCommand).toBe("function");
  });

  it("should handle non-existent service gracefully without throwing uncaught error", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });
    const warnSpy = spyOn(console, "warn").mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    try {
      await logsCommand("nonexistent-test-service", { lines: "10" });
      expect(logs.some(l => l.includes("No log files found") || l.includes("💡"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
