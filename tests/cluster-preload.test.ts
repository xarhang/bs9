#!/usr/bin/env bun

/**
 * BS9 - Cluster Preload Hook Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";

describe("Cluster Preload Hook", () => {
  it("should inject reusePort: true into Bun.serve options when BS9_REUSE_PORT is enabled", () => {
    // Save original
    const originalServe = Bun.serve;
    let capturedOptions: any = null;

    // Simulate Bun.serve call capture
    const mockServe = (opts: any) => {
      capturedOptions = opts;
      return { stop: () => {} };
    };
    (Bun as any).serve = mockServe;

    // Simulate preload logic
    process.env.BS9_REUSE_PORT = "true";
    
    // Logic from src/utils/cluster-preload.ts
    if (process.env.BS9_REUSE_PORT === "true" && typeof Bun !== "undefined" && typeof Bun.serve === "function") {
      const orig = Bun.serve.bind(Bun);
      (Bun as any).serve = function (options: any) {
        if (options && typeof options === "object") {
          if (options.reusePort === undefined) {
            options.reusePort = true;
          }
        }
        return orig(options);
      };
    }

    // Call Bun.serve without reusePort
    Bun.serve({
      port: 0,
      fetch: () => new Response("ok")
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.reusePort).toBe(true);

    // Call Bun.serve with explicit reusePort: false
    Bun.serve({
      port: 0,
      reusePort: false,
      fetch: () => new Response("ok")
    });

    expect(capturedOptions.reusePort).toBe(false);

    // Restore original Bun.serve
    (Bun as any).serve = originalServe;
    delete process.env.BS9_REUSE_PORT;
  });
});
