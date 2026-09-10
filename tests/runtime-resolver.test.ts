#!/usr/bin/env bun

/**
 * BS9 - Universal Polyglot Runtime Resolver Unit Tests
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { describe, it, expect } from "bun:test";
import { resolveRuntime } from "../src/utils/runtime-resolver.js";

describe("Universal Polyglot Runtime Resolver", () => {
  it("should resolve TypeScript files to Bun", () => {
    const res = resolveRuntime("/path/to/server.ts");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("Bun (TypeScript)");
    expect(res.executable).toBe(process.execPath);
    expect(res.args).toContain("run");
    expect(res.args).toContain("/path/to/server.ts");
  });

  it("should resolve JavaScript files to Bun", () => {
    const res = resolveRuntime("/path/to/app.js");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("Bun (JavaScript)");
    expect(res.args).toContain("/path/to/app.js");
  });

  it("should support preload args with Bun", () => {
    const res = resolveRuntime("/path/to/app.ts", undefined, ["--preload", "/path/to/preload.js"]);
    expect(res.args).toEqual(["run", "--preload", "/path/to/preload.js", "/path/to/app.ts"]);
  });

  it("should resolve Python scripts (.py)", () => {
    const res = resolveRuntime("/path/to/script.py");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("Python");
    const expectedPyBin = process.platform === "win32" ? "python" : "python3";
    expect(res.executable).toBe(expectedPyBin);
    expect(res.args).toEqual(["/path/to/script.py"]);
  });

  it("should resolve Go source files (.go)", () => {
    const res = resolveRuntime("/path/to/main.go");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("Go");
    expect(res.executable).toBe("go");
    expect(res.args).toEqual(["run", "/path/to/main.go"]);
  });

  it("should resolve Shell scripts (.sh)", () => {
    const res = resolveRuntime("/path/to/deploy.sh");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("Shell");
    expect(res.executable).toBe("bash");
    expect(res.args).toEqual(["/path/to/deploy.sh"]);
  });

  it("should resolve PowerShell scripts (.ps1)", () => {
    const res = resolveRuntime("C:\\scripts\\task.ps1");
    expect(res.isBinary).toBe(false);
    expect(res.runtimeName).toBe("PowerShell");
    expect(res.executable).toBe("powershell");
    expect(res.args).toEqual(["-NoProfile", "-File", "C:\\scripts\\task.ps1"]);
  });

  it("should resolve Windows Batch scripts (.bat and .cmd)", () => {
    const res1 = resolveRuntime("C:\\scripts\\run.bat");
    expect(res1.executable).toBe("cmd.exe");
    expect(res1.args).toEqual(["/c", "C:\\scripts\\run.bat"]);

    const res2 = resolveRuntime("C:\\scripts\\run.cmd");
    expect(res2.executable).toBe("cmd.exe");
    expect(res2.args).toEqual(["/c", "C:\\scripts\\run.cmd"]);
  });

  it("should resolve Windows executable (.exe) as native binary", () => {
    const res = resolveRuntime("C:\\bin\\app.exe");
    expect(res.isBinary).toBe(true);
    expect(res.executable).toBe("C:\\bin\\app.exe");
    expect(res.args).toEqual([]);
    expect(res.runtimeName).toBe("Windows Binary");
  });

  it("should resolve explicit custom interpreter (--interpreter)", () => {
    const res = resolveRuntime("/path/to/app.rb", "ruby");
    expect(res.isBinary).toBe(false);
    expect(res.executable).toBe("ruby");
    expect(res.args).toEqual(["/path/to/app.rb"]);
    expect(res.runtimeName).toBe("Custom (ruby)");
  });

  it("should support --interpreter none / binary for compiled executables", () => {
    const res1 = resolveRuntime("/usr/local/bin/my-go-service", "none");
    expect(res1.isBinary).toBe(true);
    expect(res1.executable).toBe("/usr/local/bin/my-go-service");
    expect(res1.args).toEqual([]);

    const res2 = resolveRuntime("/usr/local/bin/rust-server", "binary");
    expect(res2.isBinary).toBe(true);
    expect(res2.executable).toBe("/usr/local/bin/rust-server");
    expect(res2.args).toEqual([]);
  });
});
