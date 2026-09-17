import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClusterController } from "../src/cluster/controller.js";
import { getPlatformInfo } from "../src/platform/detect.js";

describe("Preload Two-Phase Drain & Preserved Asynchronous App Cleanup", () => {
  let controller: ClusterController | null = null;
  const platformInfo = getPlatformInfo();
  const testId = Date.now();
  const socketPath = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-drain-${testId}`
    : join(platformInfo.runtimeDir, `drain-${testId}.sock`);
  const clusterName = `drain-app-${testId}`;

  afterEach(async () => {
    if (controller) {
      await controller.stop();
      controller = null;
    }
    if (!platformInfo.isWindows && existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
  });

  it("should coordinate two-phase IPC drain for in-flight requests without premature process termination", async () => {
    controller = new ClusterController({ socketPath });
    await controller.start();
    const { tokenFilePath } = controller.registerClusterToken(clusterName);

    const port = 49100 + Math.floor(Math.random() * 500);
    const workerScript = join(tmpdir(), `bs9-drain-worker-${testId}.ts`);
    const cleanupFile = join(tmpdir(), `bs9-drain-cleanup-${testId}.txt`);

    // Worker code has:
    // 1. Bun.serve with a slow 300ms endpoint
    // 2. Custom async SIGTERM handler that writes a confirmation file
    const workerCode = `
      let cleanedUp = false;

      // User application SIGTERM handler
      process.on("SIGTERM", async () => {
        // Asynchronous cleanup simulating DB connection pool drain / telemetry flush
        await new Promise((r) => setTimeout(r, 200));
        cleanedUp = true;
        const fs = await import("node:fs");
        fs.writeFileSync("${cleanupFile.replace(/\\/g, "\\\\")}", "ASYNC_CLEANUP_SUCCESS");
        process.exit(0);
      });

      // Listen on stdin for cross-platform signal simulation
      process.stdin.on("data", (chunk) => {
        if (chunk.toString().includes("SIGTERM")) {
          process.emit("SIGTERM");
        }
      });

      Bun.serve({
        port: ${port},
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/slow") {
            await new Promise((r) => setTimeout(r, 300));
            return new Response("SLOW_WORK_COMPLETED");
          }
          if (url.pathname === "/shutdown") {
            setTimeout(() => {
              process.emit("SIGTERM");
            }, 10);
            return new Response("SHUTDOWN_INITIATED");
          }
          return new Response("OK");
        },
      });
    `;

    writeFileSync(workerScript, workerCode, "utf-8");

    const preloadPath = join(process.cwd(), "src", "utils", "cluster-preload.ts");

    // Spawn worker with preload
    const workerProcess = spawn(
      process.execPath,
      ["--preload", preloadPath, workerScript],
      {
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          ...process.env,
          BS9_CLUSTER: "true",
          BS9_CLUSTER_NAME: clusterName,
          BS9_CLUSTER_ID: "0",
          NODE_APP_INSTANCE: "0",
          BS9_CLUSTER_GENERATION: "1",
          BS9_AUTH_TOKEN_FILE: tokenFilePath,
          BS9_CONTROLLER_SOCKET: socketPath,
          BS9_REUSE_PORT: "true",
        },
      }
    );

    // Wait for worker to emit READY via lifecycle controller
    const isReadyPromise = new Promise<void>((resolve) => {
      controller!.once("worker:ready", () => resolve());
    });

    await isReadyPromise;
    expect(controller.isSlotReady(clusterName, 0, 1)).toBe(true);

    // 1. Fire a slow in-flight request
    const slowReqPromise = fetch(`http://localhost:${port}/slow`).then((res) => res.text());

    // Allow request to reach the server handler
    await new Promise((r) => setTimeout(r, 80));

    // 2. Trigger two-phase DRAIN_REQUEST over IPC
    const drainResult = await controller.drainWorker(clusterName, 0, 1, 5000);
    expect(drainResult.drained).toBe(true);

    // 3. The in-flight request must succeed cleanly without being abruptly killed
    const slowResponse = await slowReqPromise;
    expect(slowResponse).toBe("SLOW_WORK_COMPLETED");

    // 4. Trigger shutdown/SIGTERM inside the worker
    workerProcess.stdin.write("SIGTERM\n");

    // Wait for process to exit cleanly after its async cleanup
    await new Promise<void>((resolve) => {
      workerProcess.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });

    // 5. Verify user application's asynchronous cleanup handler ran to completion!
    expect(existsSync(cleanupFile)).toBe(true);
    const cleanupContent = readFileSync(cleanupFile, "utf-8");
    expect(cleanupContent).toBe("ASYNC_CLEANUP_SUCCESS");

    // Cleanup temp files
    try { unlinkSync(workerScript); } catch {}
    try { unlinkSync(cleanupFile); } catch {}
  });
});