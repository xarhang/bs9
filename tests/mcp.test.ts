#!/usr/bin/env bun

/**
 * BS9 - Model Context Protocol (MCP) Server Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MCP_TOOLS,
  MUTATING_MCP_TOOLS,
  handleToolCall,
  redactSensitiveEnv,
} from "../src/mcp/server.js";
import { mcpCommand } from "../src/commands/mcp.js";

describe("Model Context Protocol (MCP) Server", () => {
  const tempDirs: string[] = [];
  const origAuditLog = process.env.BS9_AUDIT_LOG;
  const origReadOnly = process.env.BS9_MCP_READONLY;

  afterEach(() => {
    if (origAuditLog === undefined) delete process.env.BS9_AUDIT_LOG;
    else process.env.BS9_AUDIT_LOG = origAuditLog;
    if (origReadOnly === undefined) delete process.env.BS9_MCP_READONLY;
    else process.env.BS9_MCP_READONLY = origReadOnly;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should expose all standard BS9 MCP tools including audit and export", () => {
    expect(Array.isArray(MCP_TOOLS)).toBe(true);
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(16);

    const toolNames = MCP_TOOLS.map(t => t.name);
    expect(toolNames).toContain("bs9_list_processes");
    expect(toolNames).toContain("bs9_describe_process");
    expect(toolNames).toContain("bs9_tail_logs");
    expect(toolNames).toContain("bs9_restart_process");
    expect(toolNames).toContain("bs9_reload_process");
    expect(toolNames).toContain("bs9_scale_process");
    expect(toolNames).toContain("bs9_stop_process");
    expect(toolNames).toContain("bs9_delete_process");
    expect(toolNames).toContain("bs9_diagnose_crash");
    expect(toolNames).toContain("bs9_reset_crash");
    expect(toolNames).toContain("bs9_flush_logs");
    expect(toolNames).toContain("bs9_send_signal");
    expect(toolNames).toContain("bs9_doctor");
    expect(toolNames).toContain("bs9_get_issues");
    expect(toolNames).toContain("bs9_audit_log");
    expect(toolNames).toContain("bs9_export_config");
  });

  it("each MCP tool should have valid name, description, and inputSchema", () => {
    for (const tool of MCP_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.startsWith("bs9_")).toBe(true);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("redactSensitiveEnv should mask secrets while keeping non-sensitive fields intact", () => {
    const input = {
      name: "api",
      env: {
        PORT: "3000",
        NODE_ENV: "production",
        API_KEY: "sk_live_12345",
        JWT_SECRET: "super-secret",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        PASSWORD: "hunter2",
        AUTH_TOKEN: "tok_abc",
      },
    };
    const redacted = redactSensitiveEnv(input);
    expect(redacted.name).toBe("api");
    expect(redacted.env.PORT).toBe("3000");
    expect(redacted.env.NODE_ENV).toBe("production");
    expect(redacted.env.API_KEY).toBe("***REDACTED***");
    expect(redacted.env.JWT_SECRET).toBe("***REDACTED***");
    expect(redacted.env.DATABASE_URL).toBe("***REDACTED***");
    expect(redacted.env.PASSWORD).toBe("***REDACTED***");
    expect(redacted.env.AUTH_TOKEN).toBe("***REDACTED***");
  });

  it("should block mutating tools in read-only mode and record denied audit event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-mcp-audit-"));
    tempDirs.push(dir);
    process.env.BS9_AUDIT_LOG = join(dir, "audit.log");

    expect(MUTATING_MCP_TOOLS.has("bs9_restart_process")).toBe(true);
    expect(MUTATING_MCP_TOOLS.has("bs9_audit_log")).toBe(false);

    await expect(
      handleToolCall("bs9_restart_process", { name: "api" }, { readOnly: true })
    ).rejects.toThrow(/read-only mode/);

    const auditRaw = await handleToolCall("bs9_audit_log", { limit: 10 }, { readOnly: true });
    const events = JSON.parse(auditRaw);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].action).toBe("bs9_restart_process");
    expect(events[0].target).toBe("api");
    expect(events[0].status).toBe("denied");
    expect(events[0].actor).toBe("mcp-agent");
    expect(events[0].details).toBe("blocked_by_readonly_mode");
  });

  it("should generate nginx, caddy, and grafana configs via bs9_export_config", async () => {
    const nginx = await handleToolCall("bs9_export_config", {
      format: "nginx",
      serviceName: "api",
      domain: "api.example.com",
      port: 3000,
    });
    expect(nginx).toContain("server_name api.example.com;");
    expect(nginx).toContain("127.0.0.1:3000");

    const caddy = await handleToolCall("bs9_export_config", {
      format: "caddy",
      serviceName: "api",
      domain: "api.example.com",
      port: 3000,
    });
    expect(caddy).toContain("api.example.com");
    expect(caddy).toContain("reverse_proxy");

    const grafana = await handleToolCall("bs9_export_config", {
      format: "grafana",
      serviceName: "api",
    });
    const parsedGrafana = JSON.parse(grafana);
    expect(parsedGrafana.title).toContain("BS9");
    expect(grafana).toContain("api");
    expect(Array.isArray(parsedGrafana.panels)).toBe(true);
  });

  it("should handle bs9_list_processes tool call", async () => {
    const result = await handleToolCall("bs9_list_processes", {});
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("should handle bs9_doctor tool call", async () => {
    const result = await handleToolCall("bs9_doctor", {});
    expect(typeof result).toBe("string");
    const doctor = JSON.parse(result);
    expect(doctor.status).toBe("healthy");
    expect(doctor.platform).toBeDefined();
    expect(doctor.serviceManager).toBeDefined();
  });

  it("should handle bs9_get_issues tool call", async () => {
    const result = await handleToolCall("bs9_get_issues", {});
    expect(typeof result).toBe("string");
    const issues = JSON.parse(result);
    expect(Array.isArray(issues)).toBe(true);
  });

  it("should throw error for unknown MCP tool", async () => {
    expect(handleToolCall("non_existent_tool", {})).rejects.toThrow(
      "Unknown BS9 MCP tool"
    );
  });

  it("mcpCommand should be exported as a function", () => {
    expect(typeof mcpCommand).toBe("function");
  });
});
