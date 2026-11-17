import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { displayServices } from "../src/commands/status.js";
import {
  findClusterWorkers,
  resolveActiveWorkerForSlot,
  type ServiceMetrics,
} from "../src/utils/service-discovery.js";
import {
  generateNginxConfig,
  generateCaddyConfig,
  LoadBalancer,
} from "../src/index.js";
import { AdvancedMonitoring } from "../src/monitoring/advanced.js";

function makeMockServices(count: number): ServiceMetrics[] {
  const list: ServiceMetrics[] = [];
  for (let i = 0; i < count; i++) {
    const isActive = i % 5 !== 0; // 80% running, 20% stopped/errored
    const isFailed = !isActive && i % 10 === 0;
    list.push({
      name: `BS9_api-${i}-g1`,
      loaded: "loaded",
      active: isActive ? "active" : isFailed ? "failed" : "inactive",
      sub: isActive ? "running" : isFailed ? "failed" : "dead",
      state: isActive ? "active/running" : isFailed ? "failed/failed" : "inactive/dead",
      cpu: isActive ? `${(i % 90) + 1}.5ms` : "-",
      memory: isActive ? `${(i % 256) + 16}.0M` : "-",
      uptime: isActive ? "2h 15m" : "-",
      tasks: isActive ? "4" : "-",
      pid: isActive ? String(10000 + i) : "-",
      description: `BS9 Service: api-${i} port=${3000 + (i % 500)}`,
      slot: i,
      generation: 1,
      appName: "api",
      logicalSlot: `api-${i}`,
    });
  }
  return list;
}

function findChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c));
}

describe("Scale & Stress Tests (100 - 1,000 Services/Statuses)", () => {
  test("displayServices renders 100 and 1,000 services quickly with accurate counts", () => {
    for (const count of [100, 1000]) {
      const services = makeMockServices(count);
      const originalLog = console.log;
      const lines: string[] = [];
      console.log = (...args: any[]) => {
        lines.push(args.map(String).join(" "));
      };

      const start = performance.now();
      try {
        displayServices(services);
      } finally {
        console.log = originalLog;
      }
      const elapsedMs = performance.now() - start;

      const output = lines.join("\n");
      const expectedRunning = services.filter((s) => s.active === "active").length;
      const expectedStopped = count - expectedRunning;

      expect(elapsedMs).toBeLessThan(500);
      expect(output).toContain(`Status: ${expectedRunning} running, ${expectedStopped} stopped (${count} total)`);
      // Header + separator + count rows + summary lines
      expect(lines.length).toBeGreaterThanOrEqual(count + 4);
    }
  });

  test("findClusterWorkers and resolveActiveWorkerForSlot scale to 1,000 services safely", async () => {
    const services = makeMockServices(998);
    // Include regex-metacharacter service names to verify no ReDoS / regex crash at scale
    services.push(
      {
        name: "BS9_app.v1+prod-0-g1",
        loaded: "loaded",
        active: "active",
        sub: "running",
        state: "active/running",
        cpu: "10ms",
        memory: "32M",
        uptime: "1h",
        tasks: "2",
        pid: "50001",
        description: "BS9 Service: app.v1+prod-0",
        generation: 1,
      },
      {
        name: "BS9_app.v1+prod-0-g2",
        loaded: "loaded",
        active: "inactive",
        sub: "dead",
        state: "inactive/dead",
        cpu: "-",
        memory: "-",
        uptime: "-",
        tasks: "-",
        pid: "-",
        description: "BS9 Service: app.v1+prod-0",
        generation: 2,
      }
    );

    const start = performance.now();
    const workers = await findClusterWorkers("api", services);
    const specialWorkers = await findClusterWorkers("app.v1+prod", services);
    const activeSlot = await resolveActiveWorkerForSlot("app.v1+prod-0", services);
    const elapsedMs = performance.now() - start;

    expect(workers.length).toBe(998);
    expect(specialWorkers.length).toBe(2);
    expect(activeSlot?.name).toBe("BS9_app.v1+prod-0-g1");
    expect(elapsedMs).toBeLessThan(100);
  });

  test("Nginx & Caddy config generators handle 100 and 1,000 upstreams cleanly", () => {
    const upstreams = Array.from({ length: 1000 }, (_, i) => ({
      host: "127.0.0.1",
      port: 10000 + i,
    }));

    const start = performance.now();
    const nginx = generateNginxConfig({
      serviceName: "mega-cluster",
      domain: "mega.example.com",
      upstreams,
    });
    const caddy = generateCaddyConfig({
      serviceName: "mega-cluster",
      domain: "mega.example.com",
      upstreams,
    });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    expect(nginx).toContain("server 127.0.0.1:10000 max_fails=3 fail_timeout=10s;");
    expect(nginx).toContain("server 127.0.0.1:10999 max_fails=3 fail_timeout=10s;");
    expect(caddy).toContain("127.0.0.1:10000");
    expect(caddy).toContain("127.0.0.1:10999");
  });

  test("LoadBalancer handles 1,000 requests across 100 backends with balanced distribution and clean drain", async () => {
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const backends = Array.from({ length: 100 }, (_, i) => ({
        id: `backend-${i}`,
        host: "127.0.0.1",
        port: backend.port!,
        connections: 0,
        healthy: true,
        lastHealthCheck: Date.now(),
        responseTime: 0,
      }));

      const lb = new LoadBalancer({
        port: 18081,
        algorithm: "round-robin",
        healthCheck: { enabled: false, path: "/health", interval: 5000, timeout: 1000, retries: 1 },
        backends,
      });

      // Dispatch 1,000 requests in batches of 50
      for (let batch = 0; batch < 20; batch++) {
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, j) =>
            lb.handleRequest(new Request(`http://127.0.0.1:18081/item/${batch * 50 + j}`))
          )
        );
        for (const res of responses) {
          expect(res.status).toBe(200);
          await res.body?.cancel();
        }
      }

      const stats = lb.getStats();
      expect(stats.totalRequests).toBe(1000);
      expect(stats.activeConnections).toBe(0);
      expect(stats.backendStats.every((b) => b.requestsHandled === 10)).toBe(true);

      const drainRes = await lb.drain(1000);
      expect(drainRes.drained).toBe(true);
      expect(drainRes.remainingConnections).toBe(0);
    } finally {
      backend.stop(true);
    }
  });

  const CHROMIUM_PATH = findChromiumExecutable();
  test.skipIf(!CHROMIUM_PATH)("Playwright renders 1,000 monitoring widgets in Chromium without errors", async () => {
    const monitoring = new AdvancedMonitoring();
    for (let i = 0; i < 1000; i++) {
      monitoring.addWidget({
        id: `svc-${i}`,
        type: "metric",
        title: `Service ${i}`,
        config: { metric: "cpu", unit: "%", value: i % 100 },
        position: { x: 0, y: 0, width: 300, height: 200 },
      });
    }

    const html = monitoring.generateDashboard();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });

    const browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
      const widgetCount = await page.locator(".widget").count();
      expect(widgetCount).toBeGreaterThanOrEqual(1000);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      server.stop(true);
    }
  });
});
