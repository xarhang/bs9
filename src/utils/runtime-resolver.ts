#!/usr/bin/env bun

/**
 * BS9 - Universal Polyglot Runtime Resolver
 * 
 * Automatically detects and configures runtimes for:
 * - Bun / Node.js (.ts, .js, .mjs, .cjs)
 * - Python (.py) -> python3 / python
 * - Go (.go or compiled binary) -> go run / binary exec
 * - Rust / C++ / Go compiled binaries (.exe or ELF without extension)
 * - Shell scripts (.sh, .ps1, .bat, .cmd)
 * - Custom interpreter override (--interpreter <path>)
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { basename, extname } from "node:path";

export interface ResolvedRuntime {
  executable: string;
  args: string[];
  runtimeName: string;
  isBinary: boolean;
}

export function resolveRuntime(
  filePath: string,
  interpreter?: string,
  preloadArgs: string[] = []
): ResolvedRuntime {
  // If user explicitly passed --interpreter (e.g. "python3", "node", "none")
  if (interpreter) {
    if (interpreter === "none" || interpreter === "binary") {
      return {
        executable: filePath,
        args: [],
        runtimeName: "Native Binary",
        isBinary: true
      };
    }
    return {
      executable: interpreter,
      args: [filePath],
      runtimeName: `Custom (${interpreter})`,
      isBinary: false
    };
  }

  const ext = extname(filePath).toLowerCase();

  // 1. Python scripts (.py)
  if (ext === ".py") {
    const pyBin = process.platform === "win32" ? "python" : "python3";
    return {
      executable: pyBin,
      args: [filePath],
      runtimeName: "Python",
      isBinary: false
    };
  }

  // 2. Go source files (.go)
  if (ext === ".go") {
    return {
      executable: "go",
      args: ["run", filePath],
      runtimeName: "Go",
      isBinary: false
    };
  }

  // 3. Shell / Scripting
  if (ext === ".sh") {
    return {
      executable: "bash",
      args: [filePath],
      runtimeName: "Shell",
      isBinary: false
    };
  }

  if (ext === ".ps1") {
    return {
      executable: "powershell",
      args: ["-NoProfile", "-File", filePath],
      runtimeName: "PowerShell",
      isBinary: false
    };
  }

  if (ext === ".bat" || ext === ".cmd") {
    return {
      executable: "cmd.exe",
      args: ["/c", filePath],
      runtimeName: "Windows Batch",
      isBinary: false
    };
  }

  // 4. Windows Executable (.exe) or precompiled binary
  if (ext === ".exe") {
    return {
      executable: filePath,
      args: [],
      runtimeName: "Windows Binary",
      isBinary: true
    };
  }

  // 5. Binary on Linux / macOS (no extension, e.g. ./my-api, ./go-server)
  if (ext === "" && process.platform !== "win32") {
    return {
      executable: filePath,
      args: [],
      runtimeName: "Native Binary (Go/Rust/C++)",
      isBinary: true
    };
  }

  // 6. Default: Bun JavaScript / TypeScript runtime (.ts, .js, .mjs, .cjs)
  return {
    executable: process.execPath, // bun
    args: ["run", ...preloadArgs, filePath],
    runtimeName: ext === ".ts" ? "Bun (TypeScript)" : "Bun (JavaScript)",
    isBinary: false
  };
}
