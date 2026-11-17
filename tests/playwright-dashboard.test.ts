import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { AdvancedMonitoring } from "../src/monitoring/advanced.js";

function findChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function getFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const CHROMIUM_PATH = findChromiumExecutable();
const REPO_ROOT = resolve(import.meta.dir, "..");

describe.skipIf(!CHROMIUM_PATH)("Playwright Browser E2E & Security Tests", () => {
  let browser: Browser;
  let webProcess: ChildProcess | null = null;
  let webPort = 0;
  const webToken = "pw-test-session-token-9876543210";

  let advServer: ReturnType<typeof Bun.serve> | null = null;
  let advPort = 0;
  const advToken = "pw-adv-token-1234567890";

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    // 1. Start real BS9 Web Dashboard subprocess
    webPort = getFreePort();
    webProcess = spawn("bun", ["run", resolve(REPO_ROOT, "src/web/dashboard.ts")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        WEB_DASHBOARD_HOST: "127.0.0.1",
        WEB_DASHBOARD_PORT: String(webPort),
        WEB_SESSION_TOKEN: webToken,
      },
      stdio: "ignore",
      windowsHide: true,
    });

    // Wait for Web Dashboard to accept connections
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}/`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    // 2. Start AdvancedMonitoring server with XSS payloads injected into widget metadata
    const monitoring = new AdvancedMonitoring();
    monitoring.addWidget({
      id: 'xss" onclick="window.__xss2=true',
      type: "metric",
      title: '<script>window.__xss1=true</script>Latency',
      config: {
        metric: "latency",
        unit: '<img src=x onerror="window.__xss3=true">ms',
        value: 42,
      },
      position: { x: 0, y: 0, width: 300, height: 200 },
    });

    advServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
          return new Response(monitoring.generateDashboard(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/api/advanced-metrics") {
          const auth = req.headers.get("Authorization") || "";
          if (auth !== `Bearer ${advToken}` && url.searchParams.get("token") !== advToken) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              widgets: monitoring.getWidgets(),
              anomalies: monitoring.getAnomalies(),
              correlations: monitoring.getCorrelations(),
              timestamp: Date.now(),
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    advPort = advServer.port!;
  });

  afterAll(async () => {
    await browser?.close();
    if (webProcess && !webProcess.killed) {
      webProcess.kill("SIGTERM");
    }
    advServer?.stop(true);
  });

  test("Web Dashboard enforces login gate, sets HttpOnly cookie, and loads without JS errors", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    try {
      // Unauthenticated visit must show login page, not dashboard
      await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: "networkidle" });
      expect(await page.title()).toContain("Login");
      await page.waitForSelector("#loginForm");

      // Unauthenticated API call from browser context must return 401
      const unauthStatus = await page.evaluate(async () => {
        const r = await fetch("/api/metrics");
        return r.status;
      });
      expect(unauthStatus).toBe(401);

      // Invalid token shows error message
      await page.fill("#token", "wrong-token");
      await page.click("#submitBtn");
      await page.waitForSelector("#errorMsg", { state: "visible" });
      const errText = await page.textContent("#errorMsg");
      expect(errText?.length).toBeGreaterThan(0);

      // Valid token logs in and reloads into dashboard
      await page.fill("#token", webToken);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }),
        page.click("#submitBtn"),
      ]);

      expect(await page.title()).not.toContain("Login");
      const authStatus = await page.evaluate(async () => {
        const r = await fetch("/api/metrics");
        return r.status;
      });
      expect(authStatus).toBe(200);

      // Verify cookie is HttpOnly (not readable by document.cookie)
      const docCookie = await page.evaluate(() => document.cookie);
      expect(docCookie).not.toContain(webToken);

      // Verify /api/services/:name/logs works when authenticated and blocks traversal
      const logsCheck = await page.evaluate(async () => {
        const okRes = await fetch("/api/services/sample-app/logs?lines=50");
        const badRes = await fetch("/api/services/..%2F..%2Fetc%2Fpasswd/logs");
        return { okStatus: okRes.status, okBody: await okRes.json(), badStatus: badRes.status };
      });
      expect(logsCheck.okStatus).toBe(200);
      expect(logsCheck.okBody.service).toBe("sample-app");
      expect(logsCheck.badStatus).toBe(400);

      // Verify #searchInput and #stateFilter exist and neutralize XSS input
      await page.waitForSelector("#searchInput");
      await page.waitForSelector("#stateFilter");
      await page.fill("#searchInput", '<img src=x onerror="window.__searchXss=true">');
      await page.selectOption("#stateFilter", "active");
      const searchXss = await page.evaluate(() => (window as any).__searchXss);
      expect(searchXss).toBeUndefined();

      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("AdvancedMonitoring Dashboard neutralizes XSS payloads and enforces API auth", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    try {
      await page.goto(`http://127.0.0.1:${advPort}/?token=${advToken}`, { waitUntil: "networkidle" });
      expect(await page.title()).toContain("BS9 Advanced Monitoring Dashboard");

      // Verify none of the injected XSS payloads executed
      const xssFlags = await page.evaluate(() => ({
        x1: (window as any).__xss1,
        x2: (window as any).__xss2,
        x3: (window as any).__xss3,
      }));
      expect(xssFlags.x1).toBeUndefined();
      expect(xssFlags.x2).toBeUndefined();
      expect(xssFlags.x3).toBeUndefined();

      // Verify escaped text is safely rendered in the DOM
      const bodyText = await page.textContent("body");
      expect(bodyText).toContain("<script>window.__xss1=true</script>Latency");

      // Verify /api/advanced-metrics rejects missing/bad auth and accepts valid Bearer
      const unauthCode = await page.evaluate(async () => {
        const r = await fetch("/api/advanced-metrics");
        return r.status;
      });
      expect(unauthCode).toBe(401);

      const authRes = await page.evaluate(async (tok) => {
        const r = await fetch("/api/advanced-metrics", {
          headers: { Authorization: `Bearer ${tok}` },
        });
        return { status: r.status, json: await r.json() };
      }, advToken);
      expect(authRes.status).toBe(200);
      expect(Array.isArray(authRes.json.widgets)).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
