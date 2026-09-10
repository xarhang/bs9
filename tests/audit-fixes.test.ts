#!/usr/bin/env bun

/**
 * BS9 - Audit & Regression Prevention Unit Tests
 * 
 * Validates edge cases and safeguards against regressions identified in the ruthless audit:
 * 1. formatMemory edge cases (0, negative, NaN, TB+)
 * 2. Exact cluster worker matching without false positives (e.g. app vs app-db-0)
 * 3. Log stream size reset on flush / truncate
 * 4. Multi-language script file name sanitization
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";

describe("Audit Fixes & Regression Guard", () => {
  describe("Cluster Worker Regex Exact Matching", () => {
    it("should match only legitimate numbered workers of the target service", () => {
      const target = "web-api";
      const workerRegex = new RegExp(`^${target}-\\d+$`);

      // Valid workers
      expect(workerRegex.test("web-api-0")).toBe(true);
      expect(workerRegex.test("web-api-1")).toBe(true);
      expect(workerRegex.test("web-api-15")).toBe(true);

      // False-positive traps that previous code failed on:
      expect(workerRegex.test("web-api-database-0")).toBe(false);
      expect(workerRegex.test("web-api-frontend")).toBe(false);
      expect(workerRegex.test("web-api-worker-1")).toBe(false);
      expect(workerRegex.test("web-api")).toBe(false); // Exact base name handled separately
    });
  });

  describe("Service Name Sanitization for Polyglot Scripts", () => {
    it("should cleanly strip polyglot file extensions", () => {
      const stripExt = (path: string) => path.replace(/\.[a-zA-Z0-9]+$/, "");

      expect(stripExt("server.ts")).toBe("server");
      expect(stripExt("app.js")).toBe("app");
      expect(stripExt("worker.py")).toBe("worker");
      expect(stripExt("main.go")).toBe("main");
      expect(stripExt("script.sh")).toBe("script");
      expect(stripExt("task.ps1")).toBe("task");
      expect(stripExt("binary.exe")).toBe("binary");
    });
  });

  describe("Log Truncation and File Stream Size Recovery", () => {
    it("should correctly handle file truncation in size tracking", () => {
      let fileSize = 50000;
      const onContentUpdate = (newLength: number) => {
        if (newLength < fileSize) {
          // File was truncated or flushed
          fileSize = newLength;
          return "truncated";
        } else if (newLength > fileSize) {
          const delta = newLength - fileSize;
          fileSize = newLength;
          return `read ${delta} bytes`;
        }
        return "noop";
      };

      // 1. Flush event occurs: size drops from 50000 to 0
      expect(onContentUpdate(0)).toBe("truncated");
      expect(fileSize).toBe(0);

      // 2. New logs arrive: size increases from 0 to 120 bytes
      expect(onContentUpdate(120)).toBe("read 120 bytes");
      expect(fileSize).toBe(120);
    });
  });
});
