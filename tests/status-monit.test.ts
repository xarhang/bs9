import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { statusCommand } from "../src/commands/status.js";
import { monitCommand } from "../src/commands/monit.js";

describe("Status and Monit Display Formats", () => {
  let stdoutLogs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    stdoutLogs = [];
    console.log = (...args: any[]) => {
      stdoutLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("exports statusCommand and monitCommand functions", () => {
    expect(typeof statusCommand).toBe("function");
    expect(typeof monitCommand).toBe("function");
  });

  it("handles statusCommand with empty services list cleanly", async () => {
    await statusCommand([], { json: true });
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutLogs[0]);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("handles statusCommand with raw flag outputting valid JSON", async () => {
    await statusCommand([], { raw: true });
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const rawOutput = stdoutLogs.join("");
    expect(() => JSON.parse(rawOutput)).not.toThrow();
  }, 15000);

  it("handles multi-service status with 'all' keyword", async () => {
    await statusCommand(["all"], { json: true });
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutLogs[0]);
    expect(Array.isArray(parsed)).toBe(true);
  }, 15000);

  it("handles status filtering by non-existent service name gracefully", async () => {
    await statusCommand(["non-existent-svc-999"], { json: true });
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutLogs[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  }, 15000);
});
