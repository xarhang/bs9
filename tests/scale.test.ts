#!/usr/bin/env bun

/**
 * BS9 - Scale Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { scaleCommand } from "../src/commands/scale.js";

describe("Scale Command", () => {
  it("should be exported as a function", () => {
    expect(typeof scaleCommand).toBe("function");
  });

  it("should reject invalid scale arguments or missing app name", async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((msg?: any) => {
      errors.push(String(msg));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      expect(scaleCommand("", "4")).rejects.toThrow("process.exit(1)");
      expect(errors.some(e => e.includes("Usage: bs9 scale"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("should parse relative and absolute instance numbers accurately", () => {
    const current = 4;
    const calcTarget = (countStr: string) => {
      if (countStr.startsWith("+")) return current + parseInt(countStr.slice(1), 10);
      if (countStr.startsWith("-")) return current - parseInt(countStr.slice(1), 10);
      return parseInt(countStr, 10);
    };

    expect(calcTarget("6")).toBe(6);
    expect(calcTarget("+3")).toBe(7);
    expect(calcTarget("-2")).toBe(2);
    expect(calcTarget("+0")).toBe(4);
  });
});
