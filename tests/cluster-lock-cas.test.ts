import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { ControllerAdminClient } from "../src/cluster/admin-client.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";

describe("Cluster Lock Mutual Exclusion & CAS Ownership", () => {
  const testId = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const sandboxDir = join(tmpdir(), `bs9-lock-test-${testId}`);
  const origHome = process.env.BS9_HOME;
  process.env.BS9_HOME = sandboxDir;

  const clusterName = `lock-test-${testId}`;
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-lock-test-${testId}`
    : join(sandboxDir, `bs9-lock-test-${testId}.sock`);
  const adminToken = `admin_tok_${testId}`;

  let controller: ClusterController;
  let clientA: ControllerAdminClient;
  let clientB: ControllerAdminClient;

  beforeAll(async () => {
    mkdirSync(sandboxDir, { recursive: true });
    controller = new ClusterController({ socketPath, adminToken });
    await controller.start();

    clientA = new ControllerAdminClient({ socketPath, adminToken });
    clientB = new ControllerAdminClient({ socketPath, adminToken });
    expect(await clientA.connect()).toBe(true);
    expect(await clientB.connect()).toBe(true);
  });

  afterAll(async () => {
    clientA.disconnect();
    clientB.disconnect();
    await controller.stop();
    if (origHome !== undefined) {
      process.env.BS9_HOME = origHome;
    } else {
      delete process.env.BS9_HOME;
    }
    try {
      if (existsSync(sandboxDir)) {
        rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it("enforces strict mutual exclusion, ownership tokens, and compare-and-set release", async () => {
    // 1. Client A acquires lock
    const lockA = await clientA.lockCluster(clusterName, "reload", 10000, "worker-A");
    expect(lockA.locked).toBe(true);
    expect(lockA.lockToken).toBeDefined();
    expect(lockA.lockToken?.length).toBeGreaterThan(10);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 2. Client B attempts to acquire lock on the same cluster -> MUST BE REJECTED
    const lockB = await clientB.lockCluster(clusterName, "scale", 10000, "worker-B");
    expect(lockB.locked).toBe(false);
    expect(lockB.lockToken).toBeNull();
    expect(lockB.currentOwner).toBe("worker-A");
    expect(lockB.reason).toBe("reload");

    // 3. Client B attempts to unlock Client A's lock with wrong token -> MUST BE REJECTED
    const bogusUnlock = await clientB.unlockCluster(clusterName, "bogus-token-12345");
    expect(bogusUnlock).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 4. Client B attempts to renew Client A's lock with wrong token -> MUST BE REJECTED
    const bogusRenew = await clientB.renewClusterLock(clusterName, "bogus-token-12345", 20000);
    expect(bogusRenew).toBe(false);

    // 5. Client A renews lock with matching token -> MUST SUCCEED
    const validRenew = await clientA.renewClusterLock(clusterName, lockA.lockToken!, 30000);
    expect(validRenew).toBe(true);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 6. Client A releases lock with matching token -> MUST SUCCEED
    const validUnlock = await clientA.unlockCluster(clusterName, lockA.lockToken!);
    expect(validUnlock).toBe(true);
    expect(controller.isClusterLocked(clusterName)).toBe(false);

    // 7. Client B can now acquire the lock
    const lockB2 = await clientB.lockCluster(clusterName, "scale", 10000, "worker-B");
    expect(lockB2.locked).toBe(true);
    expect(lockB2.lockToken).toBeDefined();
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // Cleanup Client B's lock
    await clientB.unlockCluster(clusterName, lockB2.lockToken!);
    expect(controller.isClusterLocked(clusterName)).toBe(false);
  });

  it("strictly rejects unlock when lockToken is missing, empty, or undefined", async () => {
    const lock = await clientA.lockCluster(clusterName, "reload", 10000, "worker-A");
    expect(lock.locked).toBe(true);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 1. Attempt unlock with empty string token
    const emptyUnlock = await clientA.unlockCluster(clusterName, "");
    expect(emptyUnlock).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 2. Attempt unlock with undefined/null token cast
    const undefinedUnlock = await clientA.unlockCluster(clusterName, undefined as any);
    expect(undefinedUnlock).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // 3. Directly verify controller method rejects missing token
    const directUndefinedUnlock = controller.unlockCluster(clusterName, undefined as any);
    expect(directUndefinedUnlock).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    const directEmptyUnlock = controller.unlockCluster(clusterName, "");
    expect(directEmptyUnlock).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // Valid release with token
    const validUnlock = await clientA.unlockCluster(clusterName, lock.lockToken!);
    expect(validUnlock).toBe(true);
    expect(controller.isClusterLocked(clusterName)).toBe(false);
  });

  it("rejects renewal on expired lock and prevents stale-token resurrection", async () => {
    // Acquire lock with short TTL of 60ms
    const lock = await clientA.lockCluster(clusterName, "manual", 60, "worker-exp");
    expect(lock.locked).toBe(true);
    expect(controller.isClusterLocked(clusterName)).toBe(true);

    // Wait 100ms for lock to naturally expire
    await new Promise((r) => setTimeout(r, 100));

    // Stale token attempts to renew expired lock -> MUST BE REJECTED
    const renewResult = await clientA.renewClusterLock(clusterName, lock.lockToken!, 10000);
    expect(renewResult).toBe(false);

    // Verify lock is not resurrected
    expect(controller.isClusterLocked(clusterName)).toBe(false);

    // Another client can now acquire cleanly
    const newLock = await clientB.lockCluster(clusterName, "scale", 10000, "worker-B");
    expect(newLock.locked).toBe(true);
    await clientB.unlockCluster(clusterName, newLock.lockToken!);
  });

  it("maintains lock during long-running operations via ClusterLockSession heartbeat and aborts if lost", async () => {
    const { ClusterLockSession } = await import("../src/cluster/admin-client.js");

    // Initial lock with 120ms timeout
    const lock = await clientA.lockCluster(clusterName, "reload", 120, "worker-session");
    expect(lock.locked).toBe(true);

    // Heartbeat every 40ms extending by 150ms
    let lockLostDetected = false;
    const session = new ClusterLockSession(clientA, clusterName, lock.lockToken!, {
      renewIntervalMs: 40,
      extendMs: 150,
      onLost: () => { lockLostDetected = true; },
    });
    session.start();

    // Run for 220ms (would have expired without heartbeat renewal)
    await new Promise((r) => setTimeout(r, 220));
    expect(session.isLost()).toBe(false);
    expect(controller.isClusterLocked(clusterName)).toBe(true);
    expect(() => session.checkActive()).not.toThrow();

    // Simulate external lock loss (e.g. timeout or manual release)
    controller.unlockCluster(clusterName, lock.lockToken!);
    expect(controller.isClusterLocked(clusterName)).toBe(false);

    // Wait for next heartbeat tick (40ms) to detect lock loss
    await new Promise((r) => setTimeout(r, 80));
    expect(session.isLost()).toBe(true);
    expect(lockLostDetected).toBe(true);
    expect(() => session.checkActive()).toThrow(/lost or expired/);

    await session.release();
  });

  it("detects remote lock loss immediately at an assertActive side-effect boundary", async () => {
    const { ClusterLockSession } = await import("../src/cluster/admin-client.js");
    const lock = await clientA.lockCluster(clusterName, "reload", 10000, "boundary-test");
    expect(lock.locked).toBe(true);

    const session = new ClusterLockSession(clientA, clusterName, lock.lockToken!, {
      renewIntervalMs: 5000,
      extendMs: 10000,
    });
    await session.assertActive();

    expect(await clientB.unlockCluster(clusterName, lock.lockToken!)).toBe(true);
    await expect(session.assertActive()).rejects.toThrow(/lost or expired/);
    expect(session.signal.aborted).toBe(true);
    expect(session.isLost()).toBe(true);
    await session.release();
  });
});
