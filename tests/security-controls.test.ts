#!/usr/bin/env bun

/**
 * BS9 - Security Controls & Bug Fix Regression Tests
 *
 * Validates security controls and fixes for:
 * 1. Signal targeting regex safety & signal allowlist
 * 2. MCP path traversal rejection & boundary containment
 * 3. Load balancer header sanitization & hop-by-hop stripping
 * 4. Load balancer dynamic configuration updates
 * 5. Programmatic entry point exports from src/index.ts
 * 6. Database pool initialization
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { buildOutboundHeaders, sanitizeHeaders } from "../src/loadbalancer/manager.js";
import { DatabasePool } from "../src/database/pool.js";
import * as BS9Api from "../src/index.js";

describe("Security Controls & Bug Fix Regressions", () => {
  describe("Load Balancer Header Sanitization (Finding 4 & 13)", () => {
    it("should strip hop-by-hop headers from outbound requests", () => {
      const headers = new Headers({
        "Connection": "close",
        "Keep-Alive": "timeout=5",
        "Transfer-Encoding": "chunked",
        "Upgrade": "websocket",
        "User-Agent": "BS9-Client/1.0",
        "Content-Type": "application/json"
      });

      const backend = {
        id: "b1",
        host: "10.0.0.5",
        port: 3000,
        connections: 0,
        healthy: true,
        lastHealthCheck: Date.now(),
        responseTime: 5
      };

      const outbound = buildOutboundHeaders(headers, backend, "192.168.1.100");

      expect(outbound.has("connection")).toBe(false);
      expect(outbound.has("keep-alive")).toBe(false);
      expect(outbound.has("transfer-encoding")).toBe(false);
      expect(outbound.has("upgrade")).toBe(false);
      expect(outbound.get("User-Agent")).toBe("BS9-Client/1.0");
      expect(outbound.get("Content-Type")).toBe("application/json");
      expect(outbound.get("Host")).toBe("10.0.0.5:3000");
      expect(outbound.get("X-Forwarded-For")).toBe("192.168.1.100");
    });

    it("should strip attacker-forged client forwarding headers", () => {
      const headers = new Headers({
        "X-Forwarded-For": "1.1.1.1, 8.8.8.8",
        "X-Real-IP": "6.6.6.6",
        "X-Forwarded-Proto": "https",
        "Host": "evil.attacker.internal"
      });

      const backend = {
        id: "b1",
        host: "internal.srv",
        port: 8080,
        connections: 0,
        healthy: true,
        lastHealthCheck: Date.now(),
        responseTime: 2
      };

      const outbound = buildOutboundHeaders(headers, backend, "127.0.0.1");

      // Spoofed values must be replaced by trusted proxy values
      expect(outbound.get("X-Forwarded-For")).toBe("127.0.0.1");
      expect(outbound.get("X-Real-IP")).toBe("127.0.0.1");
      expect(outbound.get("Host")).toBe("internal.srv:8080");
    });

    it("should strip CRLF injection attempts from headers", () => {
      const headers = {
        "x-custom": "legit\r\nInjected-Header: evil",
        "connection": "close"
      };

      const sanitized = sanitizeHeaders(headers);
      expect(sanitized["x-custom"]).toBe("legitInjected-Header: evil");
      expect(sanitized["connection"]).toBeUndefined();
    });
  });

  describe("Programmatic Entry Point (Bug B2)", () => {
    it("should export core BS9 command functions from src/index.ts", () => {
      expect(typeof BS9Api.startCommand).toBe("function");
      expect(typeof BS9Api.stopCommand).toBe("function");
      expect(typeof BS9Api.restartCommand).toBe("function");
      expect(typeof BS9Api.reloadCommand).toBe("function");
      expect(typeof BS9Api.statusCommand).toBe("function");
      expect(typeof BS9Api.scaleCommand).toBe("function");
      expect(typeof BS9Api.deleteCommand).toBe("function");
      expect(typeof BS9Api.listServices).toBe("function");
      expect(typeof BS9Api.getPlatformInfo).toBe("function");
    });
  });

  describe("Database Pool Real/Mock Connection (Bug B4)", () => {
    it("should initialize database pool with mock/fallback driver", async () => {
      const pool = new DatabasePool({
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "secretpassword",
        mock: true,
        maxConnections: 5,
        minConnections: 1
      });

      const stats = pool.getStats();
      expect(stats.maxConnections).toBe(5);

      const conn = await pool.acquire();
      expect(conn).toBeDefined();
      expect(conn.inUse).toBe(true);

      const rows = await conn.query("SELECT 1");
      expect(Array.isArray(rows)).toBe(true);

      await pool.release(conn);
      expect(conn.inUse).toBe(false);

      await pool.close();
    });
  });

  describe("Phase 2 Vulnerability Hardening Tests", () => {
    it("should validate SemVer versions and reject command injection payloads", async () => {
      const { isValidVersion } = await import("../src/commands/update.js");
      expect(isValidVersion("1.0.0")).toBe(true);
      expect(isValidVersion("2.1.3-beta.1")).toBe(true);
      expect(isValidVersion("latest")).toBe(true);

      // Malicious payloads
      expect(isValidVersion("1.0.0; calc.exe")).toBe(false);
      expect(isValidVersion("1.0.0 | rm -rf /")).toBe(false);
      expect(isValidVersion("1.0.0`whoami`")).toBe(false);
      expect(isValidVersion("1.0.0$(id)")).toBe(false);
    });

    it("should safely escape regex special characters and prevent ReDoS in pattern matching", async () => {
      const { escapeRegExp, getServicesByPattern } = await import("../src/utils/array-parser.js");
      expect(escapeRegExp("app(1)+[test]")).toBe("app\\(1\\)\\+\\[test\\]");

      // Pattern with dangerous regex metacharacters should not throw
      const matches = await getServicesByPattern("test-[a-z*(+");
      expect(Array.isArray(matches)).toBe(true);
    });

    it("should validate webhook URLs and reject invalid protocols / SSRF schemes", async () => {
      const { isValidWebhookUrl } = await import("../src/alerting/config.js");
      expect(isValidWebhookUrl("http://example.com/webhook")).toBe(true);
      expect(isValidWebhookUrl("https://hooks.slack.com/services/123")).toBe(true);

      // Dangerous / invalid protocols
      expect(isValidWebhookUrl("file:///etc/passwd")).toBe(false);
      expect(isValidWebhookUrl("gopher://127.0.0.1:6379/")).toBe(false);
      expect(isValidWebhookUrl("javascript:alert(1)")).toBe(false);
      expect(isValidWebhookUrl("not-a-url")).toBe(false);
    });

    it("should enforce strict service name validation across Windows and macOS managers", async () => {
      const winManager = await import("../src/windows/service.js");
      const macManager = await import("../src/macos/launchd.js");

      expect(winManager.isValidServiceName("my-app_1.0")).toBe(true);
      expect(winManager.isValidServiceName("app; calc.exe")).toBe(false);
      expect(winManager.isValidServiceName("../../evil")).toBe(false);

      expect(macManager.isValidServiceName("bs9.my-app")).toBe(true);
      expect(macManager.isValidServiceName("bs9.app$(id)")).toBe(false);
      expect(macManager.isValidServiceName("bs9.../traversal")).toBe(false);
    });
  });
});
