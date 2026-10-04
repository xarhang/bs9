import { describe, expect, it } from "bun:test";
import { ClusterReconciler } from "../src/daemon/reconciler.js";
import type { ClusterController } from "../src/cluster/controller.js";
import type { ClusterManifestData } from "../src/hub/protocol.js";

describe("cluster reconciler manifest serialization", () => {
  it("re-reads desired state and holds the cluster lock through persistence and resurrection", async () => {
    const staleSnapshot: ClusterManifestData = {
      clusterName: "reconcile-lock-test",
      appFile: "C:\\apps\\test.ts",
      instances: 1,
      port: 3000,
      host: "127.0.0.1",
      env: {},
      options: { windowsServiceAccount: "LocalSystem" },
      currentGeneration: 1,
      updatedAt: 1,
    };
    let persisted: ClusterManifestData = {
      ...staleSnapshot,
      options: { windowsServiceAccount: "LocalService" },
      updatedAt: 2,
    };
    let locked = false;
    let lockAcquisitions = 0;
    const controller = {
      on: () => controller,
      off: () => controller,
      setReconcilerProvider: () => undefined,
      getLockedClusters: () => locked ? ["reconcile-lock-test"] : [],
      getAllManifests: () => [{ ...staleSnapshot }],
      isClusterLocked: () => locked,
      getClusterWorkers: () => [],
      lockCluster: () => {
        if (locked) return { acquired: false, lockToken: null };
        locked = true;
        lockAcquisitions++;
        return { acquired: true, lockToken: "test-token" };
      },
      renewClusterLock: () => ({ renewed: locked }),
      getManifest: () => ({ ...persisted, options: { ...persisted.options } }),
      setManifest: (manifest: ClusterManifestData) => {
        expect(locked).toBe(true);
        persisted = manifest;
      },
      unlockCluster: () => {
        locked = false;
        return true;
      },
    } as unknown as ClusterController;
    const reconciler = new ClusterReconciler(controller, {
      intervalMs: 60_000,
      missingGraceMs: 0,
      onResurrectSlot: async (manifest) => {
        expect(locked).toBe(true);
        expect(manifest.options?.windowsServiceAccount).toBe("LocalService");
      },
    });

    reconciler.start();
    try {
      await reconciler.reconcile();
      await reconciler.reconcile();
    } finally {
      reconciler.stop();
    }

    expect(lockAcquisitions).toBe(1);
    expect(persisted.currentGeneration).toBe(2);
    expect(persisted.options?.windowsServiceAccount).toBe("LocalService");
    expect(locked).toBe(false);
  });
});
