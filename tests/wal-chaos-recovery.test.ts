import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WalManager } from "../src/hub/wal.js";
import { KvEngine } from "../src/hub/engine.js";
import { LeaseManager } from "../src/hub/leases.js";
import { QueueManager } from "../src/hub/queues.js";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("State Hub WAL Chaos & Corruption Recovery QA Suite", () => {
  let testStateDir: string;
  let wal: WalManager;
  let engine: KvEngine;
  let leases: LeaseManager;
  let queues: QueueManager;
  const ns = "chaos_test_ns";

  beforeEach(() => {
    testStateDir = join(tmpdir(), `bs9-chaos-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testStateDir, { recursive: true });
    wal = new WalManager({ stateDir: testStateDir });
    engine = new KvEngine();
    leases = new LeaseManager();
    queues = new QueueManager();
  });

  afterEach(() => {
    wal.close();
    try {
      if (existsSync(testStateDir)) {
        rmSync(testStateDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it("handles trailing partial bytes gracefully and recovers earlier valid records", () => {
    wal.append(ns, { seq: 1, op: "set", key: "k1", value: "v1", timestamp: Date.now() });
    wal.append(ns, { seq: 2, op: "set", key: "k2", value: "v2", timestamp: Date.now() });

    // Simulate power-loss / truncated write by appending 4 garbage bytes
    wal.close();
    const walPath = wal.getWalPath(ns);
    const originalBuf = readFileSync(walPath);
    const corruptedBuf = Buffer.concat([originalBuf, Buffer.from([0x01, 0x02, 0x03, 0x04])]);
    writeFileSync(walPath, corruptedBuf);

    // Re-initialize manager and recover
    const newWal = new WalManager({ stateDir: testStateDir });
    const newEngine = new KvEngine();
    const result = newWal.recover(ns, newEngine);

    expect(result.replayedWalRecords).toBe(2);
    expect(result.truncatedBytes).toBe(4);
    expect(newEngine.get(ns, "k1")).toBe("v1");
    expect(newEngine.get(ns, "k2")).toBe("v2");
    newWal.close();
  });

  it("detects CRC32 checksum mismatch and stops before corrupted frame", () => {
    wal.append(ns, { seq: 1, op: "set", key: "valid1", value: "val1", timestamp: Date.now() });
    wal.append(ns, { seq: 2, op: "set", key: "will_corrupt", value: "val2", timestamp: Date.now() });
    wal.close();

    const walPath = wal.getWalPath(ns);
    const buf = readFileSync(walPath);

    // Corrupt one byte inside the second record payload (flip a bit)
    buf[buf.length - 5] = buf[buf.length - 5] ^ 0xff;
    writeFileSync(walPath, buf);

    const newWal = new WalManager({ stateDir: testStateDir });
    const newEngine = new KvEngine();
    const result = newWal.recover(ns, newEngine);

    // First record was valid and replayed; second failed CRC and was truncated
    expect(result.replayedWalRecords).toBe(1);
    expect(newEngine.get(ns, "valid1")).toBe("val1");
    expect(newEngine.get(ns, "will_corrupt")).toBeNull();
    expect(result.truncatedBytes).toBeGreaterThan(0);
    newWal.close();
  });

  it("creates snapshot and replays subsequent WAL operations after restore", () => {
    engine.set(ns, "snapKey", "snapVal");
    wal.append(ns, { seq: 1, op: "set", key: "snapKey", value: "snapVal", timestamp: Date.now() });

    // Snapshot state
    wal.createSnapshot(ns, engine, leases, queues);

    // Append operations after snapshot
    wal.append(ns, { seq: 2, op: "set", key: "afterSnap", value: "liveVal", timestamp: Date.now() });
    wal.close();

    // Fresh recovery
    const freshWal = new WalManager({ stateDir: testStateDir });
    const freshEngine = new KvEngine();
    const res = freshWal.recover(ns, freshEngine);

    expect(res.snapshotLoaded).toBe(true);
    expect(res.entriesFromSnapshot).toBe(1);
    expect(res.replayedWalRecords).toBe(1);
    expect(freshEngine.get(ns, "snapKey")).toBe("snapVal");
    expect(freshEngine.get(ns, "afterSnap")).toBe("liveVal");
    freshWal.close();
  });

  it("handles completely invalid snapshot json gracefully", () => {
    const snapPath = wal.getSnapshotPath(ns);
    const dir = wal.getNamespaceDir(ns);
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapPath, "{ invalid json content ...", "utf-8");

    wal.append(ns, { seq: 1, op: "set", key: "survivor", value: "ok", timestamp: Date.now() });
    wal.close();

    const freshWal = new WalManager({ stateDir: testStateDir });
    const freshEngine = new KvEngine();
    const res = freshWal.recover(ns, freshEngine);

    expect(res.snapshotLoaded).toBe(false);
    expect(res.replayedWalRecords).toBe(1);
    expect(freshEngine.get(ns, "survivor")).toBe("ok");
    freshWal.close();
  });
});
