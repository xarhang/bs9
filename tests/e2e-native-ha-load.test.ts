import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPlatformInfo } from "../src/platform/detect.js";
import { hasUsableUserSystemd, removeSandboxSystemdLinks } from "./helpers/systemd.js";

const enabled = process.env.BS9_NATIVE_HA_E2E === "1";

describe.skipIf(!enabled)("Native HA load and chaos gate", () => {
  const testId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const home = process.env.BS9_HOME || join(process.cwd(), `.tmp-native-ha-${testId}`);
  const fixtureDir = join(home, "fixture");
  const clusterName = `bs9-ci-ha-${testId}`;
  const port = 54000 + Math.floor(Math.random() * 900);
  const appFile = join(fixtureDir, "app.ts");
  // CI's packaged qualification points this at the bin entry extracted from
  // the npm tarball. Normal native tests continue to exercise the checkout.
  const binPath = process.env.BS9_TEST_BIN_PATH || resolve(process.cwd(), "bin", "bs9");
  const reportDir = resolve(process.cwd(), "test-results", "native-ha");
  const reportPath = join(reportDir, `${process.platform}.log`);
  const platformInfo = getPlatformInfo();
  const controllerSocket = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-ha-controller-${testId}`
    : join(platformInfo.runtimeDir, `controller-${testId}.sock`);
  const hubSocket = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-ha-hub-${testId}`
    : join(platformInfo.runtimeDir, `hub-${testId}.sock`);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BS9_HOME: home,
    BS9_CONTROLLER_SOCKET: controllerSocket,
    BS9_HUB_SOCKET: hubSocket,
    BS9_WINDOWS_BACKGROUND: "1",
  };

  function record(title: string, result: { stdout: string; stderr: string; exitCode: number }): void {
    appendFileSync(reportPath, `\n===== ${title} (exit ${result.exitCode}) =====\n${result.stdout}${result.stderr}\n`);
  }

  function runCli(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [binPath, ...args], { cwd: fixtureDir, env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        done({ stdout, stderr: `${stderr}\n[CLI_TIMEOUT]`, exitCode: 124 });
      }, timeoutMs);
      child.on("close", code => {
        clearTimeout(timer);
        done({ stdout, stderr, exitCode: code ?? 0 });
      });
    });
  }

  async function fetchWithRetry(maxWaitMs = 20_000): Promise<Response> {
    const deadline = Date.now() + maxWaitMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return response;
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(100);
    }
    throw lastError || new Error("Cluster did not become reachable");
  }

  async function workerCount(): Promise<number> {
    const result = await runCli(["status", clusterName, "--raw"]);
    record("status", result);
    if (result.exitCode !== 0) return 0;
    try {
      const services = JSON.parse(result.stdout) as Array<{ name: string }>;
      return services.filter(service => service.name.includes(clusterName)).length;
    } catch {
      return 0;
    }
  }

  async function waitForWorkerCount(expected: number, maxWaitMs = 20_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (await workerCount() === expected) return;
      await Bun.sleep(200);
    }
    throw new Error(`Expected ${expected} workers for ${clusterName}`);
  }

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    mkdirSync(platformInfo.runtimeDir, { recursive: true });
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, `BS9 native HA load gate\nplatform=${process.platform}\ncluster=${clusterName}\nport=${port}\n`);
    writeFileSync(appFile, `
      const server = Bun.serve({
        port: Number(process.env.PORT),
        hostname: process.env.HOST || "127.0.0.1",
        reusePort: process.env.BS9_REUSE_PORT === "true",
        fetch() {
          console.log(JSON.stringify({ event: "request", pid: process.pid, at: Date.now() }));
          return Response.json({
            ok: true,
            pid: process.pid,
            slot: process.env.NODE_APP_INSTANCE,
            generation: process.env.BS9_CLUSTER_GENERATION,
          });
        },
      });
      console.log("LISTENING", server.port);
    `);
  });

  afterAll(async () => {
    try {
      const deleted = await runCli(["delete", clusterName, "--force", "--remove"], 30_000);
      record("cleanup-delete", deleted);
    } catch {}
    try {
      const daemonStop = await runCli(["daemon", "stop"], 20_000);
      record("cleanup-daemon", daemonStop);
    } catch {}
    if (platformInfo.isLinux) removeSandboxSystemdLinks(home);
    try { if (existsSync(home)) rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("survives native reload, violent worker crash, and scale transitions under load", async () => {
    if (platformInfo.isLinux) {
      expect(hasUsableUserSystemd(), "A usable systemd --user session is required").toBe(true);
    }

    const start = await runCli([
      "start", "app.ts",
      "--name", clusterName,
      "--host", "127.0.0.1",
      "--port", String(port),
      "--instances", "2",
    ], 60_000);
    record("start-cluster", start);
    expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);
    expect((await fetchWithRetry()).status).toBe(200);
    await waitForWorkerCount(2);

    const verification = await runCli([
      "verify-ha", clusterName,
      "--live",
      "--port", String(port),
      "--concurrency", process.env.BS9_HA_CONCURRENCY || "20",
      "--ready-timeout", "20000",
      "--drain-timeout", "8000",
      "--duration", process.env.BS9_HA_SOAK_SECONDS || "5",
      "--json",
    ], 120_000);
    record("verify-live-ha", verification);
    expect(verification.exitCode, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(verification.stdout).toContain('"passed": true');
    expect(verification.stdout).toContain('"failedRequests": 0');

    const scaleUp = await runCli(["scale", clusterName, "3"], 60_000);
    record("scale-up", scaleUp);
    expect(scaleUp.exitCode, `${scaleUp.stdout}\n${scaleUp.stderr}`).toBe(0);
    await waitForWorkerCount(3);
    expect((await fetchWithRetry()).status).toBe(200);

    const scaleDown = await runCli(["scale", clusterName, "2"], 60_000);
    record("scale-down", scaleDown);
    expect(scaleDown.exitCode, `${scaleDown.stdout}\n${scaleDown.stderr}`).toBe(0);
    await waitForWorkerCount(2);
    expect((await fetchWithRetry()).status).toBe(200);

    // Exercise real log files created by native workers, including growth,
    // discovery through the CLI, truncation, and post-flush recovery.
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
    }
    await Bun.sleep(500);
    const logsBeforeFlush = await runCli(["logs", clusterName, "--lines", "20"], 30_000);
    record("logs-before-flush", logsBeforeFlush);
    expect(logsBeforeFlush.exitCode, `${logsBeforeFlush.stdout}\n${logsBeforeFlush.stderr}`).toBe(0);
    if (process.platform === "linux") {
      // Native Linux services write to journald rather than per-worker files.
      expect(logsBeforeFlush.stdout).toContain('"event":"request"');
    } else {
      const clusterLogFiles = readdirSync(platformInfo.logDir)
        .filter(file => file.includes(clusterName) && file.endsWith(".out.log"));
      expect(clusterLogFiles.length).toBeGreaterThanOrEqual(2);
      const combinedWorkerLogs = clusterLogFiles
        .map(file => readFileSync(join(platformInfo.logDir, file), "utf8"))
        .join("\n");
      expect(combinedWorkerLogs).toContain('"event":"request"');
      expect(clusterLogFiles.some(file => statSync(join(platformInfo.logDir, file)).size > 0)).toBe(true);
    }

    const flush = await runCli(["flush", clusterName], 30_000);
    record("flush", flush);
    expect(flush.exitCode, `${flush.stdout}\n${flush.stderr}`).toBe(0);
    expect((await fetchWithRetry()).status).toBe(200);

    // The process manager must remain responsive after every destructive
    // lifecycle transition and expose exactly the requested worker count.
    const finalStatus = await runCli(["status", clusterName, "--raw"], 30_000);
    record("final-status", finalStatus);
    expect(finalStatus.exitCode).toBe(0);
    const finalServices = JSON.parse(finalStatus.stdout) as Array<{ name: string; active?: string; state?: string }>;
    const activeClusterServices = finalServices.filter(service =>
      service.name.includes(clusterName) && (service.active === "active" || service.state === "running")
    );
    expect(activeClusterServices).toHaveLength(2);
  }, 240_000);
});
