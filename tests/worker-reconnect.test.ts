import { describe, it, expect, afterEach } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { LifecycleClient } from "../src/cluster/lifecycle-client.js";
import { getPlatformInfo } from "../src/platform/detect.js";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

describe("Worker Lifecycle Reconnect and Auto Re-Registration", () => {
  let controller: ClusterController | null = null;
  let client: LifecycleClient | null = null;
  const platformInfo = getPlatformInfo();
  const testId = Date.now();
  const socketPath = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-reconnect-${testId}`
    : join(platformInfo.runtimeDir, `reconnect-${testId}.sock`);
  const clusterName = `rec-app-${testId}`;

  afterEach(() => {
    if (client) {
      client.disconnect();
      client = null;
    }
    if (controller) {
      controller.stop();
      controller = null;
    }
    if (!platformInfo.isWindows && existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
  });

  it("should automatically reconnect, re-authenticate, and re-dispatch READY when controller restarts", async () => {
    // 1. Start initial controller
    controller = new ClusterController({ socketPath });
    await controller.start();
    const { tokenFilePath } = controller.registerClusterToken(clusterName);

    // 2. Connect worker lifecycle client and report READY
    client = new LifecycleClient({
      socketPath,
      clusterName,
      slot: 0,
      generation: 1,
      authTokenFile: tokenFilePath,
    });

    const connected = await client.connect();
    expect(connected).toBe(true);

    const initialReadyPromise = new Promise<void>((res) => {
      controller!.once("worker:ready", () => res());
    });
    await client.reportReady(3000, { framework: "bun.serve" });
    await initialReadyPromise;
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);

    // 3. Stop controller abruptly (simulate daemon/controller restart)
    await controller.stop();
    controller = null;

    // Wait briefly for client to detect disconnect
    await new Promise((r) => setTimeout(r, 150));

    // 4. Start new controller on the same socket path
    const reconnectedPromise = new Promise<void>((resolve) => {
      client!.once("reconnected", () => {
        resolve();
      });
    });

    controller = new ClusterController({ socketPath });
    await controller.start();
    controller.registerClusterToken(clusterName);

    // 5. Client should automatically reconnect and re-dispatch READY
    await reconnectedPromise;

    // Verify slot readiness is automatically restored in new controller
    for (let i = 0; i < 25; i++) {
      if (controller.isSlotReady(clusterName, 0, 1)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    const workers = controller.getClusterWorkers(clusterName);
    expect(workers.length).toBe(1);
    expect(workers[0].slot).toBe(0);
    expect(workers[0].generation).toBe(1);
    expect(workers[0].status).toBe("ready");
  });
});