import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo } from "../src/platform/detect.js";
import { ControllerAdminClient } from "../src/cluster/admin-client.js";
import { HubClient } from "../src/hub/client.js";
import { ensureDaemonRunning, isDaemonResponsive } from "../src/daemon/ensure.js";
import { daemonCommand } from "../src/commands/daemon.js";
import { hasUsableUserSystemd, removeSandboxSystemdLinks } from "./helpers/systemd.js";

describe("Daemon Supervision & Crash Recovery E2E", () => {
  const testId = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const sandboxDir = join(process.cwd(), `.tmp-sup-recovery-${testId}`);

  // Configure isolated sandbox environment
  const origHome = process.env.BS9_HOME;
  const origCtrlSock = process.env.BS9_CONTROLLER_SOCKET;
  const origHubSock = process.env.BS9_HUB_SOCKET;
  let platformInfo: ReturnType<typeof getPlatformInfo>;

  const clusterName = `sup_cluster_${testId}`;
  const workerScript = join(sandboxDir, "worker-app.ts");
  let pidFile = "";

  let port = 0;
  let workerProc: any = null;
  let clusterTokenFile = "";
  let clusterToken = "";

  async function getFreePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as any).port;
        srv.close(() => resolve(p));
      });
    });
  }

  beforeAll(async () => {
    process.env.BS9_HOME = sandboxDir;
    platformInfo = getPlatformInfo();
    pidFile = join(platformInfo.runtimeDir, "bs9-daemon.pid");
    mkdirSync(sandboxDir, { recursive: true });

    // Cluster Worker Application Script
    const preloadPath = join(process.cwd(), "src", "utils", "cluster-preload.ts").replace(/\\/g, "/");
    writeFileSync(
      workerScript,
      `
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
      cluster: process.env.BS9_CLUSTER_NAME
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
});
`,
      "utf-8"
    );
  });

  afterAll(async () => {
    if (workerProc) {
      try { workerProc.kill("SIGKILL"); } catch {}
    }

    try {
      await daemonCommand("stop");
    } catch {}

    // Ensure lingering daemon killed
    if (existsSync(pidFile)) {
      try {
        const lingeringPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (lingeringPid > 0) {
          process.kill(lingeringPid, "SIGKILL");
          if (platformInfo.isWindows) {
            execSync(`taskkill /F /PID ${lingeringPid}`, { stdio: "ignore" });
          }
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 500));
    removeSandboxSystemdLinks(sandboxDir);

    if (origHome !== undefined) {
      process.env.BS9_HOME = origHome;
    } else {
      delete process.env.BS9_HOME;
    }
    if (origCtrlSock !== undefined) {
      process.env.BS9_CONTROLLER_SOCKET = origCtrlSock;
    } else {
      delete process.env.BS9_CONTROLLER_SOCKET;
    }
    if (origHubSock !== undefined) {
      process.env.BS9_HUB_SOCKET = origHubSock;
    } else {
      delete process.env.BS9_HUB_SOCKET;
    }

    try {
      if (existsSync(sandboxDir)) {
        rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it.skipIf(!hasUsableUserSystemd())("survives daemon SIGKILL: supervisor restarts daemon, workers reconnect, WAL restores state", async () => {
    // 1. Launch Daemon under Platform Supervisor (Windows watchdog / systemd)
    await ensureDaemonRunning({ timeoutMs: 15000 });
    expect(await isDaemonResponsive()).toBe(true);

    // Verify initial Daemon PID
    expect(existsSync(pidFile)).toBe(true);
    const firstDaemonPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(firstDaemonPid).toBeGreaterThan(0);

    // Query Ping report
    const admin = new ControllerAdminClient();
    expect(await admin.connect(5000)).toBe(true);
    const initialPing = await admin.ping();
    expect(initialPing.status).toBe("ok");
    expect(initialPing.controller.listening).toBe(true);
    expect(initialPing.hub.listening).toBe(true);

    // 2. Register cluster and manifest with admin client
    const reg = await admin.registerCluster(clusterName);
    clusterTokenFile = reg.tokenFilePath;
    clusterToken = reg.token;

    port = await getFreePort();

    await admin.setManifest({
      clusterName,
      appFile: workerScript,
      instances: 1,
      port,
      host: "localhost",
      env: {},
      currentGeneration: 1,
      updatedAt: Date.now(),
    });
    admin.disconnect();

    // 3. Start Cluster Worker (Slot 0, Generation 1)
    let workerStderr = "";
    workerProc = spawn(process.execPath, ["run", workerScript], {
      cwd: sandboxDir,
      env: {
        ...process.env,
        PORT: String(port),
        BS9_CLUSTER: "true",
        BS9_REUSE_PORT: "true",
        BS9_CLUSTER_NAME: clusterName,
        NODE_APP_INSTANCE: "0",
        BS9_CLUSTER_ID: "0",
        BS9_CLUSTER_GENERATION: "1",
        BS9_CLUSTER_TOTAL: "1",
        BS9_AUTH_TOKEN_FILE: clusterTokenFile,
        BS9_HOME: sandboxDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    workerProc.stderr.on("data", (d: Buffer) => { workerStderr += d.toString(); });

    // Poll until worker reports READY
    const workerAdmin = new ControllerAdminClient();
    expect(await workerAdmin.connect(5000)).toBe(true);
    const workerWaitStart = Date.now();
    let workerReady = false;
    while (Date.now() - workerWaitStart < 15000) {
      const isReady = await workerAdmin.isSlotReady(clusterName, 0, 1);
      if (isReady) {
        workerReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    workerAdmin.disconnect();
    if (!workerReady) {
      console.error("Worker failed to become ready! Stderr:", workerStderr);
    }
    expect(workerReady).toBe(true);

    // Verify HTTP is serving
    const initialHttp = await fetch(`http://localhost:${port}`);
    expect(initialHttp.status).toBe(200);

    // 4. Store State in State Hub (persisted to WAL)
    const hubClient = new HubClient({
      namespace: clusterName,
      authToken: clusterToken,
    });
    expect(await hubClient.connect()).toBe(true);
    await hubClient.set("session_user", "alex_production_user");
    const storedVal = await hubClient.get("session_user");
    expect(storedVal).toBe("alex_production_user");
    hubClient.disconnect();

    // 5. Violently kill the Daemon Process (SIGKILL)
    try {
      process.kill(firstDaemonPid, "SIGKILL");
    } catch {}
    if (platformInfo.isWindows) {
      try {
        execSync(`taskkill /F /PID ${firstDaemonPid}`, { stdio: "ignore" });
      } catch {}
    }

    // 6. Supervisor detects crash and auto-restarts Daemon with a new PID
    const restartWaitStart = Date.now();
    let secondDaemonPid = 0;
    while (Date.now() - restartWaitStart < 15000) {
      if (existsSync(pidFile)) {
        try {
          const p = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          if (p > 0 && p !== firstDaemonPid) {
            secondDaemonPid = p;
            break;
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(secondDaemonPid).toBeGreaterThan(0);
    expect(secondDaemonPid).not.toBe(firstDaemonPid);

    // Poll until restarted daemon is fully responsive
    while (Date.now() - restartWaitStart < 20000) {
      if (await isDaemonResponsive()) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(await isDaemonResponsive()).toBe(true);

    // Query Ping report on restarted daemon
    const retryAdmin = new ControllerAdminClient();
    expect(await retryAdmin.connect(5000)).toBe(true);
    const restartedPing = await retryAdmin.ping();
    expect(restartedPing.status).toBe("ok");
    expect(restartedPing.hub.walRecovered).toBe(true);
    retryAdmin.disconnect();

    // 7. Verify State Hub WAL restored the KV state across daemon restart!
    const postCrashHub = new HubClient({
      namespace: clusterName,
      authToken: clusterToken,
    });
    expect(await postCrashHub.connect()).toBe(true);
    const recoveredVal = await postCrashHub.get("session_user");
    expect(recoveredVal).toBe("alex_production_user");
    postCrashHub.disconnect();

    // 8. Verify the existing worker reconnected, re-authenticated, and reported READY
    const postAdmin = new ControllerAdminClient();
    expect(await postAdmin.connect(5000)).toBe(true);
    const workerReconnectStart = Date.now();
    let workerReconnectedReady = false;
    while (Date.now() - workerReconnectStart < 15000) {
      const isReady = await postAdmin.isSlotReady(clusterName, 0, 1);
      if (isReady) {
        workerReconnectedReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    postAdmin.disconnect();
    expect(workerReconnectedReady).toBe(true);

    // 9. Verify worker continues to serve HTTP successfully across daemon restart
    const postRestartHttp = await fetch(`http://localhost:${port}`);
    expect(postRestartHttp.status).toBe(200);
    const body = (await postRestartHttp.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.cluster).toBe(clusterName);
  }, 45000);
});
