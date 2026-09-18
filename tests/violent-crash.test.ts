import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ClusterController } from "../src/cluster/controller.js";
import { ClusterReconciler } from "../src/daemon/reconciler.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

describe("High-Availability Violent Worker Crash Recovery", () => {
  let controller: ClusterController;
  let reconciler: ClusterReconciler;
  const clusterName = "crash-cluster";
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-test-crash-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    : join(tmpdir(), `bs9-test-crash-${Date.now()}.sock`);
  let tokenFilePath: string;
  const testPort = 39800 + Math.floor(Math.random() * 200);
  const workerScriptPath = join(tmpdir(), `bs9-crash-worker-${Date.now()}.ts`);

  const activeProcs: any[] = [];

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
      windowsHide: true,
    });
    activeProcs.push(proc);
    return proc;
  }

  beforeAll(async () => {
    controller = new ClusterController({ socketPath });
    const reg = controller.registerClusterToken(clusterName);
    tokenFilePath = reg.tokenFilePath;
    await controller.start();

    // Set cluster manifest with desired instances = 3
    controller.setManifest({
      clusterName,
      appFile: workerScriptPath,
      instances: 3,
      port: testPort,
      host: "localhost",
      env: {},
      currentGeneration: 1,
      updatedAt: Date.now(),
    });

    // Start reconciler with fast interval and slot resurrection callback
    reconciler = new ClusterReconciler(controller, {
      intervalMs: 100,
      onResurrectSlot: async (manifest, slot, nextGen) => {
        spawnWorker(slot, nextGen);
      },
    });
    reconciler.start();

    const preloadPath = join(process.cwd(), "src", "utils", "cluster-preload.ts").replace(/\\/g, "/");
    writeFileSync(workerScriptPath, `
import "${preloadPath}";

const port = parseInt(process.env.PORT || "3000", 10);
Bun.serve({
  port,
  reusePort: true,
  fetch(req) {
    return new Response(JSON.stringify({
      status: "ok",
      pid: process.pid,
      slot: process.env.NODE_APP_INSTANCE,
      generation: process.env.BS9_CLUSTER_GENERATION,
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
});
`);

    // Lock cluster during initial provisioning to prevent reconciler race
    const initialLock = controller.lockCluster(clusterName, "scale", 30000);

    // Spin up initial 3 cluster workers (generation 1)
    spawnWorker(0, 1);
    spawnWorker(1, 1);
    spawnWorker(2, 1);

    const startWait = Date.now();
    while (
      (!controller.isSlotReady(clusterName, 0, 1) ||
       !controller.isSlotReady(clusterName, 1, 1) ||
       !controller.isSlotReady(clusterName, 2, 1)) &&
      Date.now() - startWait < 10000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 2, 1)).toBe(true);

    controller.unlockCluster(clusterName, initialLock.lockToken!);
  });

  afterAll(async () => {
    if (reconciler) {
      reconciler.stop();
    }
    for (const proc of activeProcs) {
      try { proc.kill(); } catch {}
    }
    activeProcs.length = 0;

    await controller.stop();
    try { unlinkSync(workerScriptPath); } catch {}
  });

  test("cluster should survive violent SIGKILL of a worker process without service interruption", async () => {
    // 1. Initial health check: cluster serves HTTP 200
    const initialRes = await fetch(`http://localhost:${testPort}`);
    expect(initialRes.status).toBe(200);

    const workers = controller.getClusterWorkers(clusterName);
    expect(workers.length).toBe(3);

    // 2. Select worker in slot 1 to violently kill
    const victimWorker = activeProcs[1];
    const victimPid = victimWorker.pid;
    expect(victimPid).toBeGreaterThan(0);

    // 3. Violently kill worker process via SIGKILL and taskkill /F
    try {
      process.kill(victimPid, "SIGKILL");
    } catch {}

    if (process.platform === "win32") {
      try {
        execSync(`taskkill /F /PID ${victimPid}`, { stdio: "ignore" });
      } catch {}
    }

    // Wait briefly for process teardown and socket disconnect event
    await new Promise((r) => setTimeout(r, 200));

    // 4. Verify controller detected worker disconnection
    expect(controller.isSlotReady(clusterName, 1, 1)).toBe(false);

    // Surviving workers (slots 0 and 2) must remain READY
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 2, 1)).toBe(true);

    // 5. Verify surviving workers continue answering subsequent HTTP requests
    const subsequentStatuses: number[] = [];
    const respondingPids = new Set<number>();

    // Send 20 concurrent HTTP requests
    const requests = Array.from({ length: 20 }, async () => {
      try {
        const res = await fetch(`http://localhost:${testPort}`);
        subsequentStatuses.push(res.status);
        if (res.status === 200) {
          const body = await res.json();
          if (body.pid) {
            respondingPids.add(Number(body.pid));
          }
        }
      } catch {
        subsequentStatuses.push(0);
      }
    });

    await Promise.all(requests);

    // 6. Assertions: 100% of requests succeeded with HTTP 200
    expect(subsequentStatuses.length).toBe(20);
    expect(subsequentStatuses.filter((s) => s !== 200)).toEqual([]);
    expect(subsequentStatuses.every((s) => s === 200)).toBe(true);

    // At least one surviving worker answered
    expect(respondingPids.size).toBeGreaterThanOrEqual(1);

    // 7. Automatic Self-Healing: Reconciler must detect missing slot 1 and resurrect it with generation 2
    const resurrectWaitStart = Date.now();
    while (!controller.isSlotReady(clusterName, 1, 2) && Date.now() - resurrectWaitStart < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify slot 1 has been resurrected as generation 2 and is READY
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);

    // Verify full cluster capacity has been restored (3 ready workers)
    const activeWorkersAfterResurrect = controller
      .getClusterWorkers(clusterName)
      .filter((w) => w.status === "ready");
    expect(activeWorkersAfterResurrect.length).toBe(3);

    // Verify all 3 slots are READY
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);
    expect(controller.isSlotReady(clusterName, 2, 1)).toBe(true);

    // 8. Verify the resurrected worker process is alive, registered with controller, and ready
    const resurrectedWorker = controller
      .getClusterWorkers(clusterName)
      .find((w) => w.slot === 1 && w.generation === 2);
    expect(resurrectedWorker).toBeDefined();
    expect(resurrectedWorker?.status).toBe("ready");
    expect(resurrectedWorker?.pid).toBeGreaterThan(0);
    expect(resurrectedWorker?.pid).not.toBe(victimPid);
    expect(resurrectedWorker?.port).toBe(testPort);

    // Verify OS process is actively running
    let isProcessAlive = false;
    try {
      process.kill(resurrectedWorker!.pid, 0);
      isProcessAlive = true;
    } catch {}
    expect(isProcessAlive).toBe(true);
  });

  test("repeated crash of replacement worker produces strictly monotonic generations g1 -> g2 -> g3", async () => {
    // Current slot 1 is generation 2
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(true);

    const g2Worker = controller
      .getClusterWorkers(clusterName)
      .find((w) => w.slot === 1 && w.generation === 2);
    expect(g2Worker).toBeDefined();
    const g2Pid = g2Worker!.pid;

    // Violently kill g2 replacement worker
    try { process.kill(g2Pid, "SIGKILL"); } catch {}
    if (process.platform === "win32") {
      try { execSync(`taskkill /F /PID ${g2Pid}`, { stdio: "ignore" }); } catch {}
    }

    // Wait for reconciler to resurrect slot 1 as generation 3 (never duplicate g2!)
    const resurrectWaitStart = Date.now();
    while (!controller.isSlotReady(clusterName, 1, 3) && Date.now() - resurrectWaitStart < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify slot 1 has been resurrected strictly as generation 3
    expect(controller.isSlotReady(clusterName, 1, 3)).toBe(true);
    expect(controller.isSlotReady(clusterName, 1, 2)).toBe(false);

    // Verify manifest currentGeneration is monotonically 3 or higher
    const manifest = controller.getManifest(clusterName);
    expect(manifest?.currentGeneration).toBeGreaterThanOrEqual(3);

    // Verify exactly 3 ready workers (slots 0, 1, 2)
    const activeWorkers = controller
      .getClusterWorkers(clusterName)
      .filter((w) => w.status === "ready");
    expect(activeWorkers.length).toBe(3);
  });
});
