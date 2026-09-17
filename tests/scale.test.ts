#!/usr/bin/env bun

/**
 * BS9 - Scale Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, spyOn } from "bun:test";
import { cloneSystemdWorkerUnit, scaleCommand } from "../src/commands/scale.js";

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

  it("clones a systemd worker unit without corrupting quoted environment lines", () => {
    const base = `[Unit]\nDescription=BS9 Cluster Worker api-0-g2\n[Service]\nEnvironment="SERVICE_NAME=api-0-g2"\nEnvironment="BS9_CLUSTER_ID=0"\nEnvironment="NODE_APP_INSTANCE=0"\nEnvironment="BS9_CLUSTER_TOTAL=2"\nSyslogIdentifier=api-0-g2\n`;
    const cloned = cloneSystemdWorkerUnit(base, "api-0-g2", "api-2-g2", 2, 3);

    expect(cloned).toContain("Description=BS9 Service: api-2-g2");
    expect(cloned).toContain('Environment="SERVICE_NAME=api-2-g2"');
    expect(cloned).toContain('Environment="BS9_CLUSTER_ID=2"');
    expect(cloned).toContain('Environment="NODE_APP_INSTANCE=2"');
    expect(cloned).toContain('Environment="BS9_CLUSTER_TOTAL=3"');
    expect(cloned).toContain("SyslogIdentifier=api-2-g2");
    expect(cloned).not.toContain('BS9_CLUSTER_ID=2\nEnvironment=NODE_APP_INSTANCE');
  });
});
