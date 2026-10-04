import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubServer } from "../src/hub/server.js";
import { KvEngine } from "../src/hub/engine.js";
import { LeaseManager } from "../src/hub/leases.js";
import { QueueManager } from "../src/hub/queues.js";
import { WalManager } from "../src/hub/wal.js";

describe("Hub WAL hardening regressions", () => {
  let stateDir = "";

  afterEach(() => {
    if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  });

  it("compacts non-queue WAL records before the configured cap and recovers both states", () => {
    stateDir = join(tmpdir(), `bs9-wal-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const namespace = "cap-test";
    const wal = new WalManager({ stateDir, maxWalBytes: 140 });
    const engine = new KvEngine({ evictionIntervalMs: 0 });
    const leases = new LeaseManager();
    const queues = new QueueManager(0);

    engine.set(namespace, "first", "one");
    wal.append(namespace, { seq: 1, op: "set", key: "first", value: "one", timestamp: Date.now() });
    wal.appendWithSnapshot(namespace, {
      seq: 2,
      op: "set",
      key: "second",
      value: "two",
      timestamp: Date.now(),
    }, { engine, leases, queues });
    engine.set(namespace, "second", "two");

    expect(JSON.parse(readFileSync(wal.getSnapshotPath(namespace), "utf-8")).lastWalSeq).toBe(1);
    expect(statSync(wal.getWalPath(namespace)).size).toBeLessThanOrEqual(140);

    wal.close();
    const recoveredWal = new WalManager({ stateDir, maxWalBytes: 140 });
    const recoveredEngine = new KvEngine({ evictionIntervalMs: 0 });
    expect(recoveredWal.recover(namespace, recoveredEngine).replayedWalRecords).toBe(1);
    expect(recoveredEngine.get(namespace, "first")).toBe("one");
    expect(recoveredEngine.get(namespace, "second")).toBe("two");
    recoveredWal.close();
    engine.close();
    recoveredEngine.close();
    queues.close();
  });

  it("keeps failed KV and lease mutations invisible when the durable append fails", async () => {
    stateDir = join(tmpdir(), `bs9-wal-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hub = new HubServer({ stateDir, autoRecover: false });
    const append = hub.wal.appendWithSnapshot.bind(hub.wal);
    hub.wal.appendWithSnapshot = (() => { throw new Error("injected disk failure"); }) as typeof hub.wal.appendWithSnapshot;

    expect(() => hub.set("atomic", "key", "value")).toThrow("injected disk failure");
    expect(hub.engine.get("atomic", "key")).toBeNull();
    expect(() => hub.leaseAcquire("atomic", "lock", 5000, "worker")).toThrow("injected disk failure");
    expect(hub.leases.get("atomic", "lock")).toBeNull();

    hub.wal.appendWithSnapshot = append;
    await hub.stop();
  });

  it("rejects non-finite TTL and queue visibility durations before mutating state", async () => {
    stateDir = join(tmpdir(), `bs9-wal-invalid-duration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hub = new HubServer({ stateDir, autoRecover: false });
    try {
      expect(() => hub.set("durations", "key", "value", Infinity)).toThrow("TTL must be a finite number");
      expect(() => hub.cas("durations", "key", null, "value", Infinity)).toThrow("TTL must be a finite number");
      expect(() => hub.leaseAcquire("durations", "lock", Infinity, "worker")).toThrow("Lease TTL must be a finite number");
      expect(() => hub.leaseAcquire("durations", "lock", undefined as unknown as number, "worker"))
        .toThrow("Lease TTL must be a finite number");
      expect(() => hub.leaseRenew("durations", "lock", 1, Infinity)).toThrow("Lease TTL must be a finite number");
      expect(() => hub.leaseRenew("durations", "lock", 1, undefined as unknown as number))
        .toThrow("Lease TTL must be a finite number");
      hub.queuePublish("durations", "jobs", { task: "run" });
      expect(() => hub.queueReserve("durations", "jobs", Infinity)).toThrow("Queue visibility timeout must be a finite number");
      expect(hub.engine.get("durations", "key")).toBeNull();
      expect(hub.leases.get("durations", "lock")).toBeNull();
      expect(hub.queues.getMessages("durations", "jobs")[0]?.deliveryCount).toBe(0);
    } finally {
      await hub.stop();
    }
  });

  it("fails closed on unsafe or over-deep options from legacy queue records", () => {
    const queues = new QueueManager(0);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 102; i++) {
      const child: Record<string, unknown> = {};
      cursor.next = child;
      cursor = child;
    }
    expect(() => queues.applyPublish("legacy", "q", "deep", {}, Date.now(), deep)).toThrow("nesting depth");

    const unsafe = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
    expect(() => queues.applyPublish("legacy", "q", "unsafe", {}, Date.now(), unsafe)).toThrow("prototype pollution");
    expect(queues.exportState("legacy")).toEqual({});
    queues.close();
  });

  it("ignores interrupted namespace migration temp directories while preserving the legacy source", () => {
    stateDir = join(tmpdir(), `bs9-wal-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const namespace = "legacy.with.dots";
    const wal = new WalManager({ stateDir });
    const dataDir = join(stateDir, "hub-data");
    const legacyDir = join(dataDir, "legacy_with_dots");
    const targetDir = wal.getNamespaceDir(namespace);
    const interruptedDir = `${targetDir}.migrate.11111111-2222-4333-8444-555555555555`;
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(interruptedDir, { recursive: true });
    writeFileSync(join(interruptedDir, "snapshot.json"), "partial snapshot", "utf-8");
    writeFileSync(join(legacyDir, "snapshot.json"), JSON.stringify({
      version: 1,
      namespace,
      lastWalSeq: 0,
      timestamp: Date.now(),
      entries: {},
    }), "utf-8");
    writeFileSync(join(legacyDir, "wal.log"), Buffer.alloc(0));

    expect(wal.listNamespacesOnDisk()).toContain(namespace);
    expect(existsSync(join(legacyDir, "snapshot.json"))).toBe(true);
    expect(existsSync(interruptedDir)).toBe(true);
    expect(existsSync(join(targetDir, "snapshot.json"))).toBe(true);
    wal.close();
  });

  it("starts for healthy namespaces when another namespace has an invalid snapshot", async () => {
    stateDir = join(tmpdir(), `bs9-recovery-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const badNamespace = "broken-tenant";
    const healthyNamespace = "healthy-tenant";
    const preparedWal = new WalManager({ stateDir });
    mkdirSync(preparedWal.getNamespaceDir(badNamespace), { recursive: true });
    writeFileSync(preparedWal.getSnapshotPath(badNamespace), "{invalid snapshot", "utf-8");
    preparedWal.append(healthyNamespace, {
      seq: 1,
      op: "set",
      key: "available",
      value: "yes",
      timestamp: Date.now(),
    });
    const badWalPath = preparedWal.getWalPath(badNamespace);
    const badWalBefore = existsSync(badWalPath) ? readFileSync(badWalPath) : null;
    preparedWal.close();

    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\bs9-recovery-isolation-${Date.now()}`
      : join(stateDir, "hub.sock");
    const hub = new HubServer({ stateDir, socketPath });
    try {
      await hub.start();
      expect(hub.isListening()).toBe(true);
      expect(hub.get(healthyNamespace, "available")).toBe("yes");
      expect(() => hub.get(badNamespace, "unavailable")).toThrow("SNAPSHOT_INVALID");
      expect(existsSync(badWalPath) ? readFileSync(badWalPath) : null).toEqual(badWalBefore);
    } finally {
      await hub.stop();
    }
  });

  it("rebuilds queue and lease projections from snapshot plus replayed ack and release records", async () => {
    stateDir = join(tmpdir(), `bs9-projection-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const namespace = "projection-replay";
    let hub = new HubServer({ stateDir, autoRecover: false });
    const { messageId } = hub.queuePublish(namespace, "jobs", { task: "run" });
    const lease = hub.leaseAcquire(namespace, "deploy", 60_000, "worker");
    expect(lease.acquired).toBe(true);
    hub.snapshot(namespace);
    expect(hub.queueAck(namespace, "jobs", messageId)).toBe(true);
    expect(hub.leaseRelease(namespace, "deploy", lease.fencingToken!)).toEqual({ released: true });
    await hub.stop();

    hub = new HubServer({ stateDir, autoRecover: false });
    expect(hub.get(namespace, "__bs9_queue:jobs")).toBeNull();
    expect(hub.get(namespace, "__bs9_lease:deploy")).toBeNull();
    expect(hub.queues.getMessages(namespace, "jobs")).toEqual([]);
    expect(hub.leases.get(namespace, "deploy")).toBeNull();
    await hub.stop();
  });
});
