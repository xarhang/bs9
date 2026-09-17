#!/usr/bin/env bun

/**
 * BS9 - Reload Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
  });

  it("cluster worker regex should correctly identify numbered workers with generation suffixes", () => {
    const target = "my-api";
    const serviceNames = [
      "BS9_my-api-0-g1",
      "BS9_my-api-1-g2",
      "BS9_my-api-2",
      "BS9_other-service-g1",
      "BS9_my-api-worker-g1",
      "BS9_my-api-database-0-g1"
    ];

    const workers = serviceNames.filter(name => {
      const clean = name.replace(/^(BS9_|bs9\.)/, "");
      return new RegExp(`^${target}-\\d+(-g\\d+)?$`).test(clean);
    });

    expect(workers.length).toBe(3);
    expect(workers).toContain("BS9_my-api-0-g1");
    expect(workers).toContain("BS9_my-api-1-g2");
    expect(workers).toContain("BS9_my-api-2");
    expect(workers).not.toContain("BS9_other-service-g1");
    expect(workers).not.toContain("BS9_my-api-worker-g1");
    expect(workers).not.toContain("BS9_my-api-database-0-g1");
  });

  it("parseWorkerSlot should accurately parse logical slots and physical generations", async () => {
    const { parseWorkerSlot } = await import("../src/utils/service-discovery.js");

    const w1 = parseWorkerSlot("BS9_api-0-g1");
    expect(w1).not.toBeNull();
    expect(w1?.appName).toBe("api");
    expect(w1?.slot).toBe(0);
    expect(w1?.generation).toBe(1);
    expect(w1?.logicalSlot).toBe("api-0");
    expect(w1?.physicalName).toBe("api-0-g1");
    expect(w1?.hasGenerationSuffix).toBe(true);

    const w2 = parseWorkerSlot("bs9.web-server-3-g4");
    expect(w2).not.toBeNull();
    expect(w2?.appName).toBe("web-server");
    expect(w2?.slot).toBe(3);
    expect(w2?.generation).toBe(4);
    expect(w2?.logicalSlot).toBe("web-server-3");
    expect(w2?.hasGenerationSuffix).toBe(true);

    const wLegacy = parseWorkerSlot("my-app-2");
    expect(wLegacy).not.toBeNull();
    expect(wLegacy?.appName).toBe("my-app");
    expect(wLegacy?.slot).toBe(2);
    expect(wLegacy?.generation).toBe(1);
    expect(wLegacy?.logicalSlot).toBe("my-app-2");
    expect(wLegacy?.hasGenerationSuffix).toBe(false);

    expect(parseWorkerSlot("database")).toBeNull();
    expect(parseWorkerSlot("api-worker")).toBeNull();
  });
});
