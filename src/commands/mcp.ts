#!/usr/bin/env bun

/**
 * BS9 - MCP Command Entry Point
 * 
 * Launches the BS9 Model Context Protocol server or outputs configuration for AI assistants.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { runMcpServer } from "../mcp/server.js";
import { join } from "node:path";

interface McpOptions {
  install?: boolean;
  readonly?: boolean;
}

export async function mcpCommand(options: McpOptions = {}): Promise<void> {
  const isReadOnly = Boolean(options.readonly || process.env.BS9_MCP_READONLY === "true");
  if (options.install) {
    const binPath = join(process.cwd(), "bin", "bs9");
    const args = ["run", binPath, "mcp", ...(isReadOnly ? ["--readonly"] : [])];
    const mcpConfig = {
      mcpServers: {
        bs9: {
          command: process.execPath, // bun
          args
        }
      }
    };

    console.log(`\n📋 Claude Desktop / Cursor MCP Configuration:`);
    console.log(`Add the following block to your MCP config file (e.g. claude_desktop_config.json):\n`);
    console.log(JSON.stringify(mcpConfig, null, 2));
    console.log(`\n💡 To start the MCP server directly, run: bs9 mcp${isReadOnly ? " --readonly" : ""}\n`);
    return;
  }

  // Run the stdio JSON-RPC MCP server
  await runMcpServer({ readOnly: isReadOnly });
}
