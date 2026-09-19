import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { getPlatformInfo } from "../src/platform/detect.js";
import { hasUsableUserSystemd, removeSandboxSystemdLinks } from "./helpers/systemd.js";

describe("E2E CLI Lifecycle Integration (Isolated)", () => {
  const testId = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const platformInfo = getPlatformInfo();
  const sandboxDir = join(process.cwd(), `.tmp-e2e-sandbox-${testId}`);
  const serviceName = `svc_${testId}`;
  let port = 0;
  const binPath = resolve(join(process.cwd(), "bin", "bs9"));

  // On Linux, Unix domain sockets must live on a native filesystem (tmpfs/ext4).
  // Processes launched by systemd cannot create sockets on Windows-mounted paths
  // (/mnt/d/... → ENOTSUP). Use /tmp for socket files on Linux so both the WSL dev
  // environment and real GitHub Linux runners work. App scripts stay in sandboxDir
  // because the start command's path allowlist uses process.cwd() which is sandboxDir.
  const socketBase = platformInfo.isLinux
    ? `/tmp/bs9-test-${testId}`
    : sandboxDir;

  const appFile = join(sandboxDir, "app.ts");


  const ctrlSocket = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-ctrl-${testId}`
    : join(socketBase, "ctrl.sock");

  const hubSocket = platformInfo.isWindows
    ? `\\\\.\\pipe\\bs9-test-hub-${testId}`
    : join(socketBase, "hub.sock");

  const testEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    BS9_HOME: sandboxDir,
    BS9_CONTROLLER_SOCKET: ctrlSocket,
    BS9_HUB_SOCKET: hubSocket,
  };

  function runCli(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise) => {
      const proc = spawn(process.execPath, [binPath, ...args], {
        cwd: sandboxDir,
        env: testEnv,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolvePromise({ stdout, stderr: stderr + "\n[CLI_TIMEOUT]", exitCode: 124 });
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
      });
    });
  }

  beforeAll(async () => {
    port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Unable to allocate an ephemeral TCP port"));
          return;
        }
        server.close((error) => error ? reject(error) : resolvePort(address.port));
      });
    });

    mkdirSync(sandboxDir, { recursive: true });
    // Ensure the socket directory exists before the daemon tries to bind.
    // On Linux socketBase is /tmp/bs9-test-{testId}/ (distinct from sandboxDir).
    mkdirSync(socketBase, { recursive: true });

    // Create test Bun.serve app
    const appSource = `
      const port = parseInt(process.env.PORT || "3000", 10);
      const server = Bun.serve({
        port,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/version") {
            return new Response(JSON.stringify({
              ok: true,
              version: process.env.APP_VERSION || "v1",
              pid: process.pid,
              slot: process.env.NODE_APP_INSTANCE || "0"
            }), {
              headers: { "Content-Type": "application/json" }
            });
          }
          return new Response("OK from BS9 worker");
        }
      });
      console.log("APP_LISTENING_PORT_" + server.port);
    `;
    writeFileSync(appFile, appSource, "utf-8");
  });


  afterAll(async () => {
    // Guaranteed cleanup
    try {
      await runCli(["stop", serviceName, "-f"], 5000);
    } catch {}
    try {
      await runCli(["daemon", "stop"], 5000);
    } catch {}
    removeSandboxSystemdLinks(sandboxDir);
    try {
      if (existsSync(sandboxDir)) {
        rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch {}
    // Clean up Linux-native socket dir in /tmp
    if (platformInfo.isLinux) {
      try { rmSync(socketBase, { recursive: true, force: true }); } catch {}
    }
  });

  async function fetchWithRetry(url: string, maxWaitMs = 45000): Promise<Response> {
    const start = Date.now();
    let lastErr: any;
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(url);
        if (res.ok) return res;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw lastErr || new Error(`Timed out fetching ${url}`);
  }

  it.skipIf(!hasUsableUserSystemd())("should run full CLI lifecycle: daemon start, ping, start cluster, status, reload, stop, daemon stop", async () => {
    // A retry must begin from a clean native-service state. This also removes
    // debris left by an interrupted runner before exercising startup again.
    await runCli(["delete", serviceName, "--force"], 5_000);
    await runCli(["daemon", "stop"], 5_000);

    // 1. Start Daemon
    const daemonStart = await runCli(["daemon", "start"]);
    expect(daemonStart.exitCode).toBe(0);

    // 2. Query Daemon Status
    const daemonStatus = await runCli(["daemon", "status"]);
    expect(daemonStatus.exitCode).toBe(0);
    expect(daemonStatus.stdout).toContain("Persistent Daemon is running");

    // 3. Query Ping
    const pingRes = await runCli(["ping"]);
    expect(pingRes.exitCode).toBe(0);
    expect(pingRes.stdout).toContain("Controller");
    expect(pingRes.stdout).toContain("State Hub");
    expect(pingRes.stdout).toContain("Reconciler");

    // 4. Start Cluster Service with 2 workers
    const startRes = await runCli([
      "start",
      "app.ts",
      "-n", serviceName,
      "-p", String(port),
      "-i", "2"
    ]);
    expect(startRes.exitCode).toBe(0);
    expect(startRes.stdout).toContain("Cluster");

    // Verify HTTP response from cluster deterministically
    let httpRes: Response;
    try {
      httpRes = await fetchWithRetry(`http://localhost:${port}/version`);
    } catch (error) {
      const diagnostics = await runCli(["status", serviceName], 10_000);
      throw new Error(
        `Cluster did not become reachable after start.\nSTDOUT:\n${startRes.stdout}\nSTDERR:\n${startRes.stderr}\nSTATUS:\n${diagnostics.stdout}\n${diagnostics.stderr}`,
        { cause: error },
      );
    }
    expect(httpRes.status).toBe(200);
    const body = (await httpRes.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.version).toBe("v1");

    // 5. Query Status
    const statusRes = await runCli(["status"]);
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.stdout).toContain(serviceName);

    // 6. Reload Cluster
    const reloadRes = await runCli(["reload", serviceName], 30000);
    expect(reloadRes.exitCode).toBe(0);

    // Verify HTTP response is still 200 after reload
    const afterReloadRes = await fetchWithRetry(`http://localhost:${port}/version`);
    expect(afterReloadRes.status).toBe(200);

    // 7. Stop Cluster
    const stopRes = await runCli(["stop", serviceName]);
    expect(stopRes.exitCode).toBe(0);

    // 8. Stop Daemon
    const daemonStop = await runCli(["daemon", "stop"]);
    expect(daemonStop.exitCode).toBe(0);
  }, { timeout: 120_000, retry: 1 });
});
