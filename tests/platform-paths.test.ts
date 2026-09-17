import { describe, test, expect } from "bun:test";
import { getPlatformInfo, initializePlatformDirectories } from "../src/platform/detect.js";
import { existsSync } from "node:fs";

describe("Platform Paths & Info", () => {
  test("should include runtimeDir, stateDir, clusterDir, and socketPath", () => {
    const info = getPlatformInfo();

    expect(typeof info.runtimeDir).toBe("string");
    expect(info.runtimeDir.length).toBeGreaterThan(0);

    expect(typeof info.stateDir).toBe("string");
    expect(info.stateDir.length).toBeGreaterThan(0);

    expect(typeof info.clusterDir).toBe("string");
    expect(info.clusterDir.length).toBeGreaterThan(0);

    expect(typeof info.socketPath).toBe("string");
    expect(info.socketPath.length).toBeGreaterThan(0);

    if (info.isWindows) {
      expect(info.socketPath.startsWith("\\\\.\\pipe\\")).toBe(true);
    } else {
      expect(info.socketPath.endsWith(".sock")).toBe(true);
    }
  });

  test("should preserve backward compatibility with existing path fields", () => {
    const info = getPlatformInfo();

    expect(typeof info.configDir).toBe("string");
    expect(typeof info.logDir).toBe("string");
    expect(typeof info.serviceDir).toBe("string");
    expect(typeof info.backupDir).toBe("string");
  });

  test("initializePlatformDirectories should create all directories without error", () => {
    initializePlatformDirectories();
    const info = getPlatformInfo();

    expect(existsSync(info.configDir)).toBe(true);
    expect(existsSync(info.logDir)).toBe(true);
    expect(existsSync(info.backupDir)).toBe(true);
    expect(existsSync(info.serviceDir)).toBe(true);
    expect(existsSync(info.runtimeDir)).toBe(true);
    expect(existsSync(info.stateDir)).toBe(true);
    expect(existsSync(info.clusterDir)).toBe(true);
  });
});
