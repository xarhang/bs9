#!/usr/bin/env bun

/**
 * BS9 - Describe Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { describeCommand } from "../src/commands/describe.js";

describe("Describe Command", () => {
  it("should be exported as a function", () => {
    expect(typeof describeCommand).toBe("function");
  });

  it("should format and describe a service gracefully even if stopped or not registered", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    try {
      await describeCommand("unregistered-sample-service");
      expect(logs.some(l => l.includes("Describing Service: unregistered-sample-service"))).toBe(true);
      expect(logs.some(l => l.includes("Status"))).toBe(true);
      expect(logs.some(l => l.includes("PID"))).toBe(true);
      expect(logs.some(l => l.includes("Self-Healing"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
