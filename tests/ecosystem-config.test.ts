#!/usr/bin/env bun

/**
 * BS9 - Ecosystem Config Parser Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus } from "node:os";
import { isEcosystemConfig, parseEcosystemConfig } from "../src/utils/ecosystem-config.js";
import { generateLinuxServiceUnit } from "../src/commands/start.js";

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

      // Second app verification (instances: max, args string splitting, interpreter)
      const app2 = entries[1];
      expect(app2.name).toBe("worker");
      expect(app2.instances).toBe(cpus().length);
      expect(app2.args).toEqual(["--queue", "jobs", "--retries", "3"]);
    });

    it("should parse interpreter field from ecosystem config", async () => {
      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [{ script: "./pipeline.py", interpreter: "python3" }]
      }));

      const entries = await parseEcosystemConfig(configFile);
      expect(entries[0].name).toBe("pipeline");
      expect(entries[0].interpreter).toBe("python3");
    });

    it("should infer app name from script filename when name is omitted", async () => {
      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [{ script: "./microservice-auth.ts" }]
      }));

      const entries = await parseEcosystemConfig(configFile);
      expect(entries[0].name).toBe("microservice-auth");
    });

    it("should map complex PM2 lifecycle, clustering, watch, memory, readiness, and log fields", async () => {
      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [
          {
            name: "complex-api",
            script: "./api.ts",
            exec_mode: "cluster",
            node_args: "--smol --max-old-space-size=512",
            watch: ["src", "config"],
            max_memory_restart: "512M",
            restart_delay: 5000,
            autorestart: false,
            cron_restart: "0 3 * * *",
            time: true,
            max_log_size: "50M",
            max_log_files: 10,
            wait_ready: true,
            listen_timeout: 12000,
            env: {
              PORT: 8085,
              LOG_LEVEL: "info"
            }
          }
        ]
      }));

      const entries = await parseEcosystemConfig(configFile);
      const app = entries[0];
      expect(app.instances).toBe(cpus().length);
      expect(app.port).toBe("8085");
      expect(app.interpreterArgs).toEqual(["--smol", "--max-old-space-size=512"]);
      expect(app.watch).toBe(true);
      expect(app.maxMemoryRestart).toBe("512M");
      expect(app.restartDelay).toBe("5000");
      expect(app.autorestart).toBe(false);
      expect(app.cron).toBe("0 3 * * *");
      expect(app.time).toBe(true);
      expect(app.maxLogSize).toBe("50M");
      expect(app.maxLogFiles).toBe("10");
      expect(app.waitReady).toBe(true);
      expect(app.readyTimeout).toBe("12000");
    });

    it("should load env_file, apply envProfile overrides, and emit warnings for unsupported PM2 fields", async () => {
      const envFile = join(tempDir, ".env.staging");
      writeFileSync(envFile, "# comment\nDB_HOST=staging.db.local\nAPI_KEY=from_file\n");

      const configFile = join(tempDir, "ecosystem.config.json");
      writeFileSync(configFile, JSON.stringify({
        apps: [
          {
            name: "staging-app",
            script: "./app.ts",
            exec_mode: "fork",
            env_file: ".env.staging",
            env: {
              API_KEY: "from_env",
              BASE: "1"
            },
            env_staging: {
              NODE_ENV: "staging",
              API_KEY: "from_staging"
            },
            out_file: "./logs/out.log",
            error_file: "./logs/err.log",
            kill_timeout: 8000,
            max_restarts: 10,
            min_uptime: 5000,
            ignore_watch: ["node_modules", "logs"],
            merge_logs: true,
            post_update: ["npm install"]
          }
        ]
      }));

      const entries = await parseEcosystemConfig(configFile, { envProfile: "staging" });
      const app = entries[0];
      expect(app.instances).toBe(1);
      expect(app.env).toContain("DB_HOST=staging.db.local");
      expect(app.env).toContain("BASE=1");
      expect(app.env).toContain("NODE_ENV=staging");
      expect(app.env).toContain("API_KEY=from_staging");
      expect(app.outFile).toContain("logs/out.log");
      expect(app.errorFile).toContain("logs/err.log");
      expect(app.killTimeout).toBe("8000");
      expect(app.maxRestarts).toBe("10");
      expect(app.minUptime).toBe("5000");
      expect(app.ignoreWatch).toEqual(["node_modules", "logs"]);
      expect(app.warnings?.length).toBe(2);
      expect(app.warnings?.[0]).toContain("merge_logs");
      expect(app.warnings?.[1]).toContain("post_update");
    });

    it("should apply killTimeout, maxRestarts, outFile, errorFile, cwd, and args in generateLinuxServiceUnit", () => {
      const unit = generateLinuxServiceUnit({
        serviceName: "pm2-migrated",
        fullPath: join(tempDir, "app.ts"),
        host: "127.0.0.1",
        port: "4000",
        protocol: "http",
        env: ["NODE_ENV=production"],
        otel: false,
        prometheus: false,
        cwd: join(tempDir, "workdir"),
        args: ["--port", "4000"],
        autorestart: false,
        restartDelay: "5000",
        killTimeout: "8000",
        maxRestarts: "12",
        outFile: join(tempDir, "logs", "out.log"),
        errorFile: "/dev/null",
      });

      expect(unit).toContain("Restart=no");
      expect(unit).toContain("RestartSec=5s");
      expect(unit).toContain("TimeoutStopSec=8s");
      expect(unit).toContain("StartLimitBurst=12");
      expect(unit).toContain(`WorkingDirectory=${join(tempDir, "workdir")}`);
      expect(unit).toContain(`StandardOutput=append:${join(tempDir, "logs", "out.log")}`);
      expect(unit).toContain("StandardError=null");
      expect(unit).toContain("--port");
    });
  });
});
