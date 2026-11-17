import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  bs9,
  Bs9Client,
  rotateLogIfNeeded,
  parseLogSizeBytes,
  generateNginxConfig,
  generateCaddyConfig,
  LoadBalancer,
  getClusterDistributionMode,
  generateGrafanaDashboard,
  formatAlertPayload,
  parseCronExpression,
  getNextCronDate,
  getNextCronDelayMs,
  HealthAnomalyDetector,
  startCommand,
  recordAuditEvent,
  readAuditEvents,
  waitForServiceReady,
} from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BIN_BS9 = resolve(REPO_ROOT, "bin/bs9");

describe("Lightweight Production Features (Unit, Security & CLI E2E)", () => {
  test("parseLogSizeBytes parses K/M/G units and rejects invalid values safely", () => {
    expect(parseLogSizeBytes("10K")).toBe(10 * 1024);
    expect(parseLogSizeBytes("50M")).toBe(50 * 1024 * 1024);
    expect(parseLogSizeBytes("1G")).toBe(1024 * 1024 * 1024);
    expect(parseLogSizeBytes(4096)).toBe(4096);
    // Fallback to default 50MB on invalid/negative input
    expect(parseLogSizeBytes("invalid")).toBe(50 * 1024 * 1024);
    expect(parseLogSizeBytes(-10)).toBe(50 * 1024 * 1024);
  });

  test("rotateLogIfNeeded compresses oversized logs, prunes old archives, and refuses symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-logrot-"));
    try {
      const logFile = join(dir, "app.log");
      const payload = "A".repeat(2048);
      writeFileSync(logFile, payload, "utf8");

      const rotated1 = rotateLogIfNeeded(logFile, { maxBytes: 1024, maxFiles: 2, compress: true });
      expect(rotated1).toBe(true);
      expect(readFileSync(logFile, "utf8")).toBe("");
      expect(existsSync(`${logFile}.1.gz`)).toBe(true);
      expect(gunzipSync(readFileSync(`${logFile}.1.gz`)).toString("utf8")).toBe(payload);

      // Second & third rotations should prune beyond maxFiles=2
      writeFileSync(logFile, "B".repeat(2048), "utf8");
      expect(rotateLogIfNeeded(logFile, { maxBytes: 1024, maxFiles: 2, compress: true })).toBe(true);
      writeFileSync(logFile, "C".repeat(2048), "utf8");
      expect(rotateLogIfNeeded(logFile, { maxBytes: 1024, maxFiles: 2, compress: true })).toBe(true);

      expect(existsSync(`${logFile}.1.gz`)).toBe(true);
      expect(existsSync(`${logFile}.2.gz`)).toBe(true);
      expect(existsSync(`${logFile}.3.gz`)).toBe(false);

      // Security: Symlink must be refused so attacker cannot trick rotator into truncating/reading arbitrary files
      const victim = join(dir, "victim.txt");
      const evilLink = join(dir, "evil.log");
      writeFileSync(victim, "SENSITIVE_DATA".repeat(200), "utf8");
      symlinkSync(victim, evilLink);

      const rotatedSymlink = rotateLogIfNeeded(evilLink, { maxBytes: 100, maxFiles: 2 });
      expect(rotatedSymlink).toBe(false);
      expect(readFileSync(victim, "utf8")).toBe("SENSITIVE_DATA".repeat(200));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Nginx & Caddy config generators produce valid configs and block directive injection", () => {
    const nginx = generateNginxConfig({
      serviceName: "api-prod",
      domain: "api.example.com",
      upstreams: [
        { host: "127.0.0.1", port: 3000 },
        { host: "127.0.0.1", port: 3001 },
      ],
      rateLimitRps: 50,
      ssl: true,
    });
    expect(nginx).toContain("upstream bs9_api-prod");
    expect(nginx).toContain("server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;");
    expect(nginx).toContain("server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;");
    expect(nginx).toContain("server_name api.example.com;");
    expect(nginx).toContain("listen 443 ssl http2;");
    expect(nginx).toContain("limit_req_zone");

    const caddy = generateCaddyConfig({
      serviceName: "api-prod",
      domain: "api.example.com",
      upstreams: [{ host: "127.0.0.1", port: 3000 }],
    });
    expect(caddy).toContain("api.example.com {");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3000");
    expect(caddy).toContain("lb_policy round_robin");

    // Security: Reject directive injection in domain/host/port
    expect(() =>
      generateNginxConfig({
        serviceName: "api",
        domain: "evil.com; return 200;",
        upstreams: [{ host: "127.0.0.1", port: 3000 }],
      })
    ).toThrow(/Security/);

    expect(() =>
      generateCaddyConfig({
        serviceName: "api",
        domain: "evil.com\nrespond 200",
        upstreams: [{ host: "127.0.0.1", port: 3000 }],
      })
    ).toThrow(/Security/);

    expect(() =>
      generateNginxConfig({
        serviceName: "api",
        domain: "api.example.com",
        upstreams: [{ host: "127.0.0.1; evil", port: 3000 }],
      })
    ).toThrow(/Security/);

    expect(() =>
      generateNginxConfig({
        serviceName: "api",
        domain: "api.example.com",
        upstreams: [{ host: "127.0.0.1", port: 70000 }],
      })
    ).toThrow();
  });

  test("CLI E2E: bs9 export --format nginx|caddy works and enforces path/domain security", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-export-e2e-"));
    try {
      const nginxRes = spawnSync(
        "bun",
        ["run", BIN_BS9, "export", "--format", "nginx", "--domain", "app.example.com", "--port", "3000", "--rate-limit", "25"],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      expect(nginxRes.status).toBe(0);
      expect(nginxRes.stdout).toContain("server_name app.example.com;");
      expect(nginxRes.stdout).toContain("server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;");

      const outFile = join(dir, "Caddyfile");
      const caddyRes = spawnSync(
        "bun",
        ["run", BIN_BS9, "export", "--format", "caddy", "--domain", "app.example.com", "--port", "4000", "--output", outFile],
        { cwd: dir, encoding: "utf8" }
      );
      expect(caddyRes.status).toBe(0);
      expect(readFileSync(outFile, "utf8")).toContain("reverse_proxy 127.0.0.1:4000");

      // Injection rejection via CLI
      const badDomainRes = spawnSync(
        "bun",
        ["run", BIN_BS9, "export", "--format", "nginx", "--domain", "evil.com; return 200", "--port", "3000"],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      expect(badDomainRes.status).not.toBe(0);

      // Path traversal rejection via CLI
      const traversalRes = spawnSync(
        "bun",
        ["run", BIN_BS9, "export", "--format", "nginx", "--port", "3000", "--output", "../../etc/passwd"],
        { cwd: dir, encoding: "utf8" }
      );
      expect(traversalRes.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LoadBalancer gracefully drains in-flight requests and rejects new ones during drain", async () => {
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await new Promise((r) => setTimeout(r, 120));
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const lb = new LoadBalancer({
        port: 18080,
        algorithm: "round-robin",
        healthCheck: { enabled: false, path: "/health", interval: 5000, timeout: 1000, retries: 1 },
        backends: [
          {
            id: `127.0.0.1:${backend.port!}`,
            host: "127.0.0.1",
            port: backend.port!,
            connections: 0,
            healthy: true,
            lastHealthCheck: Date.now(),
            responseTime: 0,
          },
        ],
      });

      // Start an in-flight request
      const inFlightPromise = lb.handleRequest(new Request("http://127.0.0.1:18080/slow"));
      await new Promise((r) => setTimeout(r, 20));

      // Trigger drain while request is active
      const drainPromise = lb.drain(2000);
      expect(lb.isDraining()).toBe(true);

      // New request arriving during drain should receive 503 immediately
      const rejectedRes = await lb.handleRequest(new Request("http://127.0.0.1:18080/new"));
      expect(rejectedRes.status).toBe(503);

      // In-flight request should complete with 200 and drain should succeed cleanly
      const inFlightRes = await inFlightPromise;
      expect(inFlightRes.status).toBe(200);
      expect(await inFlightRes.text()).toBe("ok");

      const drainResult = await drainPromise;
      expect(drainResult.drained).toBe(true);
      expect(drainResult.remainingConnections).toBe(0);
    } finally {
      backend.stop(true);
    }
  });

  test("getClusterDistributionMode and Programmatic SDK (bs9) work as expected", () => {
    expect(getClusterDistributionMode("linux", {}).mode).toBe("reusePort");
    expect(getClusterDistributionMode("darwin", {}).mode).toBe("reusePort");
    expect(getClusterDistributionMode("win32", {}).mode).toBe("loadbalancer");
    expect(getClusterDistributionMode("linux", { BS9_WINDOWS_LB: "true" }).mode).toBe("loadbalancer");

    expect(bs9).toBeInstanceOf(Bs9Client);
    expect(bs9.parseLogSize("2M")).toBe(2 * 1024 * 1024);
    const conf = bs9.exportProxyConfig("caddy", {
      serviceName: "sdk-app",
      domain: "sdk.example.com",
      upstreams: [{ host: "127.0.0.1", port: 8080 }],
    });
    expect(conf).toContain("sdk.example.com");
    expect(conf).toContain("127.0.0.1:8080");
    expect(["linux", "darwin", "win32"]).toContain(bs9.getPlatform().platform);
  });

  test("Grafana dashboard export (SDK & CLI E2E), Alert Presets, and Cron scheduler work safely", () => {
    // 1. Grafana Dashboard JSON
    const grafanaJson = generateGrafanaDashboard({ title: "Prod Overview", serviceName: "api" });
    const parsedGrafana = JSON.parse(grafanaJson);
    expect(parsedGrafana.title).toBe("Prod Overview");
    expect(parsedGrafana.panels.length).toBe(5);
    expect(parsedGrafana.panels[0].targets[0].expr).toContain('bs9_service_up{service="api"}');

    const grafanaCli = spawnSync(
      "bun",
      ["run", BIN_BS9, "export", "--format", "grafana", "--service", "web"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(grafanaCli.status).toBe(0);
    expect(JSON.parse(grafanaCli.stdout).uid).toBe("bs9-overview");

    // 2. Alert Presets (Telegram, Discord, Slack)
    const event = {
      service: "api-prod",
      severity: "critical" as const,
      title: "High Crash Rate",
      message: "Worker restarted 5 times\u0000",
      host: "node-01",
      chatId: "123456",
    };
    const tg = formatAlertPayload("telegram", event);
    expect(tg.chat_id).toBe("123456");
    expect(String(tg.text)).toContain("api-prod");
    expect(String(tg.text)).not.toContain("\u0000");

    const discord = formatAlertPayload("discord", event) as any;
    expect(discord.embeds[0].color).toBe(0xef4444);
    expect(discord.embeds[0].title).toBe("High Crash Rate");

    const slack = formatAlertPayload("slack", event) as any;
    expect(slack.text).toContain("api-prod");
    expect(slack.blocks.length).toBe(1);

    // 3. Cron Expression Parser & Next Run
    const parsedCron = parseCronExpression("*/15 2-4 * * 1-5");
    expect(parsedCron.minutes.has(0)).toBe(true);
    expect(parsedCron.minutes.has(15)).toBe(true);
    expect(parsedCron.hours.has(3)).toBe(true);
    expect(parsedCron.daysOfWeek.has(0)).toBe(false);

    const baseDate = new Date("2026-11-16T01:50:00Z");
    const nextDate = getNextCronDate("0 * * * *", baseDate);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(getNextCronDelayMs("0 * * * *", baseDate)).toBe(10 * 60 * 1000);

    expect(() => parseCronExpression("* * *")).toThrow();
    expect(() => parseCronExpression("99 * * * *")).toThrow();
  });

  test("HealthAnomalyDetector detects memory leak trends, measures event-loop lag, and startCommand validates flags", async () => {
    const detector = new HealthAnomalyDetector({ minConsecutiveIncreases: 4, minGrowthRatio: 0.25 });

    // Normal sawtooth fluctuation should NOT trigger leak alert
    expect(detector.recordMemorySample("api", 100_000_000).leakSuspected).toBe(false);
    expect(detector.recordMemorySample("api", 105_000_000).leakSuspected).toBe(false);
    expect(detector.recordMemorySample("api", 98_000_000).leakSuspected).toBe(false);

    // Monotonic growth across 4+ consecutive samples with >=25% growth SHOULD trigger
    detector.recordMemorySample("leak-app", 100_000_000);
    detector.recordMemorySample("leak-app", 110_000_000);
    detector.recordMemorySample("leak-app", 120_000_000);
    detector.recordMemorySample("leak-app", 130_000_000);
    const finalRes = detector.recordMemorySample("leak-app", 140_000_000);
    expect(finalRes.leakSuspected).toBe(true);
    expect(finalRes.consecutiveIncreases).toBe(4);
    expect(finalRes.growthRatio).toBeCloseTo(0.4, 2);

    const alertPayload = detector.buildMemoryLeakAlert("slack", finalRes, "prod-01") as any;
    expect(alertPayload.text).toContain("leak-app");

    const lagMs = await detector.measureEventLoopLag();
    expect(lagMs).toBeGreaterThanOrEqual(0);

    // Security/input validation on startCommand flags
    await expect(startCommand(["app.ts"], { cron: "invalid cron" })).rejects.toThrow(/Invalid cron expression/);
    await expect(startCommand(["app.ts"], { maxLogSize: "50M; rm -rf /" })).rejects.toThrow(/Invalid --max-log-size/);
    await expect(startCommand(["app.ts"], { maxLogFiles: "-5" })).rejects.toThrow(/Invalid --max-log-files/);
  });

  test("Tamper-safe Audit Log and Startup Readiness Gate work securely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-audit-"));
    try {
      const auditFile = join(dir, "audit.log");
      const ok = recordAuditEvent(
        {
          action: "start\ninjected",
          target: "api\rprod",
          status: "success",
          details: "port=3000",
        },
        auditFile
      );
      expect(ok).toBe(true);

      const events = readAuditEvents(10, auditFile);
      expect(events.length).toBe(1);
      expect(events[0].action).toBe("start injected");
      expect(events[0].target).toBe("api prod");

      // Security: Refuse symlinked audit.log
      const victim = join(dir, "victim.txt");
      const linkAudit = join(dir, "evil-audit.log");
      writeFileSync(victim, "ORIGINAL", "utf8");
      symlinkSync(victim, linkAudit);
      expect(recordAuditEvent({ action: "test", target: "x", status: "denied" }, linkAudit)).toBe(false);
      expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Readiness Gate: polls until server responds < 500
    let readyFlag = false;
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/healthz") {
          return readyFlag ? new Response("ok", { status: 200 }) : new Response("booting", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    setTimeout(() => { readyFlag = true; }, 180);

    try {
      const readyRes = await waitForServiceReady({
        host: "0.0.0.0",
        port: srv.port!,
        timeoutMs: 3000,
        intervalMs: 50,
      });
      expect(readyRes.ready).toBe(true);
      expect(readyRes.status).toBe(200);
    } finally {
      srv.stop(true);
    }
  });
});
