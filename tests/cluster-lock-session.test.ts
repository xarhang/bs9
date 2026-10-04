import { describe, expect, it } from "bun:test";
import { ClusterLockSession } from "../src/cluster/admin-client.js";

describe("cluster lock session cleanup", () => {
  it("attempts token-checked unlock after a renewal error marks the session lost", async () => {
    let unlockAttempts = 0;
    const admin = {
      renewClusterLock: async () => { throw new Error("temporary IPC failure"); },
      unlockCluster: async (_clusterName: string, token: string) => {
        expect(token).toBe("held-token");
        unlockAttempts++;
        return true;
      },
    };
    const session = new ClusterLockSession(admin as any, "cluster-a", "held-token", {
      renewIntervalMs: 1,
      extendMs: 1000,
    });

    session.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.isLost()).toBe(true);
    expect(await session.release()).toBe(true);
    expect(unlockAttempts).toBe(1);
  });
});
