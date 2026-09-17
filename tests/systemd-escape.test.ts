import { describe, it, expect } from "bun:test";
import {
  escapeSystemdValue,
  escapeSystemdEnv,
  escapeSystemdArg,
  formatSystemdExecStart,
  generateSystemdUnit,
} from "../src/utils/systemd.js";

describe("Systemd Unit Escaping & Injection Prevention", () => {
  it("strips carriage returns and newlines to prevent directive injection", () => {
    const maliciousInput = "normal\n[Service]\nExecStart=/bad/path\r\nRestart=never";
    const sanitized = escapeSystemdValue(maliciousInput);
    expect(sanitized).not.toContain("\n");
    expect(sanitized).not.toContain("\r");
    expect(sanitized).toBe("normal [Service] ExecStart=/bad/path Restart=never");
  });

  it("escapes backslashes and double quotes correctly", () => {
    const input = 'path\\with\\"quotes"';
    const escaped = escapeSystemdValue(input);
    expect(escaped).toBe('path\\\\with\\\\\\"quotes\\"');
  });

  it("formats environment directives cleanly with sanitized keys", () => {
    const envLine = escapeSystemdEnv("APP-PORT.KEY", '3000\nATTACK="true"');
    expect(envLine).toBe('Environment="APP_PORT_KEY=3000 ATTACK=\\"true\\""');
    expect(envLine).not.toContain("\n");
  });

  it("quotes arguments containing spaces or quotes", () => {
    expect(escapeSystemdArg("/usr/bin/bun")).toBe("/usr/bin/bun");
    expect(escapeSystemdArg("/Program Files/Bun/bun.exe")).toBe('"/Program Files/Bun/bun.exe"');
    expect(escapeSystemdArg('arg"quote')).toBe('"arg\\"quote"');
  });

  it("formats ExecStart with multiple arguments safely", () => {
    const execStart = formatSystemdExecStart("/usr/bin/bun", ["run", "/path with spaces/app.ts", "--flag"]);
    expect(execStart).toBe('/usr/bin/bun run "/path with spaces/app.ts" --flag');
  });

  it("generates a full systemd unit file without newline leakage", () => {
    const unit = generateSystemdUnit({
      description: "My Service\nInjected=Evil",
      workingDir: "/home/user/my app",
      executable: "/usr/local/bin/bun",
      args: ["run", "app.ts"],
      env: {
        SECRET: 'foo"bar\nbaz',
        NODE_ENV: "production",
      },
      restartSec: 5,
    });

    expect(unit).toContain("Description=My Service Injected=Evil\n");
    expect(unit).toContain('WorkingDirectory="/home/user/my app"\n');
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run app.ts\n");
    expect(unit).toContain('Environment="SECRET=foo\\"bar baz"');
    expect(unit).toContain('Environment="NODE_ENV=production"');
    expect(unit).toContain("RestartSec=5\n");
  });
});