/**
 * BS9 - Runtime Client & Strict Fallback Policy Tests
 *
 * Tests:
 * 1. Standalone execution without BS9 env (pure in-memory out-of-the-box).
 * 2. BS9 env + Hub unavailable (fails loudly with specific descriptive error).
 * 3. BS9 env + Hub unavailable + allowDegradedLocal (succeeds with loud warning).
 * 4. BS9 env + Hub running (operations route to HubClient and persist to Hub engine).
 * 5. Package export resolution: import { state } from "bs9/runtime".
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { HubServer } from "../src/hub/server.js";
import {
  state,
  events,
  lease,
  queue,
  configureRuntime,
  getRuntimeConfig,
  resetRuntime,
  State,
  Events,
  Lease,
  Queue,
  isBs9Environment,
} from "../src/runtime/index.js";

function getUniqueSocketPath(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bs9-test-runtime-${prefix}-${Date.now()}-${rand}`;
  }
  return join(tmpdir(), `bs9-test-runtime-${prefix}-${Date.now()}-${rand}.sock`);
}

function getUniqueStateDir(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  return join(tmpdir(), `bs9-test-runtime-state-${prefix}-${Date.now()}-${rand}`);
}

describe("Milestone 4: Runtime Client & Strict Fallback Policy (`bs9/runtime`)", () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    // Clear BS9 env vars for clean test baseline
    delete process.env.BS9_CLUSTER;
    delete process.env.BS9_HUB_SOCKET;
    delete process.env.BS9_AUTH_TOKEN;
    delete process.env.BS9_AUTH_TOKEN_FILE;
    delete process.env.BS9_ALLOW_DEGRADED_LOCAL;
    await resetRuntime();
  });

  afterEach(async () => {
    await resetRuntime();
    process.env = { ...origEnv };
  });

  describe("1. Standalone Execution Without BS9 Environment", () => {
    test("should detect environment as non-BS9 outside cluster and hub socket", () => {
      expect(isBs9Environment()).toBe(false);
    });

    test("should execute all State KV methods in-memory without errors", async () => {
      // get on non-existent key returns null
      const initial = await state.get("key1");
      expect(initial).toBeNull();

      // set
      await state.set("key1", { hello: "world", count: 1 });
      const retrieved = await state.get<{ hello: string; count: number }>("key1");
      expect(retrieved).toEqual({ hello: "world", count: 1 });

      // incr
      const count1 = await state.incr("num_counter");
      expect(count1).toBe(1);
      const count2 = await state.incr("num_counter", 4);
      expect(count2).toBe(5);

      // cas
      const casFail = await state.cas("num_counter", 999, 100);
      expect(casFail.success).toBe(false);
      expect(casFail.currentValue).toBe(5);

      const casSuccess = await state.cas("num_counter", 5, 10);
      expect(casSuccess.success).toBe(true);
      expect(casSuccess.currentValue).toBe(10);
      expect(await state.get<number>("num_counter")).toBe(10);

      // delete
      const deleted = await state.delete("key1");
      expect(deleted).toBe(true);
      expect(await state.get("key1")).toBeNull();

      const deleteAgain = await state.delete("key1");
      expect(deleteAgain).toBe(false);
    });

    test("should handle TTL expiration in-memory", async () => {
      await state.set("expiring", "temporary", { ttlMs: 40 });
      expect(await state.get<string>("expiring")).toBe("temporary");

      await new Promise((r) => setTimeout(r, 60));
      expect(await state.get("expiring")).toBeNull();
    });

    test("should execute Events emit and on with unsubscribe in-memory", async () => {
      let callCount = 0;
      let lastPayload: any = null;

      const unsubscribe = events.on("user:action", (payload) => {
        callCount++;
        lastPayload = payload;
      });

      await events.emit("user:action", { action: "login", userId: "u123" });
      expect(callCount).toBe(1);
      expect(lastPayload).toEqual({ action: "login", userId: "u123" });

      // Unsubscribe
      unsubscribe();

      await events.emit("user:action", { action: "logout" });
      expect(callCount).toBe(1);
    });

    test("should execute Lease acquire and release in-memory", async () => {
      const lock1 = await lease.acquire("leader-lock", { ttlMs: 5000 });
      expect(lock1.acquired).toBe(true);
      expect(typeof lock1.token).toBe("string");

      // Concurrent acquire must fail
      const lock2 = await lease.acquire("leader-lock", { ttlMs: 5000 });
      expect(lock2.acquired).toBe(false);
      expect(lock2.token).toBeUndefined();

      // Release lock1
      await lock1.release();

      // Now acquire should succeed
      const lock3 = await lease.acquire("leader-lock", { ttlMs: 5000 });
      expect(lock3.acquired).toBe(true);
      await lock3.release();
    });

    test("should execute Lease runOnce in-memory", async () => {
      let executions = 0;

      const res1 = await lease.runOnce("single-migration", async () => {
        executions++;
        return "done";
      });
      expect(res1).toBe(true);
      expect(executions).toBe(1);

      // Subsequent call with same name must not run
      const res2 = await lease.runOnce("single-migration", async () => {
        executions++;
        return "done2";
      });
      expect(res2).toBe(false);
      expect(executions).toBe(1);
    });

    test("should execute Queue push and pop in FIFO order in-memory", async () => {
      const id1 = await queue.push("work", { task: "A" });
      const id2 = await queue.push("work", { task: "B" });
      expect(typeof id1).toBe("string");
      expect(typeof id2).toBe("string");

      const item1 = await queue.pop("work");
      expect(item1).toEqual({ task: "A" });

      const item2 = await queue.pop("work");
      expect(item2).toEqual({ task: "B" });

      // Queue empty returns null
      const empty = await queue.pop("work");
      expect(empty).toBeNull();
    });

    test("should support Queue pop with timeout", async () => {
      const startTime = Date.now();
      const item = await queue.pop("empty-queue", { timeoutMs: 80 });
      const elapsed = Date.now() - startTime;
      expect(item).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(60);
    });
  });

  describe("2. BS9 Environment + Hub Unavailable (Strict Failure)", () => {
    test("should fail loudly when BS9 env detected and Hub is unavailable", async () => {
      const fakeSocket = getUniqueSocketPath("unavailable");
      process.env.BS9_HUB_SOCKET = fakeSocket;
      process.env.BS9_CLUSTER = "true";

      expect(isBs9Environment()).toBe(true);

      // Calling state operation without allowDegradedLocal must reject with the exact error message
      let errorThrown: any = null;
      try {
        await state.get("some-key");
      } catch (err: any) {
        errorThrown = err;
      }

      expect(errorThrown).not.toBeNull();
      const expectedMsg = `BS9 State Hub unavailable at ${fakeSocket}. Set allowDegradedLocal=true in runtime config if local in-memory fallback is acceptable.`;
      expect(errorThrown.message).toBe(expectedMsg);
    });

    test("should fail loudly for Lease and Queue operations when Hub is unavailable", async () => {
      const fakeSocket = getUniqueSocketPath("unavailable-lq");
      process.env.BS9_HUB_SOCKET = fakeSocket;

      await expect(lease.acquire("test-lock")).rejects.toThrow(
        `BS9 State Hub unavailable at ${fakeSocket}. Set allowDegradedLocal=true in runtime config if local in-memory fallback is acceptable.`
      );

      await expect(queue.push("test-q", "item")).rejects.toThrow(
        `BS9 State Hub unavailable at ${fakeSocket}. Set allowDegradedLocal=true in runtime config if local in-memory fallback is acceptable.`
      );
    });
  });

  describe("3. BS9 Environment + Hub Unavailable + allowDegradedLocal (Degraded Fallback)", () => {
    test("should fall back to local in-memory with loud warning when allowDegradedLocal=true in config", async () => {
      const fakeSocket = getUniqueSocketPath("degraded");
      process.env.BS9_HUB_SOCKET = fakeSocket;

      configureRuntime({ allowDegradedLocal: true });

      const originalWarn = console.warn;
      let warningLogged = "";
      console.warn = (msg: string) => {
        warningLogged = msg;
      };

      try {
        await state.set("degraded_key", "degraded_val");
        const val = await state.get("degraded_key");
        expect(val).toBe("degraded_val");

        expect(warningLogged).toContain("[BS9 RUNTIME WARNING]");
        expect(warningLogged).toContain(`BS9 State Hub unavailable at ${fakeSocket}`);
        expect(warningLogged).toContain("allowDegradedLocal=true");
      } finally {
        console.warn = originalWarn;
      }
    });

    test("should respect BS9_ALLOW_DEGRADED_LOCAL environment variable", async () => {
      const fakeSocket = getUniqueSocketPath("degraded-env");
      process.env.BS9_HUB_SOCKET = fakeSocket;
      process.env.BS9_ALLOW_DEGRADED_LOCAL = "true";

      const originalWarn = console.warn;
      let warningLogged = "";
      console.warn = (msg: string) => {
        warningLogged = msg;
      };

      try {
        const result = await state.incr("degraded_counter", 10);
        expect(result).toBe(10);
        expect(warningLogged).toContain("allowDegradedLocal=true");
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("4. BS9 Environment + Hub Running (Full Integration)", () => {
    let server: HubServer;
    let socketPath: string;
    let stateDir: string;
    const namespace = "runtime-hub-test";
    let token: string;

    beforeEach(async () => {
      socketPath = getUniqueSocketPath("online");
      stateDir = getUniqueStateDir("online");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      token = reg.token;
      await server.start();

      process.env.BS9_HUB_SOCKET = socketPath;
      process.env.BS9_CLUSTER = "true";
      process.env.BS9_CLUSTER_NAME = namespace;
      process.env.BS9_AUTH_TOKEN = token;
      await resetRuntime();
    });

    afterEach(async () => {
      await resetRuntime();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("operations should route to HubClient and persist in Hub engine", async () => {
      // 1. Set via runtime state client
      await state.set("hub_shared_key", { order: 999, active: true });

      // 2. Get via runtime state client
      const readVal = await state.get<{ order: number; active: boolean }>("hub_shared_key");
      expect(readVal).toEqual({ order: 999, active: true });

      // 3. Verify directly on HubServer's KvEngine that data was truly sent over wire to Hub!
      const hubEngineVal = server.engine.get(namespace, "hub_shared_key");
      expect(hubEngineVal).toEqual({ order: 999, active: true });

      // 4. Test atomic incr on Hub
      const counterVal = await state.incr("hub_counter", 5);
      expect(counterVal).toBe(5);
      expect(server.engine.get(namespace, "hub_counter")).toBe(5);

      // 5. Test atomic CAS on Hub
      const casRes = await state.cas("hub_counter", 5, 50);
      expect(casRes.success).toBe(true);
      expect(casRes.currentValue).toBe(50);
      expect(server.engine.get(namespace, "hub_counter")).toBe(50);

      // 6. Test delete on Hub
      const delRes = await state.delete("hub_shared_key");
      expect(delRes).toBe(true);
      expect(server.engine.get(namespace, "hub_shared_key")).toBeNull();
    });

    test("Lease coordination should persist and sync through Hub engine", async () => {
      const lock = await lease.acquire("distributed-job", { ttlMs: 10000 });
      expect(lock.acquired).toBe(true);

      // Direct check in Hub engine: lease key exists
      const rawLease = server.engine.get(namespace, "__bs9_lease:distributed-job");
      expect(rawLease).toBe(lock.token);

      // Another acquire attempt must fail
      const lock2 = await lease.acquire("distributed-job", { ttlMs: 10000 });
      expect(lock2.acquired).toBe(false);

      // Release
      await lock.release();
      expect(server.engine.get(namespace, "__bs9_lease:distributed-job")).toBeNull();
    });

    test("Queue should persist items and synchronize FIFO order through Hub", async () => {
      const qid1 = await queue.push("order-queue", { orderId: "ORD-1" });
      const qid2 = await queue.push("order-queue", { orderId: "ORD-2" });
      expect(typeof qid1).toBe("string");
      expect(typeof qid2).toBe("string");

      // Verify Hub engine holds queue array
      const rawQueue = server.engine.get(namespace, "__bs9_queue:order-queue");
      expect(Array.isArray(rawQueue)).toBe(true);
      expect(rawQueue.length).toBe(2);

      const pop1 = await queue.pop("order-queue");
      expect(pop1).toEqual({ orderId: "ORD-1" });

      const pop2 = await queue.pop("order-queue");
      expect(pop2).toEqual({ orderId: "ORD-2" });

      const empty = await queue.pop("order-queue");
      expect(empty).toBeNull();
    });
  });

  describe("5. Package Resolution & Exports (`bs9/runtime`)", () => {
    test("should successfully import from 'bs9/runtime' subpath export", async () => {
      const runtime = await import("bs9/runtime");

      // Check singletons
      expect(runtime.state).toBeDefined();
      expect(runtime.events).toBeDefined();
      expect(runtime.lease).toBeDefined();
      expect(runtime.queue).toBeDefined();

      // Check config functions
      expect(typeof runtime.configureRuntime).toBe("function");
      expect(typeof runtime.getRuntimeConfig).toBe("function");

      // Check classes
      expect(runtime.State).toBeDefined();
      expect(runtime.Events).toBeDefined();
      expect(runtime.Lease).toBeDefined();
      expect(runtime.Queue).toBeDefined();

      // Check functions on imported singleton
      expect(typeof runtime.state.get).toBe("function");
      expect(typeof runtime.state.set).toBe("function");
      expect(typeof runtime.state.delete).toBe("function");
      expect(typeof runtime.state.incr).toBe("function");
      expect(typeof runtime.state.cas).toBe("function");

      expect(typeof runtime.events.emit).toBe("function");
      expect(typeof runtime.events.on).toBe("function");

      expect(typeof runtime.lease.acquire).toBe("function");
      expect(typeof runtime.lease.runOnce).toBe("function");

      expect(typeof runtime.queue.push).toBe("function");
      expect(typeof runtime.queue.pop).toBe("function");
    });

    test("should instantiate custom State, Lease, and Queue classes", async () => {
      const customState = new State();
      const customLease = new Lease(customState);
      const customQueue = new Queue(customState);

      await customState.set("custom_test", 123);
      expect(await customState.get<number>("custom_test")).toBe(123);

      const qId = await customQueue.push("cq", "item");
      expect(typeof qId).toBe("string");
      expect(await customQueue.pop("cq")).toBe("item");

      const acquired = await customLease.acquire("cl");
      expect(acquired.acquired).toBe(true);
      await acquired.release();
    });
  });
});
