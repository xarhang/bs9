import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { exportCommand } from "../src/commands/export.js";
import { depsCommand } from "../src/commands/deps.js";
import { MetricsStorage } from "../src/storage/metrics.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Export & Deps Command QA Suite", () => {
  let stdoutLogs: string[] = [];
  const originalLog = console.log;
  const tempFiles: string[] = [];

  beforeEach(() => {
    stdoutLogs = [];
    console.log = (...args: any[]) => stdoutLogs.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    for (const f of tempFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {}
    }
  });

  it("exports system metrics to JSON file", async () => {
    const storage = new MetricsStorage();
    storage.storeSnapshot([{
      name: "qa-service",
      cpu: "12.5%",
      memory: 1024 * 1024 * 64,
      uptime: "1h 0m",
      tasks: 4,
      health: "healthy",
      state: "running"
    }]);

    const outPath = join(process.cwd(), `test-export-${Date.now()}.json`);
    tempFiles.push(outPath);

    await exportCommand({ format: "json", output: outPath, hours: "24" });
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("exports system metrics to CSV file", async () => {
    const storage = new MetricsStorage();
    storage.storeSnapshot([{
      name: "qa-service",
      cpu: "12.5%",
      memory: 1024 * 1024 * 64,
      uptime: "1h 0m",
      tasks: 4,
      health: "healthy",
      state: "running"
    }]);

    const outPath = join(process.cwd(), `test-export-${Date.now()}.csv`);
    tempFiles.push(outPath);

    await exportCommand({ format: "csv", output: outPath, hours: "1", service: "qa-service" });
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain("timestamp,service_name,cpu_ms,memory_bytes");
  });

  it("builds dependency graph in JSON format", async () => {
    const outPath = join(process.cwd(), `test-deps-${Date.now()}.json`);
    tempFiles.push(outPath);

    await depsCommand({ format: "json", output: outPath });
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed.services)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it("generates Graphviz DOT output for dependency graph", async () => {
    const outPath = join(process.cwd(), `test-deps-${Date.now()}.dot`);
    tempFiles.push(outPath);

    await depsCommand({ format: "dot", output: outPath });
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain("digraph");
  });

  it("prints human-readable dependency tree to console", async () => {
    await depsCommand({});
    expect(stdoutLogs.some(l => l.includes("BS9 Service Dependency Visualization"))).toBe(true);
  });
});
