import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { join } from "node:path";
import { homedir } from "node:os";

const testSocket = process.platform === "win32"
  ? `\\\\.\\pipe\\bs9-preload-test-${Date.now()}`
  : join(homedir(), `.bs9-preload-test-${Date.now()}.sock`);

describe("Cluster Preload Hook Integration", () => {
  let controller: ClusterController;
  const clusterName = "preload-test";
  let tokenFilePath: string;

  beforeAll(async () => {
    controller = new ClusterController({ socketPath: testSocket });
    const reg = controller.registerClusterToken(clusterName);
    tokenFilePath = reg.tokenFilePath;
    await controller.start();

    // Set cluster environment variables
    process.env.BS9_CLUSTER = "true";
    process.env.BS9_REUSE_PORT = "true";
    process.env.BS9_CLUSTER_NAME = clusterName;
    process.env.NODE_APP_INSTANCE = "0";
    process.env.BS9_CLUSTER_GENERATION = "1";
    process.env.BS9_AUTH_TOKEN_FILE = tokenFilePath;
    process.env.BS9_CONTROLLER_SOCKET = testSocket;

    // Load preload hook
    await import("../src/utils/cluster-preload.js");
  });

  afterAll(async () => {
    delete process.env.BS9_CLUSTER;
    delete process.env.BS9_REUSE_PORT;
    delete process.env.BS9_CLUSTER_NAME;
    delete process.env.NODE_APP_INSTANCE;
    delete process.env.BS9_CLUSTER_GENERATION;
    delete process.env.BS9_AUTH_TOKEN_FILE;
    delete process.env.BS9_CONTROLLER_SOCKET;

    await controller.stop();
  });

  test("Bun.serve should automatically inject reusePort: true and report READY", async () => {
    let readyReceived = false;
    let boundPort = 0;

    controller.once("worker:ready", (worker, payload) => {
      readyReceived = true;
      boundPort = payload.port;
    });

    const server = Bun.serve({
      port: 0, // ephemeral port
      fetch(req) {
        return new Response("OK from cluster worker");
      },
    });

    expect(server.port).toBeGreaterThan(0);

    // Wait for async lifecycle ready dispatch
    await new Promise((r) => setTimeout(r, 150));

    expect(readyReceived).toBe(true);
    expect(boundPort).toBe(server.port!);
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);

    // Verify HTTP fetch works
    const res = await fetch(`http://localhost:${server.port}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("OK from cluster worker");

    server.stop(true);
  });
});
