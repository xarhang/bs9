#!/usr/bin/env bun

/**
 * BS9 - Send Signal Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, spyOn } from "bun:test";
import { sendSignalCommand } from "../src/commands/send-signal.js";

describe("Send Signal Command", () => {
  it("should be exported as a function", () => {
    expect(typeof sendSignalCommand).toBe("function");
  });

  it("should exit with error message when missing arguments", async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((msg?: any) => {
      errors.push(String(msg));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      expect(sendSignalCommand("", "")).rejects.toThrow("process.exit(1)");
      expect(errors.some(e => e.includes("Usage: bs9 sendSignal"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
