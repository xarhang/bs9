#!/usr/bin/env bun

/**
 * BS9 - Model Context Protocol (MCP) Server Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { MCP_TOOLS, handleToolCall } from "../src/mcp/server.js";
import { mcpCommand } from "../src/commands/mcp.js";

describe("Model Context Protocol (MCP) Server", () => {
  it("should expose all standard BS9 MCP tools", () => {
    expect(Array.isArray(MCP_TOOLS)).toBe(true);
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(12);

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
