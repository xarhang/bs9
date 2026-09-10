#!/usr/bin/env bun

/**
 * BS9 - Start Cluster & Host Validation Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { cpus } from "node:os";
import { resolveInstances, isValidHost } from "../src/commands/start.js";

describe("Start Command Utilities", () => {
  describe("resolveInstances", () => {
    it("should resolve 'max' to CPU count", () => {
      expect(resolveInstances("max")).toBe(cpus().length);
    });

    it("should parse numeric instance strings", () => {
      expect(resolveInstances("4")).toBe(4);
      expect(resolveInstances("8")).toBe(8);
      expect(resolveInstances("2")).toBe(2);
    });

    it("should default to 1 for undefined, 1, empty, negative, or invalid strings", () => {
      expect(resolveInstances(undefined)).toBe(1);
      expect(resolveInstances("1")).toBe(1);
      expect(resolveInstances("")).toBe(1);
      expect(resolveInstances("invalid")).toBe(1);
      expect(resolveInstances("-5")).toBe(1);
      expect(resolveInstances("0")).toBe(1);
    });
  });

  describe("isValidHost", () => {
    it("should allow valid localhost and anyIP hosts", () => {
      expect(isValidHost("localhost")).toBe(true);
      expect(isValidHost("127.0.0.1")).toBe(true);
      expect(isValidHost("::1")).toBe(true);
      expect(isValidHost("0.0.0.0")).toBe(true);
      expect(isValidHost("::")).toBe(true);
    });

    it("should validate IPv4 addresses properly", () => {
      expect(isValidHost("192.168.1.1")).toBe(true);
      expect(isValidHost("10.0.0.1")).toBe(true);
      expect(isValidHost("256.0.0.1")).toBe(false); // octet > 255
    });

    it("should validate regular hostnames and reject dangerous/invalid inputs", () => {
      expect(isValidHost("api.example.com")).toBe(true);
      expect(isValidHost("my-server")).toBe(true);
      expect(isValidHost("invalid host with spaces")).toBe(false);
      expect(isValidHost("host;rm -rf /")).toBe(false);
      expect(isValidHost("host@special!#")).toBe(false);
    });
  });
});
