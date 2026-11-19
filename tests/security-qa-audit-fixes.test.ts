import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isBlockedIpAddress, AlertManager } from "../src/alerting/config.js";
import { formatTelegramAlert, formatDiscordAlert, formatSlackAlert } from "../src/utils/alert-presets.js";
import { generateGrafanaDashboard } from "../src/utils/grafana-export.js";
import { sanitizeSQL, DatabasePool } from "../src/database/pool.js";
import { LoadBalancer, parseBackends } from "../src/loadbalancer/manager.js";
import { QueueManager } from "../src/hub/queues.js";
import { LeaseManager } from "../src/hub/leases.js";
import { injectOpenTelemetry } from "../src/injectors/otel.js";
import { rotateLogIfNeeded } from "../src/utils/log-rotator.js";
import { MetricsStorage } from "../src/storage/metrics.js";

describe("Security & QA Audit Regression Tests", () => {
  test("SSRF isBlockedIpAddress blocks hex IPv4-mapped IPv6, zone IDs, multicast, and allows public IPs", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1%eth0")).toBe(true);
    expect(isBlockedIpAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:0a00:1")).toBe(true);
    expect(isBlockedIpAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isBlockedIpAddress("ff02::1")).toBe(true);

    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
    expect(isBlockedIpAddress("1.1.1.1")).toBe(false);
    expect(isBlockedIpAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("AlertManager uses Object.hasOwn for service configs (prototype pollution guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-alert-test-"));
    try {
      const configPath = join(dir, "alerts.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, thresholds: { cpu: 80, memory: 85, errorRate: 5, uptime: 99 }, channels: {}, cooldown: 300, services: {} }));
      const manager = new AlertManager(configPath);
      await expect(manager.checkAlerts("constructor", { cpu: 10, memory: 10, health: "healthy", uptime: 100 })).resolves.toBeUndefined();
      await expect(manager.checkAlerts("toString", { cpu: 10, memory: 10, health: "healthy", uptime: 100 })).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("alert-presets handle missing severity gracefully without throwing", () => {
    const event = { service: "api", title: "Test", message: "Details" } as any;
    expect(formatTelegramAlert(event).text).toContain("Severity: INFO");
    expect((formatDiscordAlert(event).embeds as any[])[0].fields[1].value).toBe("INFO");
    expect(formatSlackAlert(event).text).toContain("BS9 Alert");
  });

  test("generateGrafanaDashboard avoids empty {service=\"\"} and preserves bs9-overview uid", () => {
    const overview = JSON.parse(generateGrafanaDashboard({}));
    expect(overview.uid).toBe("bs9-overview");
    expect(overview.panels[0].targets[0].expr).toBe("sum(bs9_service_up)");

    const svc = JSON.parse(generateGrafanaDashboard({ serviceName: "my-api" }));
    expect(svc.uid).toBe("bs9-overview");
    expect(svc.panels[0].targets[0].expr).toBe('sum(bs9_service_up{service="my-api"})');
  });

  test("sanitizeSQL preserves string literals containing comment markers while blocking real SQL injection", () => {
    expect(sanitizeSQL("SELECT 'hello -- world' AS msg")).toBe("SELECT 'hello -- world' AS msg");
    expect(sanitizeSQL("SELECT 'it''s /* safe */' AS msg")).toBe("SELECT 'it''s /* safe */' AS msg");
    expect(() => sanitizeSQL("SELECT 1; DROP TABLE users")).toThrow();
    expect(() => sanitizeSQL("SELECT * FROM users UNION/**/SELECT * FROM secrets")).toThrow();
    expect(() => sanitizeSQL("SELECT 'ok'; -- comment\nDROP TABLE users")).toThrow();
  });

  test("DatabasePool.acquire rejects after close()", async () => {
    const pool = new DatabasePool({
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "tester",
      password: "secret",
      minConnections: 0,
      maxConnections: 2,
    });
    await pool.close();
    await expect(pool.acquire()).rejects.toThrow(/closing|closed/i);
  });

  test("parseBackends validates host, port, and weight and handles empty string", () => {
    expect(parseBackends("")).toEqual([]);
    const valid = parseBackends("localhost:3001:2,127.0.0.1:3002");
    expect(valid.length).toBe(2);
    expect(valid[0].weight).toBe(2);
    expect(valid[1].weight).toBe(1);

    expect(() => parseBackends("localhost:99999")).toThrow();
    expect(() => parseBackends("localhost:3001:0")).toThrow();
    expect(() => parseBackends("bad host!:3001")).toThrow();

    const lb = new LoadBalancer({
      port: 8080,
      algorithm: "round-robin",
      backends: [],
      healthCheck: { enabled: false, interval: 5000, timeout: 1000, path: "/health", retries: 2 },
    });
    lb.updateConfig({ backends: valid });
    expect(lb.getStats().backendStats.length).toBe(2);
  });

  test("QueueManager rejects empty queueName and safely clamps reserve parameters", () => {
    const store = new QueueManager(0);
    expect(() => store.publish("default", "", "hi")).toThrow();
    store.publish("default", "jobs", "payload-1");
    store.publish("default", "jobs", "payload-2");
    // maxMessages <= 0 clamps to 1, negative visibilityTimeoutMs clamps to 30000
    const reserved = store.reserve("default", "jobs", -5, -1);
    expect(reserved.length).toBe(1);
    expect(reserved[0].payload).toBe("payload-1");
    expect(reserved[0].reservedUntil).toBeGreaterThan(Date.now());
  });

  test("LeaseManager isolates namespace/leaseName pairs with JSON tuple keys and exports cleanly", () => {
    const store = new LeaseManager();
    const a = store.acquire("a:b", "c", 5000, "o1");
    const b = store.acquire("a", "b:c", 5000, "o2");
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(a.currentOwner).toBe("o1");
    expect(b.currentOwner).toBe("o2");
    const exported = store.exportState("a:b");
    expect(Object.keys(exported)).toEqual(["c"]);
    expect(exported["c"].record?.ownerId).toBe("o1");
  });

  test("injectOpenTelemetry preserves leading shebang and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-otel-test-"));
    try {
      const script = join(dir, "app.ts");
      writeFileSync(script, '#!/usr/bin/env bun\nconsole.log("hello");\n', "utf-8");
      injectOpenTelemetry(script, "test-svc");
      const once = readFileSync(script, "utf-8");
      expect(once.startsWith("#!/usr/bin/env bun\n")).toBe(true);
      expect(once).toContain("// BSN OpenTelemetry Auto-injection");

      injectOpenTelemetry(script, "test-svc");
      const twice = readFileSync(script, "utf-8");
      expect(twice).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rotateLogIfNeeded recreates empty log file after rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-rot-test-"));
    try {
      const logPath = join(dir, "svc.out.log");
      writeFileSync(logPath, "x".repeat(200), "utf-8");
      const rotated = rotateLogIfNeeded(logPath, { maxBytes: 100, maxFiles: 3, compress: false });
      expect(rotated).toBe(true);
      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(existsSync(logPath)).toBe(true);
      expect(lstatSync(logPath).size).toBe(0);

      writeFileSync(logPath, "y".repeat(200), "utf-8");
      const rotatedGz = rotateLogIfNeeded(logPath, { maxBytes: 100, maxFiles: 3 });
      expect(rotatedGz).toBe(true);
      expect(existsSync(`${logPath}.1.gz`)).toBe(true);
      expect(existsSync(logPath)).toBe(true);
      expect(lstatSync(logPath).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MetricsStorage.exportData escapes CSV formula injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs9-metrics-test-"));
    try {
      const storage = new MetricsStorage();
      (storage as any).storageDir = dir;
      storage.storeSnapshot([
        {
          name: "=CMD()|'/C calc'!A0",
          cpu: "12.5ms",
          memory: 1024,
          uptime: "10s",
          tasks: 1,
          health: "healthy",
          state: "+active",
        },
      ]);
      const csv = storage.exportData("csv", 24);
      expect(csv).toContain("'=CMD()|'/C calc'!A0");
      expect(csv).toContain("'+active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
