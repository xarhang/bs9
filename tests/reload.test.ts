#!/usr/bin/env bun

/**
 * BS9 - Reload Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { reloadCommand } from "../src/commands/reload.js";

describe("Reload Command", () => {
  it("should export reloadCommand function", () => {
    expect(typeof reloadCommand).toBe("function");
  });

  it("cluster worker regex should correctly identify numbered workers", () => {
    const target = "my-api";
    const serviceNames = [
      "BS9_my-api-0",
      "BS9_my-api-1",
      "BS9_my-api-2",
      "BS9_other-service",
      "BS9_my-api-worker", // not numeric suffix
      "BS9_my-api-database-0" // false positive with another service
    ];

    const workers = serviceNames.filter(name => {
      const clean = name.replace(/^(BS9_|bs9\.)/, "");
      return new RegExp(`^${target}-\\d+$`).test(clean);
    });

    expect(workers.length).toBe(3);
    expect(workers).toContain("BS9_my-api-0");
    expect(workers).toContain("BS9_my-api-1");
    expect(workers).toContain("BS9_my-api-2");
    expect(workers).not.toContain("BS9_my-api-worker");
    expect(workers).not.toContain("BS9_my-api-database-0");
  });
});
