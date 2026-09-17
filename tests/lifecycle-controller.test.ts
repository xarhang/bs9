import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { LifecycleClient } from "../src/cluster/lifecycle-client.js";
import { join } from "node:path";
import { homedir } from "node:os";

const testSocket = process.platform === "win32"
  ? `\\\\.\\pipe\\bs9-test-controller-${Date.now()}`
  : join(homedir(), `.bs9-test-ctrl-${Date.now()}.sock`);

describe("Cluster Lifecycle Controller & Client Integration", () => {
  let controller: ClusterController;
  const clusterName = "test-cluster";
  let authToken: string;

  beforeAll(async () => {
    controller = new ClusterController({ socketPath: testSocket });
    const reg = controller.registerClusterToken(clusterName);
    authToken = reg.token;
    await controller.start();
  });

  afterAll(async () => {
    await controller.stop();
  });

  test("should authenticate worker via challenge-response HMAC handshake", async () => {
    const client = new LifecycleClient({
      socketPath: testSocket,
      clusterName,
      slot: 0,
      generation: 1,
      authToken,
    });

    const connected = await client.connect();
    expect(connected).toBe(true);

    const worker = controller.getWorker(clusterName, 0, 1);
    expect(worker).toBeDefined();
    expect(worker?.status).toBe("connected");
    expect(worker?.slot).toBe(0);
    expect(worker?.generation).toBe(1);

    client.disconnect();
  });

  test("should reject worker attempting connection with invalid token", async () => {
    const client = new LifecycleClient({
      socketPath: testSocket,
      clusterName,
      slot: 1,
      generation: 1,
      authToken: "wrong-invalid-token",
    });

    const connected = await client.connect();
    expect(connected).toBe(false);

    const worker = controller.getWorker(clusterName, 1, 1);
    expect(worker).toBeUndefined();

    client.disconnect();
  });

  test("should handle LIFECYCLE_READY and report slot readiness", async () => {
    const client = new LifecycleClient({
      socketPath: testSocket,
      clusterName,
      slot: 0,
      generation: 1,
      authToken,
    });

    await client.connect();

    let readyEventFired = false;
    controller.once("worker:ready", (worker, payload) => {
      readyEventFired = true;
      expect(payload.port).toBe(4001);
    });

    await client.reportReady(4001, { framework: "bun.serve" });

    // Allow event tick
    await new Promise((r) => setTimeout(r, 50));

    expect(readyEventFired).toBe(true);
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 0, 2)).toBe(false);

    client.disconnect();
  });

  test("should execute two-phase graceful drain protocol", async () => {
    const client = new LifecycleClient({
      socketPath: testSocket,
      clusterName,
      slot: 0,
      generation: 1,
      authToken,
    });

    await client.connect();
    await client.reportReady(4002);

    let drainHandlerCalled = false;
    client.onDrain(async (timeoutMs) => {
      drainHandlerCalled = true;
      expect(timeoutMs).toBeGreaterThan(0);
      // Simulate active in-flight request draining
      await new Promise((r) => setTimeout(r, 100));
      return { inFlightRemaining: 0 };
    });

    const drainPromise = controller.drainWorker(clusterName, 0, 1, 3000);
    const drainResult = await drainPromise;

    expect(drainHandlerCalled).toBe(true);
    expect(drainResult.drained).toBe(true);
    expect(drainResult.inFlightRemaining).toBe(0);

    const worker = controller.getWorker(clusterName, 0, 1);
    expect(worker?.status).toBe("drained");

    client.disconnect();
  });
});
