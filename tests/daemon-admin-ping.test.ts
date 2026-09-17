import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { ControllerAdminClient } from "../src/cluster/admin-client.js";
import { LifecycleClient } from "../src/cluster/lifecycle-client.js";
import { encodeFrame, createEnvelope } from "../src/hub/protocol.js";
import { getPlatformInfo } from "../src/platform/detect.js";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

describe("Daemon Admin IPC Authorization & Component PING", () => {
  const platformInfo = getPlatformInfo();
  const testId = Date.now();
  const socketPath = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-admin-${testId}`
    : join(platformInfo.runtimeDir, `admin-${testId}.sock`);
  const clusterName = `admin-test-cluster-${testId}`;

  let controller: ClusterController;
  let adminClient: ControllerAdminClient;
  let workerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    controller = new ClusterController({ socketPath });
    const regAdmin = controller.getOrCreateAdminToken();
    adminToken = regAdmin.token;

    const regWorker = controller.registerClusterToken(clusterName);
    workerToken = regWorker.token;

    // Set providers for component status
    controller.setHubProvider(() => ({
      listening: true,
      namespacesCount: 3,
      walRecovered: true,
      walRecordsCount: 42,
    }));

    controller.setReconcilerProvider(() => ({
      active: true,
      lockedClusters: controller.getLockedClusters(),
      managedClustersCount: controller.getAllManifests().length,
    }));

    await controller.start();
  });

  afterAll(async () => {
    if (adminClient) {
      adminClient.disconnect();
    }
    await controller.stop();
    if (!platformInfo.isWindows && existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
  });

  it("should strictly reject worker token trying to perform admin operations", async () => {
    // Connect as a normal cluster worker
    const workerClient = new LifecycleClient({
      socketPath,
      clusterName,
      slot: 0,
      generation: 1,
      authToken: workerToken,
    });

    const connected = await workerClient.connect();
    expect(connected).toBe(true);

    // Attempt to send an admin request over the worker socket
    const adminReq = createEnvelope("ADMIN_PING", "system", {});
    const errorPromise = new Promise<{ code?: string; error: string }>((resolve) => {
      // Controller sends ADMIN_ERROR and destroys socket
      (workerClient as any).decoder = {
        push: (chunk: Buffer) => {
          const envelopes = new (require("../src/hub/protocol.js").StreamingFrameDecoder)().push(chunk);
          for (const env of envelopes) {
            if (env.type === "ADMIN_ERROR") {
              resolve(env.payload);
            }
          }
          return envelopes;
        },
      };
    });

    (workerClient as any).send(adminReq);

    const errorPayload = await Promise.race([
      errorPromise,
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for rejection")), 2000)),
    ]);

    expect(errorPayload).not.toBeNull();
    expect(errorPayload!.code).toBe("ERR_UNAUTHORIZED");
    expect(errorPayload!.error).toContain("Unauthorized: Admin authorization required");

    workerClient.disconnect();
  });

  it("should authorize admin client with admin token and report full component ping", async () => {
    adminClient = new ControllerAdminClient({
      socketPath,
      adminToken,
    });

    const connected = await adminClient.connect();
    expect(connected).toBe(true);

    const report = await adminClient.ping();
    expect(report.status).toBe("ok");
    expect(report.controller.listening).toBe(true);
    expect(report.controller.socketPath).toBe(socketPath);

    // Verify Hub status
    expect(report.hub.listening).toBe(true);
    expect(report.hub.namespacesCount).toBe(3);
    expect(report.hub.walRecovered).toBe(true);
    expect(report.hub.walRecordsCount).toBe(42);

    // Verify Reconciler status
    expect(report.reconciler.active).toBe(true);
    expect(Array.isArray(report.reconciler.lockedClusters)).toBe(true);
  });

  it("should support cluster locking and unlocking via admin IPC", async () => {
    // Lock cluster for reload
    const lockRes = await adminClient.lockCluster(clusterName, "reload");
    expect(lockRes.locked).toBe(true);

    // Ping should report locked cluster
    const report1 = await adminClient.ping();
    expect(report1.reconciler.lockedClusters).toContain(clusterName);

    // Unlock cluster
    const unlocked = await adminClient.unlockCluster(clusterName, lockRes.lockToken!);
    expect(unlocked).toBe(true);

    // Ping should no longer report locked cluster
    const report2 = await adminClient.ping();
    expect(report2.reconciler.lockedClusters).not.toContain(clusterName);
  });

  it("should perform desired-state manifest CRUD via admin IPC", async () => {
    const manifest = {
      clusterName,
      appFile: "/app/server.ts",
      instances: 4,
      port: 8080,
      host: "0.0.0.0",
      env: { NODE_ENV: "production" },
      currentGeneration: 1,
      updatedAt: Date.now(),
    };

    // 1. Set manifest
    const setSuccess = await adminClient.setManifest(manifest);
    expect(setSuccess).toBe(true);

    // 2. Get manifest
    const fetched = await adminClient.getManifest(clusterName);
    expect(fetched).not.toBeNull();
    expect(fetched!.clusterName).toBe(clusterName);
    expect(fetched!.instances).toBe(4);
    expect(fetched!.port).toBe(8080);
    expect(fetched!.currentGeneration).toBe(1);

    // 3. Delete manifest
    const deleted = await adminClient.deleteManifest(clusterName);
    expect(deleted).toBe(true);

    // 4. Verify deleted
    const missing = await adminClient.getManifest(clusterName);
    expect(missing).toBeNull();
  });
});