#!/usr/bin/env bun

/**
 * BS9 - MCP Command Entry Point
 * 
 * Launches the BS9 Model Context Protocol server or outputs configuration for AI assistants.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { runMcpServer } from "../mcp/server.js";
import { join } from "node:path";

interface McpOptions {
  install?: boolean;
}

export async function mcpCommand(options: McpOptions = {}): Promise<void> {
  if (options.install) {
    const binPath = join(process.cwd(), "bin", "bs9");
    const mcpConfig = {
      mcpServers: {
        bs9: {
          command: process.execPath, // bun
          args: ["run", binPath, "mcp"]
        }
      }
    };

    console.log(`\n📋 Claude Desktop / Cursor MCP Configuration:`);
    console.log(`Add the following block to your MCP config file (e.g. claude_desktop_config.json):\n`);
    console.log(JSON.stringify(mcpConfig, null, 2));
    console.log(`\n💡 To start the MCP server directly, run: bs9 mcp\n`);
    return;
  }

  // Run the stdio JSON-RPC MCP server
  await runMcpServer();
}
