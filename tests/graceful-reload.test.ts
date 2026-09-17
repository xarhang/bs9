import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { ControllerAdminClient } from "../src/cluster/admin-client.js";
import { reloadCommand } from "../src/commands/reload.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";

describe("Graceful Rolling Reload & Zero-Downtime Verification", () => {
  let controller: ClusterController;
  let adminClient: ControllerAdminClient;
  const clusterName = "graceful-api";
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-test-reload-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    : join(tmpdir(), `bs9-test-reload-${Date.now()}.sock`);
  let tokenFilePath: string;
  const testPort = 39400 + Math.floor(Math.random() * 400);
  const workerScriptPath = join(tmpdir(), `bs9-reload-worker-${Date.now()}.ts`);

  const activeProcs = new Map<string, any>();

  function spawnWorker(slot: number, gen: number) {
    const proc = Bun.spawn(["bun", "run", workerScriptPath], {
      env: {
        ...process.env,
        PORT: String(testPort),
        BS9_CLUSTER: "true",
        BS9_REUSE_PORT: "true",
        BS9_CLUSTER_NAME: clusterName,
        NODE_APP_INSTANCE: String(slot),
        BS9_CLUSTER_ID: String(slot),
        BS9_CLUSTER_GENERATION: String(gen),
        BS9_AUTH_TOKEN_FILE: tokenFilePath,
        BS9_CONTROLLER_SOCKET: socketPath,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    activeProcs.set(`${slot}:${gen}`, proc);
    return proc;
  }

  beforeAll(async () => {
    const adminToken = `graceful-admin-${Date.now()}`;
    controller = new ClusterController({ socketPath, adminToken });
    const reg = controller.registerClusterToken(clusterName);
    tokenFilePath = reg.tokenFilePath;
    await controller.start();
    adminClient = new ControllerAdminClient({ socketPath, adminToken });
    expect(await adminClient.connect()).toBe(true);

    const preloadPath = join(process.cwd(), "src", "utils", "cluster-preload.ts").replace(/\\/g, "/");
    writeFileSync(workerScriptPath, `
import "${preloadPath}";

const port = parseInt(process.env.PORT || "3000", 10);
Bun.serve({
  port,
  reusePort: true,
  async fetch(req) {
    // Micro-delay to simulate async endpoint I/O
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify({
      status: "ok",
      slot: process.env.NODE_APP_INSTANCE,
      generation: process.env.BS9_CLUSTER_GENERATION,
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
});
`);

    // Spawn 2 initial workers: slot 0 (g1), slot 1 (g1)
    spawnWorker(0, 1);
    spawnWorker(1, 1);

    const startWait = Date.now();
    while (
      (!controller.isSlotReady(clusterName, 0, 1) || !controller.isSlotReady(clusterName, 1, 1)) &&
      Date.now() - startWait < 10000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 1)).toBe(true);
  });

  afterAll(async () => {
    adminClient.disconnect();
    for (const proc of activeProcs.values()) {
      try { proc.kill(); } catch {}
    }
    activeProcs.clear();

    await controller.stop();
    try { unlinkSync(workerScriptPath); } catch {}
  });

  test("should achieve zero downtime with 100% HTTP 200 during Replace-First Rolling Reload under continuous load", async () => {
    const statuses: number[] = [];
    const generationsSeen = new Set<string>();
    let sending = true;

    // Continuous concurrent request traffic generator (10+ req/sec)
    const trafficPromise = (async () => {
      while (sending) {
        const batch = Array.from({ length: 5 }, async () => {
          try {
            const res = await fetch(`http://localhost:${testPort}`);
            statuses.push(res.status);
            if (res.status === 200) {
              const body = await res.json();
              if (body.generation) {
                generationsSeen.add(String(body.generation));
              }
            }
          } catch {
            statuses.push(0);
          }
        });
        await Promise.all(batch);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    // Ensure traffic generator has begun
    await new Promise((r) => setTimeout(r, 200));

    // Trigger rolling reload
    await reloadCommand([clusterName], {
      controller,
      readyTimeoutMs: 15000,
      drainTimeoutMs: 5000,
      spawnWorker: async (slot, nextGen) => {
        spawnWorker(slot, nextGen);
      },
      stopWorker: async (slot, currentGen) => {
        const p = activeProcs.get(`${slot}:${currentGen}`);
        if (p) {
          p.kill();
          activeProcs.delete(`${slot}:${currentGen}`);
        }
      },
    });

    // Let traffic continue briefly on the replacement generation
    await new Promise((r) => setTimeout(r, 300));
    sending = false;
    await trafficPromise;

    // Verify 100% of requests received HTTP 200 with zero dropped requests
    expect(statuses.length).toBeGreaterThanOrEqual(30);
    expect(statuses.filter((code) => code !== 200)).toEqual([]);
    expect(statuses.every((code) => code === 200)).toBe(true);

    // Verify traffic was served across both generation 1 and generation 2
    expect(generationsSeen.has("1")).toBe(true);
    expect(generationsSeen.has("2")).toBe(true);

    // Verify both slots are ready on generation 2
    expect(controller.isSlotReady(clusterName, 0, 2)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);
  });

  test("should abort reload and preserve old active worker if replacement fails readiness", async () => {
    let tornDownFailedGen = false;

    await expect(
      reloadCommand([clusterName], {
        controller,
        readyTimeoutMs: 800,
        drainTimeoutMs: 2000,
        spawnWorker: async (slot, nextGen) => {
          // Deliberately do not report ready
        },
        stopWorker: async (slot, gen) => {
          if (gen === 3) {
            tornDownFailedGen = true;
          }
        },
      })
    ).rejects.toThrow("failed readiness check");

    expect(tornDownFailedGen).toBe(true);

    // Old workers on generation 2 must still be alive and ready
    expect(controller.isSlotReady(clusterName, 0, 2)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);

    // Verify HTTP requests still succeed
    const res = await fetch(`http://localhost:${testPort}`);
    expect(res.status).toBe(200);
  });

  test("should stop scheduling reload side effects immediately after remote lock loss", async () => {
    let spawnCalls = 0;
    let stopCalls = 0;

    await expect(
      reloadCommand([clusterName], {
        controller,
        adminClient,
        readyTimeoutMs: 1000,
        spawnWorker: async () => {
          spawnCalls++;
          const lock = controller.getClusterLock(clusterName);
          expect(lock).not.toBeNull();
          controller.unlockCluster(clusterName, lock!.lockToken);
        },
        stopWorker: async () => {
          stopCalls++;
        },
      })
    ).rejects.toThrow(/lost or expired/);

    expect(spawnCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(controller.isSlotReady(clusterName, 0, 2)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);
  });
});
