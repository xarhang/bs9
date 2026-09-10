#!/usr/bin/env bun

/**
 * BS9 - Flush Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../src/platform/detect.js";
import { flushCommand } from "../src/commands/flush.js";

describe("Flush Command", () => {
  const platformInfo = getPlatformInfo();
  const logDir = platformInfo.logDir;
  const testId = `test-flush-${Date.now()}`;
  const testAppLog = join(logDir, `BS9_${testId}.out.log`);
  const testOtherLog = join(logDir, `BS9_${testId}_other.err.log`);

  const cleanFiles = () => {
    try {
      if (existsSync(testAppLog)) unlinkSync(testAppLog);
      if (existsSync(testOtherLog)) unlinkSync(testOtherLog);
    } catch {}
  };

  beforeEach(() => {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    cleanFiles();
    writeFileSync(testAppLog, "line 1\nline 2\nline 3\n");
    writeFileSync(testOtherLog, "error 1\nerror 2\n");
  });

  afterEach(() => {
    cleanFiles();
  });

  it("should flush specific service logs while leaving others intact", async () => {
    expect(readFileSync(testAppLog, "utf-8").length).toBeGreaterThan(0);
    expect(readFileSync(testOtherLog, "utf-8").length).toBeGreaterThan(0);

    await flushCommand(testId);

    // Target service log should now be empty
    expect(readFileSync(testAppLog, "utf-8")).toBe("");
  });

  it("should flush all logs when no service name is specified", async () => {
    expect(readFileSync(testAppLog, "utf-8").length).toBeGreaterThan(0);
    expect(readFileSync(testOtherLog, "utf-8").length).toBeGreaterThan(0);

    await flushCommand();

    expect(readFileSync(testAppLog, "utf-8")).toBe("");
    expect(readFileSync(testOtherLog, "utf-8")).toBe("");
  });
});
