import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { doctorCommand } from "../src/commands/doctor.js";
import * as health from "../src/utils/health.js";
import { getPlatformInfo, initializePlatformDirectories } from "../src/platform/detect.js";

describe("Doctor Diagnostics and Health Checks", () => {
  let stdoutLogs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    initializePlatformDirectories();
    stdoutLogs = [];
    console.log = (...args: any[]) => {
      stdoutLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("checks bun runtime installation correctly", () => {
    const res = health.checkBunInstallation();
    expect(res.name).toBe("Bun Installation");
    expect(res.status).toBe("✅ PASS");
    expect(res.score).toBe(100);
    expect(res.message).toContain("Bun");
  });

  it("checks bs9 installation correctly", () => {
    const res = health.checkBS9Installation();
    expect(res.name).toBe("BS9 Installation");
    expect(res.status).toBe("✅ PASS");
  });

  it("checks platform detection and environment directories", () => {
    const platformInfo = getPlatformInfo();
    const res = health.checkPlatformDetection(platformInfo);
    expect(res.name).toBe("Platform Detection");
    expect(res.status).toBe("✅ PASS");

    const dirRes = health.checkDirectoryStructure(platformInfo);
    expect(dirRes.name).toBe("Directory Structure");
    expect(dirRes.status).toBe("✅ PASS");
  });

  it("checks platform service manager availability", () => {
    const platformInfo = getPlatformInfo();
    const res = health.checkServiceManager(platformInfo);
    expect(res.name).toBe("Service Manager");
    expect(["✅ PASS", "⚠️ WARN"]).toContain(res.status);
  });

  it("runs full doctorCommand diagnostic suite without throwing", async () => {
    await doctorCommand({});
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const output = stdoutLogs.join("\n");
    expect(output).toContain("BS9 Health Check & Diagnostics");
    expect(output).toContain("Bun Installation");
  }, 15_000);

  it("runs doctorCommand with verbose mode", async () => {
    await doctorCommand({ verbose: true });
    expect(stdoutLogs.length).toBeGreaterThan(0);
    const output = stdoutLogs.join("\n");
    expect(output).toContain("Health Check Summary:");
  }, 15_000);

  it("runs doctorCommand with targeted check filter", async () => {
    await doctorCommand({ check: "bun" });
    expect(stdoutLogs.length).toBeGreaterThan(0);
  }, 15_000);
});
