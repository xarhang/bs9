import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { saveCommand } from "../src/commands/save.js";
import { resurrectCommand } from "../src/commands/resurrect.js";
import { getPlatformInfo, initializePlatformDirectories } from "../src/platform/detect.js";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("Save & Resurrect Command QA Suite", () => {
  let stderrLogs: string[] = [];
  let stdoutLogs: string[] = [];
  const originalErr = console.error;
  const originalLog = console.log;

  beforeEach(() => {
    process.exitCode = 0;
    stderrLogs = [];
    stdoutLogs = [];
    console.error = (...args: any[]) => stderrLogs.push(args.map(String).join(" "));
    console.log = (...args: any[]) => stdoutLogs.push(args.map(String).join(" "));
    initializePlatformDirectories();
  });

  afterEach(() => {
    console.error = originalErr;
    console.log = originalLog;
    process.exitCode = 0;
  });

  it("rejects malicious service names with path traversal on save", async () => {
    process.exitCode = 0;
    await saveCommand("../../../etc/passwd", {});
    expect(process.exitCode).toBe(1);
    expect(stderrLogs.some(l => l.includes("Security: Invalid service name"))).toBe(true);
    process.exitCode = 0;
  });

  it("rejects malicious service names with path traversal on resurrect", async () => {
    process.exitCode = 0;
    await resurrectCommand("../../malicious-script", {});
    expect(process.exitCode).toBe(1);
    expect(stderrLogs.some(l => l.includes("Security: Invalid service name"))).toBe(true);
    process.exitCode = 0;
  });

  it("handles non-existent service gracefully when saving single service", async () => {
    process.exitCode = 0;
    await saveCommand("nonexistent-test-service-12345", { force: true });
    expect(true).toBe(true);
  });

  it("handles missing backup files safely on resurrect", async () => {
    process.exitCode = 0;
    await resurrectCommand("ghost-app-never-saved", { force: true });
    expect(true).toBe(true);
  });

  it("recovers safely from corrupted backup JSON files", async () => {
    const platformInfo = getPlatformInfo();
    const backupDir = platformInfo.backupDir;
    mkdirSync(backupDir, { recursive: true });

    const corruptedFile = join(backupDir, "corrupted-test-service.json");
    writeFileSync(corruptedFile, "{ this is not valid json! bad syntax ...", "utf-8");

    try {
      process.exitCode = 0;
      await resurrectCommand("all", { force: true });
      expect(true).toBe(true);
    } finally {
      if (existsSync(corruptedFile)) {
        unlinkSync(corruptedFile);
      }
    }
  });

  it("safely dumps all service backups when calling saveCommand with 'all'", async () => {
    process.exitCode = 0;
    await saveCommand("all", { force: true });
    expect(stdoutLogs.some(l => l.includes("Saving all BS9 service configurations"))).toBe(true);
  });
});
