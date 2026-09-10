#!/usr/bin/env bun

/**
 * BS9 - Ping Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { pingCommand } from "../src/commands/ping.js";

describe("Ping Command", () => {
  it("should be exported as a function", () => {
    expect(typeof pingCommand).toBe("function");
  });

  it("should output 'pong' and health information", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    try {
      await pingCommand();
      expect(logs).toContain("pong");
      expect(logs.some(l => l.includes("BS9 is alive and operational"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
