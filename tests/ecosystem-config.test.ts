#!/usr/bin/env bun

/**
 * BS9 - Ecosystem Config Parser Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus } from "node:os";
import { isEcosystemConfig, parseEcosystemConfig } from "../src/utils/ecosystem-config.js";

describe("Ecosystem Config Parser", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `bs9-eco-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("isEcosystemConfig detection", () => {
    it("should recognize standard ecosystem and bs9 config filenames", () => {
      const validNames = [
        "ecosystem.config.js",
        "ecosystem.config.cjs",
        "ecosystem.config.mjs",
        "ecosystem.config.ts",
        "ecosystem.config.json",
        "bs9.config.js",
        "bs9.config.ts",
        "bs9.config.json"
      ];

      for (const name of validNames) {
        expect(isEcosystemConfig(join(tempDir, name))).toBe(true);
      }
    });

    it("should reject standard application files", () => {
      const normalFiles = [
        "app.js",
        "server.ts",
        "index.mjs",
        "package.json",
        "tsconfig.json"
      ];

      for (const name of normalFiles) {
        expect(isEcosystemConfig(join(tempDir, name))).toBe(false);
      }
    });

    it("should recognize custom json config containing apps array", () => {
      const customConfig = join(tempDir, "production.config.json");
      writeFileSync(customConfig, JSON.stringify({
        apps: [{ name: "api", script: "./api.ts" }]
      }));

      expect(isEcosystemConfig(customConfig)).toBe(true);
    });

    it("should reject json file containing config in name if it lacks apps array", () => {
      const nonAppConfig = join(tempDir, "database.config.json");
      writeFileSync(nonAppConfig, JSON.stringify({
        host: "localhost",
        port: 5432
      }));

      expect(isEcosystemConfig(nonAppConfig)).toBe(false);
    });
  });

  describe("parseEcosystemConfig parser", () => {
    it("should throw if config file does not exist", async () => {
      expect(parseEcosystemConfig(join(tempDir, "nonexistent.json"))).rejects.toThrow(
        "Ecosystem config not found"
      );
    });

    it("should throw if config has no apps array", async () => {
      const emptyConfig = join(tempDir, "ecosystem.config.json");
      writeFileSync(emptyConfig, JSON.stringify({}));

      expect(parseEcosystemConfig(emptyConfig)).rejects.toThrow(
        "Invalid ecosystem config: expected '{ apps: [...] }'"
      );
    });

    it("should throw if an app is missing script/file property", async () => {
      const missingScriptConfig = join(tempDir, "ecosystem.config.json");
      writeFileSync(missingScriptConfig, JSON.stringify({
        apps: [{ name: "invalid-app" }]
      }));

      expect(parseEcosystemConfig(missingScriptConfig)).rejects.toThrow(
        "missing 'script' or 'file' field"
      );
    });

    it("should correctly parse JSON ecosystem configuration with all field mappings", async () => {
      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [
          {
            name: "web-portal",
            script: "./server.ts",
            cwd: "./src",
            instances: 4,
            port: 3000,
            host: "0.0.0.0",
            env: {
              NODE_ENV: "development",
              DEBUG: "true"
            },
            env_production: {
              NODE_ENV: "production",
              API_KEY: "secret123"
            },
            args: ["--mode", "cluster", "--verbose"]
          },
          {
            name: "worker",
            file: "worker.js",
            instances: "max",
            args: "--queue jobs --retries 3"
          }
        ]
      }));

      const entries = await parseEcosystemConfig(configFile);
      expect(entries.length).toBe(2);

      // First app verification
      const app1 = entries[0];
      expect(app1.name).toBe("web-portal");
      expect(app1.file).toContain("server.ts");
      expect(app1.cwd).toContain("src");
      expect(app1.instances).toBe(4);
      expect(app1.port).toBe("3000");
      expect(app1.host).toBe("0.0.0.0");
      expect(app1.args).toEqual(["--mode", "cluster", "--verbose"]);
      // Check merged env (env_production overrides env)
      expect(app1.env).toContain("NODE_ENV=production");
      expect(app1.env).toContain("DEBUG=true");
      expect(app1.env).toContain("API_KEY=secret123");

      // Second app verification (instances: max, args string splitting)
      const app2 = entries[1];
      expect(app2.name).toBe("worker");
      expect(app2.instances).toBe(cpus().length);
      expect(app2.args).toEqual(["--queue", "jobs", "--retries", "3"]);
    });

    it("should infer app name from script filename when name is omitted", async () => {
      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [{ script: "./microservice-auth.ts" }]
      }));

      const entries = await parseEcosystemConfig(configFile);
      expect(entries[0].name).toBe("microservice-auth");
    });
  });
});
