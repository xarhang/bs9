import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const enabled = process.env.BS9_NATIVE_E2E === "1" && process.platform !== "linux";

describe.skipIf(!enabled)("Native Windows/macOS service lifecycle", () => {
  const testId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const home = process.env.BS9_HOME || join(process.cwd(), `.tmp-native-e2e-${testId}`);
  const fixtureDir = join(home, "fixture");
  const prefix = `bs9-ci-${testId}`;
  const serviceNames = [`${prefix}-a`, `${prefix}-b`];
  const ports = [51000 + Math.floor(Math.random() * 1000), 52000 + Math.floor(Math.random() * 1000)];
  const appFile = join(fixtureDir, "app.ts");
  const binPath = resolve(process.cwd(), "bin", "bs9");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BS9_HOME: home,
    // GitHub's Windows runner is elevated. Use BS9's supported watchdog mode
    // so the test does not register machine-wide services on a shared runner.
    BS9_WINDOWS_BACKGROUND: "1",
  };

  function runCli(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [binPath, ...args], {
        cwd: fixtureDir,
        env,
        windowsHide: true,
      });
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

  async function fetchWithRetry(url: string, maxWaitMs = 15_000): Promise<Response> {
    const deadline = Date.now() + maxWaitMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) return response;
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(100);
    }
    throw lastError || new Error(`Timed out fetching ${url}`);
  }

  async function expectPortClosed(url: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await fetch(url);
      } catch {
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error(`${url} remained reachable after service deletion`);
  }

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(appFile, `
      const server = Bun.serve({
        port: Number(process.env.PORT),
        hostname: process.env.HOST || "127.0.0.1",
        fetch() {
          return Response.json({ ok: true, service: process.env.SERVICE_NAME, pid: process.pid });
        },
      });
      console.log("LISTENING", server.port);
    `);
  });

  afterAll(async () => {
    try { await runCli(["delete", `${prefix}-*`, "--force", "--remove"], 20_000); } catch {}
    try { if (existsSync(home)) rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("starts, discovers, serves, and wildcard-deletes two platform services", async () => {
    for (let index = 0; index < serviceNames.length; index++) {
      const result = await runCli([
        "start", "app.ts",
        "--name", serviceNames[index],
        "--host", "127.0.0.1",
        "--port", String(ports[index]),
      ]);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const response = await fetchWithRetry(`http://127.0.0.1:${ports[index]}/`);
      const body = await response.json() as { ok: boolean; service: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe(serviceNames[index]);
    }

    const status = await runCli(["status", "--raw"]);
    expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
    expect(status.stdout).toContain(serviceNames[0]);
    expect(status.stdout).toContain(serviceNames[1]);

    const deleted = await runCli(["delete", `${prefix}-*`, "--force", "--remove"], 30_000);
    expect(deleted.exitCode, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);

    const afterDelete = await runCli(["status", "--raw"]);
    expect(afterDelete.stdout).not.toContain(serviceNames[0]);
    expect(afterDelete.stdout).not.toContain(serviceNames[1]);
    await Promise.all(ports.map(port => expectPortClosed(`http://127.0.0.1:${port}/`)));
  }, 90_000);
});
