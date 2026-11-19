import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabasePool, sanitizeSQL } from "../src/database/pool.js";
import { AlertManager, isBlockedIpAddress } from "../src/alerting/config.js";
import { KvEngine } from "../src/hub/engine.js";
import { LeaseManager } from "../src/hub/leases.js";
import { QueueManager } from "../src/hub/queues.js";
import { WalManager } from "../src/hub/wal.js";
import { Queue } from "../src/runtime/queue.js";
import { RuntimeBackend } from "../src/runtime/backend.js";
import { rotateLogIfNeeded } from "../src/utils/log-rotator.js";
import { AdvancedMonitoring } from "../src/monitoring/advanced.js";
import { withManifestLock } from "../src/utils/manifest-lock.js";
import { ClusterController } from "../src/cluster/controller.js";

describe("Security & QA Audit v3 Regression Suite", () => {
  describe("DatabasePool SQL sanitization, config validation, and release safety", () => {
    it("blocks dollar-quoted strings, backslash escapes, pg_sleep, and dangerous admin commands", () => {
      // Legitimate queries succeed
      expect(sanitizeSQL("SELECT id, name FROM users WHERE id = $1")).toContain("SELECT");
      expect(sanitizeSQL("SELECT COUNT(*) FROM logs WHERE level = 'info'")).toContain("SELECT");

      // Dollar-quoted DO blocks and stacked statements inside dollar-quoted strings
      expect(() => sanitizeSQL("DO $$ BEGIN PERFORM pg_sleep(5); END $$")).toThrow();
      expect(() => sanitizeSQL("DO $tag$ BEGIN DROP TABLE users; END $tag$")).toThrow();

      // Backslash-escaped quotes breaking out of a string literal
      expect(() => sanitizeSQL("SELECT * FROM users WHERE name = 'foo\\''; DROP TABLE users--")).toThrow();

      // Time-based blind SQLi and admin commands
      expect(() => sanitizeSQL("SELECT pg_sleep(5)")).toThrow();
      expect(() => sanitizeSQL("COPY users TO PROGRAM 'id'")).toThrow();
      expect(() => sanitizeSQL("ALTER SYSTEM SET max_connections = 10")).toThrow();
      expect(() => sanitizeSQL("CREATE ROLE evil SUPERUSER")).toThrow();
    });

    it("validates pool numeric config and ignores foreign or double release()", async () => {
      expect(() => new DatabasePool({ host: "localhost", port: 5432, database: "test", username: "postgres", password: "test", maxConnections: 0 })).toThrow();
      expect(() => new DatabasePool({ host: "localhost", port: 5432, database: "test", username: "postgres", password: "test", maxConnections: Number.NaN })).toThrow();
      expect(() => new DatabasePool({ host: "localhost", port: 5432, database: "test", username: "postgres", password: "test", minConnections: 5, maxConnections: 2 })).toThrow();

      const pool = new DatabasePool({ host: "localhost", port: 5432, database: "test", username: "postgres", password: "test", minConnections: 0, maxConnections: 2 });
      const fakeConn = { id: "foreign-1", inUse: true, createdAt: Date.now(), lastUsed: Date.now(), queryCount: 0, close: async () => {} } as any;
      await pool.release(fakeConn);
      expect(fakeConn.inUse).toBe(true);
      await pool.close();
    });
  });

  describe("Alerting SSRF IPv6/IPv4 blocking and prototype pollution defense", () => {
    it("blocks compressed IPv6 loopback, mapped/compatible IPv4, NAT64, 6to4, ULA, link-local, multicast, and reserved IPv4", () => {
      const blocked = [
        "0::1",
        "::0",
        "0000:0000:0000:0000:0000:0000:0000:0001",
        "0:0:0:0:0:ffff:127.0.0.1",
        "::127.0.0.1",
        "64:ff9b::127.0.0.1",
        "2002:7f00:0001::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "ff02::1",
        "2001:0::1",
        "2001:db8::1",
        "224.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "169.254.169.254",
      ];
      for (const ip of blocked) {
        expect(isBlockedIpAddress(ip)).toBe(true);
      }

      expect(isBlockedIpAddress("1.1.1.1")).toBe(false);
      expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
      expect(isBlockedIpAddress("2606:4700:4700::1111")).toBe(false);
    });

    it("rejects prototype pollution keys in AlertManager.setServiceAlert", () => {
      const tmp = mkdtempSync(join(tmpdir(), "bs9-alert-test-"));
      try {
        const manager = new AlertManager(join(tmp, "alerts.json"));
        expect(() => manager.setServiceAlert("__proto__", true)).toThrow();
        expect(() => manager.setServiceAlert("constructor", true)).toThrow();
        expect(() => manager.setServiceAlert("prototype", true)).toThrow();
        expect(({} as any).enabled).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("Hub Engine, Leases, Queues & WAL TTL replay", () => {
    it("does not resurrect expired KV keys during WAL replay", () => {
      const tmp = mkdtempSync(join(tmpdir(), "bs9-wal-ttl-"));
      try {
        const wal = new WalManager({ stateDir: tmp });
        const kv = new KvEngine({ maxNamespaceMemory: 1024 * 1024 });

        const expiredTs = Date.now() - 10_000;
        wal.append("test-ns", { seq: 1, op: "set", key: "expired-key", value: "stale", ttlMs: 1000, timestamp: expiredTs });
        wal.append("test-ns", { seq: 2, op: "cas", key: "expired-cas", expectedValue: null, newValue: "stale-cas", ttlMs: 1000, timestamp: expiredTs });
        wal.append("test-ns", { seq: 3, op: "set", key: "live-key", value: "fresh", ttlMs: 60_000, timestamp: Date.now() });
        wal.close();

        const wal2 = new WalManager({ stateDir: tmp });
        wal2.recover("test-ns", kv);
        expect(kv.get("test-ns", "expired-key")).toBeNull();
        expect(kv.get("test-ns", "expired-cas")).toBeNull();
        expect(kv.get("test-ns", "live-key")).toBe("fresh");
        wal2.close();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("validates finite TTLs in KvEngine and LeaseManager", () => {
      const kv = new KvEngine({ maxNamespaceMemory: 1024 * 1024 });
      expect(() => kv.set("ns", "k", "v", -1)).toThrow();
      expect(() => kv.set("ns", "k", "v", Number.NaN)).toThrow();
      expect(() => kv.set("ns", "k", "v", Number.POSITIVE_INFINITY)).toThrow();

      const leases = new LeaseManager();
      expect(() => leases.acquire("ns", "l1", 0, "owner")).toThrow();
      expect(() => leases.acquire("ns", "l1", Number.NaN, "owner")).toThrow();
      const acq = leases.acquire("ns", "l1", 5000, "owner");
      expect(acq.acquired).toBe(true);
      expect(() => leases.renew("ns", "l1", acq.fencingToken!, -5)).toThrow();
    });

    it("clears pre-existing queues absent from snapshot in QueueManager.importState and supports Queue publish/reserve/ack/nack", async () => {
      const qm = new QueueManager(0, 1024 * 1024);
      qm.publish("ns1", "old-queue", { x: 1 });
      qm.publish("ns1", "kept-queue", { x: 2 });

      qm.importState("ns1", {
        "kept-queue": [
          {
            id: "msg-1",
            payload: { x: 99 },
            createdAt: Date.now(),
            deliveryCount: 0,
            reservedUntil: 0,
          },
        ],
      });

      expect(qm.getMessages("ns1", "old-queue")).toHaveLength(0);
      expect(qm.getMessages("ns1", "kept-queue")).toHaveLength(1);
      expect(qm.getMessages("ns1", "kept-queue")[0].payload).toEqual({ x: 99 });

      const backend = new RuntimeBackend({ namespace: "ns-runtime" });
      const queue = new Queue(backend);
      const id = await queue.push("jobs", { task: "email" });
      const reserved = await queue.reserve("jobs", { visibilityTimeoutMs: 5000, count: 1 });
      expect(reserved).toHaveLength(1);
      expect(reserved[0].id).toBe(id);
      expect(await queue.nack("jobs", id)).toBe(true);
      const redelivered = await queue.reserve("jobs", { visibilityTimeoutMs: 5000, count: 1 });
      expect(redelivered).toHaveLength(1);
      expect(await queue.ack("jobs", id)).toBe(true);
      expect(await queue.reserve("jobs", { visibilityTimeoutMs: 5000, count: 1 })).toHaveLength(0);
      await backend.reset();
    });
  });

  describe("Log rotator, anomaly detection, manifest lock, and cluster lock edge cases", () => {
    it("handles non-finite maxFiles and maxBytes in rotateLogIfNeeded without hanging", () => {
      const tmp = mkdtempSync(join(tmpdir(), "bs9-logrot-"));
      try {
        const logFile = join(tmp, "app.log");
        writeFileSync(logFile, "x".repeat(2048), "utf8");
        const rotated = rotateLogIfNeeded(logFile, {
          maxBytes: 1024,
          maxFiles: Number.POSITIVE_INFINITY,
          compress: false,
        });
        expect(rotated).toBe(true);
        expect(readFileSync(logFile, "utf8")).toBe("");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("detects non-zero spike anomalies when baseline is 0", async () => {
      const mon = new AdvancedMonitoring();
      await mon.detectAnomalies({ api: { cpu: 0, memory: 0, responseTime: 0, errorRate: 0 } });
      const anomalies = await mon.detectAnomalies({ api: { cpu: 5, memory: 10, responseTime: 5, errorRate: 25 } });
      expect(anomalies.some((a) => a.metric === "errorRate")).toBe(true);
    });

    it("preserves original operation() error when manifest lock file is corrupted", () => {
      const tmp = mkdtempSync(join(tmpdir(), "bs9-mlock-"));
      try {
        const manifestPath = join(tmp, "manifest.json");
        expect(() =>
          withManifestLock(manifestPath, () => {
            writeFileSync(`${manifestPath}.lock`, "{corrupted-json", "utf8");
            throw new Error("original-operation-failure");
          })
        ).toThrow("original-operation-failure");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects invalid cluster names and non-positive/NaN timeoutMs in ClusterController.lockCluster", () => {
      const ctrl = new ClusterController();
      expect(() => ctrl.lockCluster("../bad", "manual", 1000)).toThrow();
      expect(() => ctrl.lockCluster("good-cluster", "manual", 0)).toThrow();
      expect(() => ctrl.lockCluster("good-cluster", "manual", Number.NaN)).toThrow();
    });
  });
});
