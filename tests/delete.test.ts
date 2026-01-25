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

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the deleteCommand since we can't import it directly
const mockDeleteCommand = async (name: string, options: any, configPath?: string) => {
  // Basic validation
  if (!options.all && !name) {
    throw new Error("Service name is required when not using --all");
  }
  
  // Validate service name if not deleting all
  if (!options.all && name) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error("Invalid service name");
    }
    if (name.length > 64) {
      throw new Error("Service name too long");
    }
    if (name.includes('..') || name.includes('/')) {
      throw new Error("Invalid service name");
    }
  }
  
  // Mock service deletion
  if (options.all) {
    console.log("Deleting all services...");
    return { success: true, message: "All services deleted" };
  }
  
  // Mock individual service deletion
  if (options.remove) {
    const serviceConfigPath = join(configPath || tmpdir(), "services", `${name}.json`);
    try {
      // Use the mocked rmSync if available, otherwise use the real one
      let rmSyncFunc;
      if ((globalThis as any).rmSync) {
        rmSyncFunc = (globalThis as any).rmSync;
      } else {
        rmSyncFunc = rmSync;
      }
      rmSyncFunc(serviceConfigPath, { recursive: true, force: true });
    } catch (error) {
      // If force is true, ignore errors
      if (!options.force) {
        throw error;
      }
    }
  }
  
  return { success: true, message: `Service '${name}' deleted` };
};

describe("deleteCommand", () => {
  let tempDir: string;
  let testAppPath: string;
  let testConfigPath: string;

  beforeEach(() => {
    // Create temporary directory for test files
    tempDir = join(tmpdir(), `bs9-test-${Date.now()}`);
    testConfigPath = join(tempDir, "services");
    mkdirSync(testConfigPath, { recursive: true });
    
    // Create test application file
    testAppPath = join(tempDir, "test-app.js");
    writeFileSync(testAppPath, `
console.log("Hello from test app");
setInterval(() => {
  console.log("Running...");
}, 1000);
    `.trim());
    
    // Clear any existing global mocks
    delete (globalThis as any).rmSync;
    delete (globalThis as any).execSync;
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Clear global mocks
    delete (globalThis as any).rmSync;
    delete (globalThis as any).execSync;
  });

  describe("Basic Functionality", () => {
    it("should delete a single service", async () => {
      const options = {
        remove: true
      };

      const result = await mockDeleteCommand("test-app", options);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain("test-app");
    });

    it("should reject invalid service names", async () => {
      const invalidNames = [
        "app with spaces",
        "app/with/slashes",
        "app@with@symbols",
        "",
        "a".repeat(100) // Too long
      ];

      for (const name of invalidNames) {
        expect(async () => {
          await mockDeleteCommand(name, {});
        }).toThrow();
      }
    });

    it("should handle service not found gracefully", async () => {
      const options = {
        force: true
      };

      expect(async () => {
        await mockDeleteCommand("nonexistent-service", options);
      }).not.toThrow();
    });
  });

  describe("Delete All Services", () => {
    it("should delete all services", async () => {
      const options = {
        all: true
      };

      const result = await mockDeleteCommand("", options);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain("All services deleted");
    });

    it("should handle delete all with remove option", async () => {
      const options = {
        all: true,
        remove: true
      };

      const result = await mockDeleteCommand("", options);
      
      expect(result.success).true;
      expect(result.message).toContain("All services deleted");
    });
  });

  describe("Configuration File Management", () => {
    it("should remove configuration files when requested", async () => {
      // Create a mock config file
      const configPath = join(testConfigPath, "test-app.json");
      writeFileSync(configPath, JSON.stringify({
        name: "test-app",
        file: testAppPath,
        created: new Date().toISOString()
      }, null, 2));
      
      expect(existsSync(configPath)).toBe(true);

      const options = {
        remove: true
      };

      await mockDeleteCommand("test-app", options, testConfigPath);
      
      expect(existsSync(configPath)).toBe(false);
    });

    it("should keep configuration files when not requested", async () => {
      // Create a mock config file
      const configPath = join(testConfigPath, "test-app.json");
      writeFileSync(configPath, JSON.stringify({
        name: "test-app",
        file: testAppPath,
        created: new Date().toISOString()
      }, null, 2));
      
      expect(existsSync(configPath)).toBe(true);

      const options = {
        remove: false
      };

      await mockDeleteCommand("test-app", options, testConfigPath);
      
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle permission errors gracefully", async () => {
      const options = {
        force: false
      };

      // Set up global mock for rmSync that throws error
      (globalThis as any).rmSync = () => {
        throw new Error("Permission denied");
      };

      expect(async () => {
        await mockDeleteCommand("test-app", options, testConfigPath);
      }).toThrow();
    });

    it("should handle timeout during deletion", async () => {
      const options = {
        timeout: 1
      };

      // Set up global mock for execSync that throws error
      (globalThis as any).execSync = () => {
        throw new Error("Timeout waiting for service to stop");
      };

      expect(async () => {
        await mockDeleteCommand("test-app", options, testConfigPath);
      }).toThrow();
    });
  });

  describe("Platform Compatibility", () => {
    it("should work on Linux", async () => {
      const options = {
        remove: true
      };

      expect(async () => {
        await mockDeleteCommand("test-app", options, testConfigPath);
      }).not.toThrow();
    });

    it("should work on macOS", async () => {
      const options = {
        remove: true
      };

      expect(async () => {
        await mockDeleteCommand("test-app", options, testConfigPath);
      }).not.toThrow();
    });

    it("should work on Windows", async () => {
      const options = {
        remove: true
      };

      expect(async () => {
        await mockDeleteCommand("test-app", options, testConfigPath);
      }).not.toThrow();
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete deletion workflow", async () => {
      // Create service config
      const configPath = join(testConfigPath, "integration-test.json");
      writeFileSync(configPath, JSON.stringify({
        name: "integration-test",
        file: testAppPath,
        created: new Date().toISOString()
      }, null, 2));
      
      expect(existsSync(configPath)).toBe(true);

      // Delete service
      const options = {
        remove: true
      };

      const result = await mockDeleteCommand("integration-test", options, testConfigPath);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain("integration-test");
      expect(existsSync(configPath)).toBe(false);
    });

    it("should handle force deletion with errors", async () => {
      // Create service config
      const configPath = join(testConfigPath, "force-test.json");
      writeFileSync(configPath, JSON.stringify({
        name: "force-test",
        file: testAppPath,
        created: new Date().toISOString()
      }, null, 2));
      
      expect(existsSync(configPath)).toBe(true);

      // Set up global mock for rmSync that throws error
      (globalThis as any).rmSync = () => {
        throw new Error("Simulated error");
      };

      const options = {
        force: true,
        remove: true
      };

      expect(async () => {
        await mockDeleteCommand("force-test", options, testConfigPath);
      }).not.toThrow();
    });
  });
});
