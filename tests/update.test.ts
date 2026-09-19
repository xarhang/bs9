import { describe, expect, it } from "bun:test";
import { BS9Updater, isValidVersion } from "../src/commands/update.js";

describe("BS9 update command and version comparison", () => {
  const updater = new BS9Updater();

  describe("isValidVersion", () => {
    it("accepts valid semver versions", () => {
      expect(isValidVersion("1.0.0")).toBe(true);
      expect(isValidVersion("1.6.11")).toBe(true);
      expect(isValidVersion("2.0.0-beta.1")).toBe(true);
      expect(isValidVersion("latest")).toBe(true);
    });

    it("rejects invalid semver versions", () => {
      expect(isValidVersion("")).toBe(false);
      expect(isValidVersion("v1.0.0")).toBe(false);
      expect(isValidVersion("1.0")).toBe(false);
      expect(isValidVersion("1.0.0; rm -rf /")).toBe(false);
      expect(isValidVersion("$(whoami)")).toBe(false);
      expect(isValidVersion("undefined")).toBe(false);
    });
  });

  describe("compareVersions", () => {
    it("correctly identifies newer versions", () => {
      expect(updater.compareVersions("1.6.11", "1.6.10")).toBeGreaterThan(0);
      expect(updater.compareVersions("1.7.0", "1.6.11")).toBeGreaterThan(0);
      expect(updater.compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    });

    it("correctly identifies older versions", () => {
      expect(updater.compareVersions("1.3.4", "1.6.10")).toBeLessThan(0);
      expect(updater.compareVersions("1.6.10", "1.6.11")).toBeLessThan(0);
      expect(updater.compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    });

    it("correctly identifies identical versions", () => {
      expect(updater.compareVersions("1.6.11", "1.6.11")).toBe(0);
      expect(updater.compareVersions("1.0.0", "1.0.0")).toBe(0);
    });
  });

  describe("version update detection logic", () => {
    it("does not report update when current is equal to latest", () => {
      const current = "1.6.11";
      const latest = "1.6.11";
      const hasUpdate = updater.compareVersions(latest, current) > 0;
      expect(hasUpdate).toBe(false);
    });

    it("reports update when latest is newer than current", () => {
      const current = "1.6.10";
      const latest = "1.6.11";
      const hasUpdate = updater.compareVersions(latest, current) > 0;
      expect(hasUpdate).toBe(true);
    });

    it("never reports update when latest is older than current (prevent downgrade bug)", () => {
      const current = "1.6.10";
      const fallbackOld = "1.3.4";
      const hasUpdate = updater.compareVersions(fallbackOld, current) > 0;
      expect(hasUpdate).toBe(false);
    });
  });

  describe("getCurrentVersion", () => {
    it("resolves current version from package.json without crashing or returning 0.0.0", () => {
      const version = updater.getCurrentVersion();
      expect(version).not.toBe("0.0.0");
      expect(version).not.toBe("1.3.4");
      expect(isValidVersion(version)).toBe(true);
    });
  });
});
