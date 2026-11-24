/**
 * BS9 - SharedMap & SharedSet Unit Tests
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SharedMap, SharedSet, resetRuntime } from "../src/runtime/index.js";

describe("SharedMap & SharedSet (`bs9/runtime`)", () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
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

  describe("SharedMap", () => {
    test("supports basic get, set, has, delete, keys, values, entries, size, clear", async () => {
      const carts = new SharedMap<{ items: string[] }>("carts");
      expect(await carts.size()).toBe(0);
      expect(await carts.get("u1")).toBeUndefined();
      expect(await carts.has("u1")).toBe(false);

      await carts.set("u1", { items: ["book"] });
      await carts.set("u2", { items: ["coffee", "tea"] });

      expect(await carts.has("u1")).toBe(true);
      expect(await carts.get("u1")).toEqual({ items: ["book"] });
      expect(await carts.size()).toBe(2);
      expect(await carts.keys()).toEqual(["u1", "u2"]);
      expect(await carts.values()).toEqual([{ items: ["book"] }, { items: ["coffee", "tea"] }]);
      expect(await carts.entries()).toEqual([
        ["u1", { items: ["book"] }],
        ["u2", { items: ["coffee", "tea"] }],
      ]);

      expect(await carts.delete("u1")).toBe(true);
      expect(await carts.delete("u1")).toBe(false);
      expect(await carts.size()).toBe(1);
      expect(await carts.keys()).toEqual(["u2"]);

      await carts.clear();
      expect(await carts.size()).toBe(0);
      expect(await carts.get("u2")).toBeUndefined();
    });

    test("isolates namespaces and handles concurrent writes", async () => {
      const mapA = new SharedMap<number>("ns-a");
      const mapB = new SharedMap<number>("ns-b");

      await Promise.all([
        mapA.set("k1", 1),
        mapA.set("k2", 2),
        mapA.set("k3", 3),
        mapB.set("k1", 99),
      ]);

      expect(await mapA.get("k1")).toBe(1);
      expect(await mapB.get("k1")).toBe(99);
      expect(await mapA.size()).toBe(3);
      expect(await mapB.size()).toBe(1);
    });

    test("evicts expired keys from index on read", async () => {
      const cache = new SharedMap<string>("ttl-cache", { ttlMs: 30 });
      await cache.set("short", "val");
      expect(await cache.get("short")).toBe("val");

      await new Promise((r) => setTimeout(r, 50));
      expect(await cache.get("short")).toBeUndefined();
      expect(await cache.size()).toBe(0);
    });
  });

  describe("SharedSet", () => {
    test("supports add, has, delete, values, size, clear, and deduplication", async () => {
      const online = new SharedSet<string>("online-users");
      expect(await online.size()).toBe(0);

      await online.add("alice");
      await online.add("bob");
      await online.add("alice"); // duplicate

      expect(await online.size()).toBe(2);
      expect(await online.has("alice")).toBe(true);
      expect(await online.has("charlie")).toBe(false);
      expect(await online.values()).toEqual(["alice", "bob"]);

      expect(await online.delete("alice")).toBe(true);
      expect(await online.delete("alice")).toBe(false);
      expect(await online.size()).toBe(1);
      expect(await online.values()).toEqual(["bob"]);

      await online.clear();
      expect(await online.size()).toBe(0);
    });

    test("handles concurrent adds without losing items via CAS", async () => {
      const set = new SharedSet<string>("concurrent-set");
      await Promise.all(["w1", "w2", "w3", "w4", "w5"].map((id) => set.add(id)));
      const vals = await set.values();
      expect(vals.length).toBe(5);
      expect(vals.sort()).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    });
  });
});
