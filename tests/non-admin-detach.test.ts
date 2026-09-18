#!/usr/bin/env bun

/**
 * BS9 - Non-Admin Detached Background Process Unit Tests
 * 
 * Tests that background supervisor and child processes properly detach
 * from the console and survive terminal / caller process termination.
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, expect, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("Non-Admin Detached Background Process", () => {
  const testId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const testHome = join(process.cwd(), `.tmp-detach-test-${testId}`);
  const fixtureDir = join(testHome, "fixture");
  const binPath = resolve(process.cwd(), "bin", "bs9");
  const testPort = 53000 + Math.floor(Math.random() * 1000);
  const appFile = join(fixtureDir, "app.ts");
  const logFile = join(testHome, "app.log");

  afterAll(() => {
    try {
      if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
    } catch {}
  });

  it("safely invokes FreeConsole on Windows without throwing", async () => {
    if (process.platform === "win32") {
      const { dlopen, FFIType } = await import("bun:ffi");
      const kernel32 = dlopen("kernel32.dll", {
        FreeConsole: {
          args: [],
          returns: FFIType.bool,
        },
      });
      expect(typeof kernel32.symbols.FreeConsole).toBe("function");
      const result = kernel32.symbols.FreeConsole();
      expect(typeof result).toBe("boolean");
    } else {
      expect(true).toBe(true);
    }
  });

  it("spawns a background service that persists across CLI execution", async () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      appFile,
      `
      import { appendFileSync } from "node:fs";
      const server = Bun.serve({
        port: ${testPort},
        hostname: "127.0.0.1",
        fetch() {
          return Response.json({ ok: true, status: "alive" });
        },
      });
      appendFileSync("${logFile.replace(/\\/g, "/")}", "READY\\n");
      `
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      BS9_HOME: testHome,
      BS9_WINDOWS_BACKGROUND: "1",
    };

    // Run CLI to start service
    const startResult = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [binPath, "start", "app.ts", "--name", `detach-${testId}`, "--port", String(testPort), "--host", "127.0.0.1"], {
        cwd: fixtureDir,
        env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    });

    expect(startResult.exitCode).toBe(0);

    // Wait and verify service is reachable
    let reachable = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/`);
        if (res.ok) {
          const body = (await res.json()) as any;
          if (body.ok) {
            reachable = true;
            break;
          }
        }
      } catch {}
      await Bun.sleep(200);
    }

    expect(reachable).toBe(true);

    // Stop service
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [binPath, "stop", `detach-${testId}`], {
        cwd: fixtureDir,
        env,
        windowsHide: true,
      });
      child.on("close", () => resolve());
    });
  }, 30_000);
});
