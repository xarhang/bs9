import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

describe("CLI command surface contract", () => {
  const sandbox = join(process.cwd(), `.tmp-cli-surface-${process.pid}`);
  const binPath = resolve(process.cwd(), "bin", "bs9");
  const commands = [
    "start", "stop", "restart", "reload", "status", "show", "flush", "logs",
    "scale", "reset", "sendSignal", "ping", "init", "startup", "unstartup",
    "env", "mcp", "issues", "monit", "web", "alert", "export", "deps",
    "profile", "delete", "save", "resurrect", "deploy", "loadbalancer",
    "dbpool", "update", "advanced", "consul", "windows", "macos", "doctor",
    "inspect", "inspect-ha", "verify-ha", "daemon",
  ];

  afterAll(() => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  });

  it("registers the complete expected command inventory", () => {
    const result = spawnSync(process.execPath, [binPath, "--help"], {
      encoding: "utf8",
      env: { ...process.env, BS9_HOME: sandbox },
    });
    expect(result.status, result.stderr).toBe(0);
    for (const command of commands) {
      expect(result.stdout).toContain(`  ${command}`);
    }
  });

  for (const command of commands) {
    it(`loads and parses '${command} --help'`, () => {
      const result = spawnSync(process.execPath, [binPath, command, "--help"], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, BS9_HOME: sandbox },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  }
});
