import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, statSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { HubServer } from "../src/hub/server.js";
import { HubClient } from "../src/hub/client.js";
import { MAX_VALUE_SIZE } from "../src/hub/protocol.js";

function getUniqueSocketPath(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bs9-test-${prefix}-${Date.now()}-${rand}`;
  }
  return join(tmpdir(), `bs9-test-${prefix}-${Date.now()}-${rand}.sock`);
}

function getUniqueStateDir(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  return join(tmpdir(), `bs9-test-state-${prefix}-${Date.now()}-${rand}`);
}

describe("Milestone 3: Minimal State Hub Core", () => {
  describe("Authentication & Connection Security", () => {
    let server: HubServer;
    let socketPath: string;
    let stateDir: string;
    const namespace = "auth-test";
    let validToken: string;

    beforeAll(async () => {
      socketPath = getUniqueSocketPath("auth");
      stateDir = getUniqueStateDir("auth");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      validToken = reg.token;
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should authenticate client with valid HMAC challenge response", async () => {
      const client = new HubClient({
        socketPath,
        namespace,
        authToken: validToken,
      });

      const connected = await client.connect();
      expect(connected).toBe(true);
      expect(client.connected).toBe(true);
      await client.disconnect();
    });

    test("should reject client attempting connection with invalid token", async () => {
      const client = new HubClient({
        socketPath,
        namespace,
        authToken: "completely-invalid-secret-token",
      });

      const connected = await client.connect();
      expect(connected).toBe(false);
      expect(client.connected).toBe(false);
      await client.disconnect();
    });
  });

  describe("KV Engine: get, set, delete with TTL Expiration", () => {
    let server: HubServer;
    let client: HubClient;
    let socketPath: string;
    let stateDir: string;
    const namespace = "kv-ttl-test";

    beforeAll(async () => {
      socketPath = getUniqueSocketPath("kv");
      stateDir = getUniqueStateDir("kv");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      await server.start();

      client = new HubClient({
        socketPath,
        namespace,
        authToken: reg.token,
      });
      await client.connect();
    });

    afterAll(async () => {
      await client.disconnect();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should set and get basic string and object values", async () => {
      const setStr = await client.set("key_str", "hello-world");
      expect(setStr).toBe(true);
      const valStr = await client.get<string>("key_str");
      expect(valStr).toBe("hello-world");

      const objData = { name: "service-a", port: 3000, tags: ["web", "v1"] };
      const setObj = await client.set("key_obj", objData);
      expect(setObj).toBe(true);
      const valObj = await client.get<typeof objData>("key_obj");
      expect(valObj).toEqual(objData);
    });

    test("should delete existing key and return false for non-existent key", async () => {
      await client.set("temp_delete", "value-to-delete");
      expect(await client.get<string>("temp_delete")).toBe("value-to-delete");

      const deleted = await client.delete("temp_delete");
      expect(deleted).toBe(true);

      const valAfter = await client.get("temp_delete");
      expect(valAfter).toBeNull();

      const deleteAgain = await client.delete("temp_delete");
      expect(deleteAgain).toBe(false);
    });

    test("should expire key after TTL has elapsed (lazy & active eviction)", async () => {
      // Set key with 60ms TTL
      await client.set("ttl_key", "ephemeral_data", 60);

      // Immediately readable
      const immediate = await client.get("ttl_key");
      expect(immediate).toBe("ephemeral_data");

      // Wait for TTL expiration
      await new Promise((r) => setTimeout(r, 90));

      const expired = await client.get("ttl_key");
      expect(expired).toBeNull();
    });
  });

  describe("Atomic Increment: Concurrent Execution (No Lost Updates)", () => {
    let server: HubServer;
    let client: HubClient;
    let socketPath: string;
    let stateDir: string;
    const namespace = "incr-test";

    beforeAll(async () => {
      socketPath = getUniqueSocketPath("incr");
      stateDir = getUniqueStateDir("incr");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      await server.start();

      client = new HubClient({
        socketPath,
        namespace,
        authToken: reg.token,
      });
      await client.connect();
    });

    afterAll(async () => {
      await client.disconnect();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should increment from zero if key does not exist", async () => {
      const res = await client.incr("counter1");
      expect(res).toBe(1);

      const resDelta = await client.incr("counter1", 5);
      expect(resDelta).toBe(6);

      const resNeg = await client.incr("counter1", -2);
      expect(resNeg).toBe(4);
    });

    test("should handle concurrent increments without lost updates", async () => {
      const CONCURRENCY = 50;
      const key = "shared_concurrent_counter";

      // Execute 50 concurrent client.incr calls
      const promises: Promise<number>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(client.incr(key, 1));
      }

      const results = await Promise.all(promises);
      expect(results.length).toBe(CONCURRENCY);

      // Verify the final stored value is exactly CONCURRENCY
      const finalValue = await client.get<number>(key);
      expect(finalValue).toBe(CONCURRENCY);
    });

    test("should reject increment on non-numeric value with descriptive error", async () => {
      await client.set("str_key", "not_a_number");
      let errorCaught = false;
      try {
        await client.incr("str_key", 1);
      } catch (err) {
        errorCaught = true;
        expect((err as Error).message).toContain("not a numeric value");
      }
      expect(errorCaught).toBe(true);
    });
  });

  describe("CAS (Compare-And-Swap) Optimistic Locking", () => {
    let server: HubServer;
    let client: HubClient;
    let socketPath: string;
    let stateDir: string;
    const namespace = "cas-test";

    beforeAll(async () => {
      socketPath = getUniqueSocketPath("cas");
      stateDir = getUniqueStateDir("cas");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      await server.start();

      client = new HubClient({
        socketPath,
        namespace,
        authToken: reg.token,
      });
      await client.connect();
    });

    afterAll(async () => {
      await client.disconnect();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should succeed CAS when expected value matches, and fail when mismatched", async () => {
      await client.set("cas_item", "state_A");

      // Mismatch attempt: expected "state_B", actual is "state_A"
      const failCas = await client.cas("cas_item", "state_B", "state_C");
      expect(failCas.success).toBe(false);
      expect(failCas.currentValue).toBe("state_A");
      expect(await client.get<string>("cas_item")).toBe("state_A");

      // Match attempt: expected "state_A", actual is "state_A"
      const successCas = await client.cas("cas_item", "state_A", "state_C");
      expect(successCas.success).toBe(true);
      expect(successCas.currentValue).toBe("state_C");
      expect(await client.get<string>("cas_item")).toBe("state_C");
    });

    test("should support CAS insertion from null when key does not exist", async () => {
      const casInsert = await client.cas("new_cas_key", null, "initial_value");
      expect(casInsert.success).toBe(true);
      expect(casInsert.currentValue).toBe("initial_value");
      expect(await client.get<string>("new_cas_key")).toBe("initial_value");
    });

    test("should resolve concurrent CAS contention with exactly one winner", async () => {
      await client.set("contended_key", "base_epoch");

      const contestants = ["winner_1", "winner_2", "winner_3", "winner_4", "winner_5"];
      const promises = contestants.map((candidate) =>
        client.cas("contended_key", "base_epoch", candidate)
      );

      const outcomes = await Promise.all(promises);
      const successes = outcomes.filter((r) => r.success);
      const failures = outcomes.filter((r) => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(4);

      const winningValue = successes[0].currentValue;
      expect(await client.get("contended_key")).toBe(winningValue);
    });
  });

  describe("Security Controls & Memory / Size Limits", () => {
    let server: HubServer;
    let client: HubClient;
    let socketPath: string;
    let stateDir: string;
    const namespace = "limits-test";

    beforeAll(async () => {
      socketPath = getUniqueSocketPath("limits");
      stateDir = getUniqueStateDir("limits");
      server = new HubServer({
        socketPath,
        stateDir,
        maxValueSize: 1024, // 1 KB for fast limit testing
        maxNamespaceMemory: 4096, // 4 KB max
      });
      const reg = server.registerNamespaceToken(namespace);
      await server.start();

      client = new HubClient({
        socketPath,
        namespace,
        authToken: reg.token,
      });
      await client.connect();
    });

    afterAll(async () => {
      await client.disconnect();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should reject values exceeding maxValueSize limit", async () => {
      const largeString = "x".repeat(1500); // 1.5 KB > 1 KB limit
      let errorCaught = false;
      try {
        await client.set("too_big", largeString);
      } catch (err) {
        errorCaught = true;
        expect((err as Error).message).toContain("exceeds maximum limit");
      }
      expect(errorCaught).toBe(true);
    });

    test("should reject operations exceeding maxNamespaceMemory limit", async () => {
      const payload500b = "y".repeat(500);
      for (let i = 0; i < 5; i++) {
        await client.set(`item_${i}`, payload500b);
      }

      let errorCaught = false;
      try {
        // Exceeds 4 KB limit
        for (let i = 5; i < 15; i++) {
          await client.set(`item_${i}`, payload500b);
        }
      } catch (err) {
        errorCaught = true;
        expect((err as Error).message).toContain("Namespace memory limit exceeded");
      }
      expect(errorCaught).toBe(true);
    });
  });

  describe("Crash Simulation: Snapshot + WAL State Recovery", () => {
    const namespace = "crash-test";

    test("should recover state across abrupt Hub termination from snapshot + WAL", async () => {
      const socketPath = getUniqueSocketPath("crash");
      const stateDir = getUniqueStateDir("crash");

      // 1. Start Initial Hub
      let hub1: HubServer | null = new HubServer({ socketPath, stateDir });
      const reg = hub1.registerNamespaceToken(namespace);
      await hub1.start();

      let client1: HubClient | null = new HubClient({
        socketPath,
        namespace,
        authToken: reg.token,
      });
      await client1.connect();

      // Write snapshot baseline
      await client1.set("persist_1", "alpha");
      await client1.set("persist_2", "beta");

      // Trigger Snapshot
      const snapOk = await client1.snapshot();
      expect(snapOk).toBe(true);

      // Verify snapshot.json was generated
      const snapshotFile = hub1.wal.getSnapshotPath(namespace);
      expect(existsSync(snapshotFile)).toBe(true);

      // Write post-snapshot WAL entries
      await client1.set("persist_3", "gamma");
      await client1.set("persist_1", "alpha_modified");
      await client1.delete("persist_2");
      await client1.incr("wal_counter", 10);

      // 2. Abrupt Crash Simulation: destroy socket without clean snapshot
      await client1.disconnect();
      client1 = null;
      await hub1.stop();
      hub1 = null;

      // 3. Restart Hub from same state directory
      const restartedSocketPath = getUniqueSocketPath("restarted");
      const hub2 = new HubServer({
        socketPath: restartedSocketPath,
        stateDir,
      });
      hub2.registerNamespaceToken(namespace, reg.token);
      await hub2.start();

      const client2 = new HubClient({
        socketPath: restartedSocketPath,
        namespace,
        authToken: reg.token,
      });
      await client2.connect();

      // 4. Verify full state recovery
      // persist_1 should reflect WAL update
      expect(await client2.get<string>("persist_1")).toBe("alpha_modified");
      // persist_2 was in snapshot but deleted in WAL -> should be null
      expect(await client2.get("persist_2")).toBeNull();
      // persist_3 was created only in WAL -> should exist
      expect(await client2.get<string>("persist_3")).toBe("gamma");
      // wal_counter was incremented in WAL -> should be 10
      expect(await client2.get<number>("wal_counter")).toBe(10);

      await client2.disconnect();
      await hub2.stop();

      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe("Partial / Corrupted WAL Record Recovery", () => {
    const namespace = "corrupt-wal-test";

    test("should detect corrupted trailing bytes, truncate invalid tail, and recover valid entries", async () => {
      const socketPath1 = getUniqueSocketPath("wal-corrupt-1");
      const stateDir = getUniqueStateDir("wal-corrupt");

      // 1. Initial Hub session: write valid records
      let hub1: HubServer | null = new HubServer({ socketPath: socketPath1, stateDir });
      const reg = hub1.registerNamespaceToken(namespace);
      await hub1.start();

      let client1: HubClient | null = new HubClient({
        socketPath: socketPath1,
        namespace,
        authToken: reg.token,
      });
      await client1.connect();

      await client1.set("valid_a", "val_1");
      await client1.set("valid_b", "val_2");
      await client1.set("valid_c", "val_3");

      const walPath = hub1.wal.getWalPath(namespace);
      expect(existsSync(walPath)).toBe(true);

      await client1.disconnect();
      client1 = null;
      await hub1.stop();
      hub1 = null;

      const validWalSize = statSync(walPath).size;
      expect(validWalSize).toBeGreaterThan(0);

      // 2. Corrupt the WAL by injecting invalid trailing bytes (simulating partial write during crash)
      // Scenario A: Truncated frame header (5 arbitrary bytes)
      // Scenario B: Frame with broken payload or CRC mismatch
      const corruptedBytes = Buffer.from([0x00, 0x00, 0x00, 0x20, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
      writeFileSync(walPath, corruptedBytes, { flag: "a" });

      const corruptedWalSize = statSync(walPath).size;
      expect(corruptedWalSize).toBe(validWalSize + corruptedBytes.length);

      // 3. Restart Hub
      const socketPath2 = getUniqueSocketPath("wal-corrupt-2");
      const hub2 = new HubServer({ socketPath: socketPath2, stateDir });
      hub2.registerNamespaceToken(namespace, reg.token);
      await hub2.start();

      const client2 = new HubClient({
        socketPath: socketPath2,
        namespace,
        authToken: reg.token,
      });
      await client2.connect();

      // 4. Verify all valid entries prior to corruption were successfully recovered
      expect(await client2.get<string>("valid_a")).toBe("val_1");
      expect(await client2.get<string>("valid_b")).toBe("val_2");
      expect(await client2.get<string>("valid_c")).toBe("val_3");

      // 5. Verify the corrupted tail was truncated safely
      const truncatedSize = statSync(walPath).size;
      expect(truncatedSize).toBe(validWalSize);

      // 6. Verify subsequent writes continue seamlessly
      await client2.set("valid_d", "val_4");
      expect(await client2.get<string>("valid_d")).toBe("val_4");

      const newWalSize = statSync(walPath).size;
      expect(newWalSize).toBeGreaterThan(validWalSize);

      await client2.disconnect();
      await hub2.stop();

      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});
