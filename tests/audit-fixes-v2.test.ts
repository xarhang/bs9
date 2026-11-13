import { describe, it, expect } from "bun:test";
import { isValidWebhookUrl } from "../src/alerting/config.js";
import { sanitizeSQL, DatabasePool } from "../src/database/pool.js";
import { LoadBalancer } from "../src/loadbalancer/manager.js";
import { AdvancedMonitoring } from "../src/monitoring/advanced.js";
import { findClusterWorkers, resolveActiveWorkerForSlot } from "../src/utils/service-discovery.js";

describe("Security & Bug Fix Verification Suite", () => {
  describe("1. SSRF Protection in Webhook Alerting", () => {
    it("allows valid public HTTP/HTTPS webhook URLs", () => {
      expect(isValidWebhookUrl("https://hooks.slack.com/services/T00/B00/XXX")).toBe(true);
      expect(isValidWebhookUrl("http://webhook.example.com:8080/alert")).toBe(true);
    });

    it("blocks loopback, private, link-local/metadata, and internal URLs", () => {
      expect(isValidWebhookUrl("http://localhost:8080/hook")).toBe(false);
      expect(isValidWebhookUrl("http://127.0.0.1:8080/hook")).toBe(false);
      expect(isValidWebhookUrl("http://[::1]:8080/hook")).toBe(false);
      expect(isValidWebhookUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isValidWebhookUrl("http://10.0.0.5/internal")).toBe(false);
      expect(isValidWebhookUrl("http://172.16.0.1/internal")).toBe(false);
      expect(isValidWebhookUrl("http://192.168.1.1/admin")).toBe(false);
      expect(isValidWebhookUrl("http://metadata.internal/token")).toBe(false);
      expect(isValidWebhookUrl("http://service.local/hook")).toBe(false);
    });
  });

  describe("2. SQL Sanitizer & IPv4 Validation & Pool Concurrency", () => {
    it("blocks SQL comment-splitting bypasses and stacked queries", () => {
      expect(() => sanitizeSQL("DROP/**/TABLE users")).toThrow(/Dangerous SQL/);
      expect(() => sanitizeSQL("SELECT 1 UNION/**/SELECT password FROM users")).toThrow(/Dangerous SQL/);
      expect(() => sanitizeSQL("SELECT 1; DROP TABLE users")).toThrow(/Dangerous SQL/);
      expect(() => sanitizeSQL("SELECT * FROM users -- comment\n; DELETE FROM users")).toThrow(/Dangerous SQL/);
      expect(sanitizeSQL("SELECT id, name FROM users WHERE id = $1")).toBe("SELECT id, name FROM users WHERE id = $1");
    });

    it("rejects out-of-range IPv4 octets in DatabasePool and LoadBalancer", () => {
      expect(() => new DatabasePool({
        host: "999.999.999.999",
        port: 5432,
        database: "appdb",
        username: "appuser",
        password: "secret",
        mock: true,
      })).toThrow(/Invalid database host/);

      expect(() => new LoadBalancer({
        port: 8080,
        algorithm: "round-robin",
        healthCheck: { enabled: false, path: "/healthz", interval: 5000, timeout: 1000, retries: 1 },
        backends: [{
          id: "b1",
          host: "256.1.1.1",
          port: 3000,
          connections: 0,
          healthy: true,
          lastHealthCheck: 0,
          responseTime: 0,
        }],
      })).toThrow(/Invalid backend host/);
    });

    it("enforces maxConnections under concurrent DatabasePool.acquire() calls", async () => {
      const pool = new DatabasePool({
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "secret",
        mock: true,
        maxConnections: 2,
        minConnections: 0,
        acquireTimeoutMillis: 200,
      });

      // Acquire 3 connections concurrently when maxConnections is 2
      const results = await Promise.allSettled([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      const rejected = results.filter(r => r.status === "rejected");

      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(1);
      expect(pool.getStats().totalConnections).toBe(2);

      for (const r of fulfilled) {
        if (r.status === "fulfilled") {
          await pool.release(r.value);
        }
      }
      await pool.close();
    });
  });

  describe("3. Advanced Monitoring XSS & Division-by-Zero Fixes", () => {
    it("escapes HTML in widget title, id, unit, and chartType", () => {
      const mon = new AdvancedMonitoring();
      mon.addWidget({
        id: 'xss"id',
        type: "metric",
        title: "<script>alert(1)</script>",
        config: { unit: "<img src=x onerror=alert(1)>", value: 42 },
        position: { x: 0, y: 0, width: 300, height: 200 },
      });

      const html = mon.generateDashboard();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("establishes baseline without Infinity/NaN when baseline is 0 or missing", async () => {
      const mon = new AdvancedMonitoring();
      const firstPass = await mon.detectAnomalies({ api: { cpu: 25, idle: 0 } });
      expect(firstPass.length).toBe(0);

      // Subsequent spike (>30% over baseline 25) should be detected cleanly
      const secondPass = await mon.detectAnomalies({ api: { cpu: 50, idle: 0 } });
      expect(secondPass.length).toBe(1);
      expect(secondPass[0].metric).toBe("cpu");
      expect(Number.isFinite(secondPass[0].threshold)).toBe(true);
    });
  });

  describe("4. Regex Escaping in Service Discovery", () => {
    it("safely handles regex metacharacters in findClusterWorkers and resolveActiveWorkerForSlot", async () => {
      const mockServices = [
        {
          name: "app(1)-0-g1",
          loaded: "loaded",
          active: "active",
          sub: "running",
          state: "active/running",
          cpu: "-",
          memory: "-",
          uptime: "-",
          tasks: "-",
          pid: "123",
          description: "BS9 Service: app(1)-0-g1",
        },
      ];

      const workers = await findClusterWorkers("app(1)", mockServices);
      expect(workers.length).toBe(1);
      expect(workers[0].name).toBe("app(1)-0-g1");

      const active = await resolveActiveWorkerForSlot("app(1)-0", mockServices);
      expect(active?.name).toBe("app(1)-0-g1");

      // Should not throw on unbalanced regex characters
      const empty = await findClusterWorkers("bad[pattern*", mockServices);
      expect(empty.length).toBe(0);
    });
  });

  describe("WindowsServiceManager daemon watchdog", () => {
    it("rejects non-BS9_DAEMON names in startDaemonWatchdog", async () => {
      const { WindowsServiceManager } = await import("../src/windows/service.js");
      const manager = new WindowsServiceManager();
      await expect(
        manager.startDaemonWatchdog({
          name: "BS9_Other",
          displayName: "Other",
          description: "Other",
          executable: process.execPath,
          arguments: [],
          workingDirectory: process.cwd(),
          environment: {},
        }),
      ).rejects.toThrow(/only be used for BS9_DAEMON/);
    });

    it("starts and stops background BS9_DAEMON watchdog even when elevated without an SCM service", async () => {
      const { WindowsServiceManager } = await import("../src/windows/service.js");
      const manager = new WindowsServiceManager();
      let createdForceBg = false;
      let startedMeta: any = null;
      let stoppedMeta: any = null;
      let stopServiceCalled = false;

      Object.assign(manager as any, {
        checkAdminPrivileges: () => true,
        getNativeServiceAccount: () => undefined,
        createService: async (_cfg: any, opts: any) => {
          createdForceBg = Boolean(opts?.forceBackground);
        },
        startBackgroundProcess: async (meta: any) => {
          startedMeta = meta;
        },
        getProcessMetadata: () => ({
          name: "BS9_DAEMON",
          backgroundOnly: true,
          pid: 12345,
          watchdogPid: 12346,
        }),
        stopBackgroundProcess: async (meta: any) => {
          stoppedMeta = meta;
        },
        stopService: async () => {
          stopServiceCalled = true;
        },
      });

      await manager.startDaemonWatchdog({
        name: "BS9_DAEMON",
        displayName: "BS9 Persistent Daemon",
        description: "BS9 Persistent Daemon",
        executable: process.execPath,
        arguments: ["run", "daemon.ts"],
        workingDirectory: process.cwd(),
        environment: { BS9_DAEMON: "true" },
      });

      expect(createdForceBg).toBe(true);
      expect(startedMeta?.name).toBe("BS9_DAEMON");
      expect(startedMeta?.backgroundOnly).toBe(true);

      await manager.stopDaemonWatchdog();
      expect(stopServiceCalled).toBe(false);
      expect(stoppedMeta?.pid).toBe(12345);
    });
  });
});

