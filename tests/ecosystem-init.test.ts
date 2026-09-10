#!/usr/bin/env bun

/**
 * BS9 - Ecosystem Init Command Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ecosystemInitCommand } from "../src/commands/ecosystem-init.js";

describe("Ecosystem Init Command", () => {
  const jsConfig = join(process.cwd(), "ecosystem.config.js");
  const jsonConfig = join(process.cwd(), "bs9.config.json");

  const cleanConfigs = () => {
    try {
      if (existsSync(jsConfig)) rmSync(jsConfig);
      if (existsSync(jsonConfig)) rmSync(jsonConfig);
    } catch {}
  };

  beforeEach(() => {
    cleanConfigs();
  });

  afterEach(() => {
    cleanConfigs();
  });

  it("should generate ecosystem.config.js by default", async () => {
    await ecosystemInitCommand();
    expect(existsSync(jsConfig)).toBe(true);
    const content = readFileSync(jsConfig, "utf-8");
    expect(content).toContain("export default");
    expect(content).toContain("apps");
    expect(content).toContain("reusePort");
  });

  it("should generate bs9.config.json when --json flag is passed", async () => {
    await ecosystemInitCommand({ json: true });
    expect(existsSync(jsonConfig)).toBe(true);
    const json = JSON.parse(readFileSync(jsonConfig, "utf-8"));
    expect(Array.isArray(json.apps)).toBe(true);
    expect(json.apps[0].name).toBe("my-app");
  });
});
