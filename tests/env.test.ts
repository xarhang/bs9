#!/usr/bin/env bun

/**
 * BS9 - Env Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { envCommand } from "../src/commands/env.js";

describe("Env Command", () => {
  it("should be exported as a function", () => {
    expect(typeof envCommand).toBe("function");
  });

  it("should exit with error if service name is missing", async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((msg?: any) => {
      errors.push(String(msg));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      expect(envCommand("")).rejects.toThrow("process.exit(1)");
      expect(errors.some(e => e.includes("Service name required"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
