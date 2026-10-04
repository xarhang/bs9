import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireManifestLock, removeManifestIfPresent, withManifestLock } from "../src/utils/manifest-lock.js";
import { ClusterController } from "../src/cluster/controller.js";
import { getPlatformInfo } from "../src/platform/detect.js";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "bs9-manifest-lock-"));
  tempDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cluster manifest mutation lock", () => {
  it("serializes manifest updates and releases the lock after exceptions", () => {
    const manifestPath = join(makeTempDirectory(), "cluster.manifest.json");
    const lockPath = `${manifestPath}.lock`;
    expect(() => withManifestLock(manifestPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      throw new Error("simulated manifest write failure");
    })).toThrow("simulated manifest write failure");
    expect(existsSync(lockPath)).toBe(false);

    expect(withManifestLock(manifestPath, () => "committed")).toBe("committed");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails closed when a lock is already held and leaves the owner's lock untouched", () => {
    const manifestPath = join(makeTempDirectory(), "cluster.manifest.json");
    const release = acquireManifestLock(manifestPath);
    const lockPath = `${manifestPath}.lock`;
    expect(() => withManifestLock(manifestPath, () => {
      writeFileSync(manifestPath, "should not run");
    }, 0)).toThrow(/Timed out waiting for manifest lock/);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("deletes only while holding the same manifest lock", () => {
    const manifestPath = join(makeTempDirectory(), "cluster.manifest.json");
    writeFileSync(manifestPath, "{}");
    expect(removeManifestIfPresent(manifestPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
    expect(removeManifestIfPresent(manifestPath)).toBe(false);
  });

  it("refuses controller manifest deletion while a cluster lifecycle lock is active", () => {
    const previousHome = process.env.BS9_HOME;
    const home = makeTempDirectory();
    process.env.BS9_HOME = home;
    try {
      const controller = new ClusterController({ socketPath: join(home, "controller.sock") });
      const manifest = {
        clusterName: "locked-cluster",
        appFile: join(home, "app.ts"),
        instances: 1,
        port: 3000,
        host: "127.0.0.1",
        env: {},
        updatedAt: Date.now(),
      };
      controller.setManifest(manifest);
      const lock = controller.lockCluster("locked-cluster", "manual", 30_000, "manifest-lock-test");
      expect(lock.acquired).toBe(true);
      expect(controller.deleteManifest("locked-cluster")).toBe(false);
      expect(existsSync(join(getPlatformInfo().clusterDir, "locked-cluster.manifest.json"))).toBe(true);
      expect(controller.deleteManifest("locked-cluster", lock.lockToken!)).toBe(true);
      expect(controller.unlockCluster("locked-cluster", lock.lockToken!)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BS9_HOME;
      else process.env.BS9_HOME = previousHome;
    }
  });
});
