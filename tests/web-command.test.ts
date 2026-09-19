import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { isValidPort, getWebPidFile, readWebPidInfo, stopWebDashboard, isProcessAlive, webCommand } from "../src/commands/web.js";

describe("BS9 Web Command & Lifecycle QA Suite", () => {
  const pidFile = getWebPidFile();

  afterEach(() => {
    try {
      if (existsSync(pidFile)) {
        rmSync(pidFile, { force: true });
      }
    } catch {}
  });

  describe("Port validation", () => {
    it("accepts valid port numbers", () => {
      expect(isValidPort("80")).toBe(true);
      expect(isValidPort("8080")).toBe(true);
      expect(isValidPort("3000")).toBe(true);
      expect(isValidPort("65535")).toBe(true);
    });

    it("rejects invalid port numbers", () => {
      expect(isValidPort("0")).toBe(false);
      expect(isValidPort("-1")).toBe(false);
      expect(isValidPort("65536")).toBe(false);
      expect(isValidPort("abc")).toBe(false);
      expect(isValidPort("")).toBe(false);
    });
  });

  describe("PID file operations", () => {
    it("reads null when no pid file exists", () => {
      if (existsSync(pidFile)) rmSync(pidFile, { force: true });
      expect(readWebPidInfo()).toBeNull();
    });

    it("reads json pid info correctly", () => {
      writeFileSync(pidFile, JSON.stringify({ pid: 12345, port: "8080", startedAt: Date.now() }), "utf8");
      const info = readWebPidInfo();
      expect(info).not.toBeNull();
      expect(info?.pid).toBe(12345);
      expect(info?.port).toBe("8080");
    });

    it("reads plain integer pid correctly", () => {
      writeFileSync(pidFile, "54321", "utf8");
      const info = readWebPidInfo();
      expect(info).not.toBeNull();
      expect(info?.pid).toBe(54321);
    });
  });

  describe("Process liveness check", () => {
    it("detects current process as alive", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("detects non-existent pid as dead", () => {
      expect(isProcessAlive(999999)).toBe(false);
    });
  });

  describe("stopWebDashboard handling", () => {
    it("handles stop gracefully when no web dashboard is running", () => {
      if (existsSync(pidFile)) rmSync(pidFile, { force: true });
      const stopped = stopWebDashboard();
      expect(stopped).toBe(false);
    });

    it("cleans up stale pid file if process is already dead", () => {
      writeFileSync(pidFile, JSON.stringify({ pid: 999999, port: "8080" }), "utf8");
      expect(existsSync(pidFile)).toBe(true);

      const stopped = stopWebDashboard();
      expect(stopped).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    });

    it("terminates active running process and removes pid file", async () => {
      const { spawn } = await import("node:child_process");
      const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      expect(dummy.pid).toBeDefined();
      expect(isProcessAlive(dummy.pid!)).toBe(true);

      writeFileSync(pidFile, JSON.stringify({ pid: dummy.pid, port: "8080" }), "utf8");
      expect(existsSync(pidFile)).toBe(true);

      const stopped = stopWebDashboard();
      expect(stopped).toBe(true);
      expect(existsSync(pidFile)).toBe(false);

      // Verify dummy process is dead
      await Bun.sleep(100);
      expect(isProcessAlive(dummy.pid!)).toBe(false);
    });
  });

  describe("webCommand CLI dispatch", () => {
    it("handles webCommand('stop') without throwing", async () => {
      await expect(webCommand("stop")).resolves.toBeUndefined();
    });

    it("handles webCommand({ stop: true }) without throwing", async () => {
      await expect(webCommand({ stop: true })).resolves.toBeUndefined();
    });

    it("handles webCommand('status') without throwing", async () => {
      await expect(webCommand("status")).resolves.toBeUndefined();
    });
  });
});
