/**
 * BS9 - Zero-Code Compatibility Adapter for express-session Tests
 *
 * Requirements Tested:
 * 1. Compatibility boundaries & version range (supported: 1.17.x - 1.18.x).
 * 2. Store CRUD operations against State Hub (get, set, destroy, touch, all, length, clear, TTL).
 * 3. Auto-patching session() when options.store is omitted in BS9 environment.
 * 4. Standalone mode outside BS9 (doesn't throw, uses memory fallback).
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import session from "express-session";
import { HubServer } from "../src/hub/server.js";
import { HubClient } from "../src/hub/client.js";
import { state, resetRuntime } from "../src/runtime/index.js";
import {
  Bs9SessionStore,
  patchExpressSession,
  unpatchExpressSession,
  initExpressSessionAdapter,
  isBs9ClusterActive,
} from "../src/runtime/adapters/express-session.js";
import {
  checkPackageCompatibility,
  isPackageVersionSupported,
  detectPackageVersion,
} from "../src/runtime/adapters/registry.js";

function getUniqueSocketPath(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bs9-test-session-${prefix}-${Date.now()}-${rand}`;
  }
  return join(tmpdir(), `bs9-test-session-${prefix}-${Date.now()}-${rand}.sock`);
}

function getUniqueStateDir(prefix: string): string {
  const rand = Math.random().toString(36).slice(2);
  return join(tmpdir(), `bs9-test-session-state-${prefix}-${Date.now()}-${rand}`);
}

describe("Milestone 6: Zero-Code Compatibility Adapter for express-session", () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.BS9_CLUSTER;
    delete process.env.BS9_CLUSTER_NAME;
    delete process.env.BS9_HUB_SOCKET;
    delete process.env.BS9_AUTH_TOKEN;
    delete process.env.BS9_AUTH_TOKEN_FILE;
    delete process.env.BS9_ALLOW_DEGRADED_LOCAL;
    await resetRuntime();
    unpatchExpressSession();
  });

  afterEach(async () => {
    unpatchExpressSession();
    await resetRuntime();
    process.env = { ...origEnv };
  });

  describe("1. Compatibility Boundaries & Version Range Matrix", () => {
    test("should detect installed express-session version", () => {
      const ver = detectPackageVersion("express-session");
      expect(ver).not.toBeNull();
      expect(typeof ver).toBe("string");
    });

    test("should validate supported version range (1.17.x - 1.18.x)", () => {
      // Supported versions
      expect(isPackageVersionSupported("express-session", "1.17.0")).toBe(true);
      expect(isPackageVersionSupported("express-session", "1.17.3")).toBe(true);
      expect(isPackageVersionSupported("express-session", "1.18.0")).toBe(true);
      expect(isPackageVersionSupported("express-session", "1.18.1")).toBe(true);

      // Unsupported versions
      expect(isPackageVersionSupported("express-session", "1.16.9", { silent: true })).toBe(false);
      expect(isPackageVersionSupported("express-session", "1.19.0", { silent: true })).toBe(false);
      expect(isPackageVersionSupported("express-session", "2.0.0", { silent: true })).toBe(false);
      expect(isPackageVersionSupported("express-session", "0.9.0", { silent: true })).toBe(false);
    });

    test("should log warning and skip when an unsupported version or untracked package is used", () => {
      let warningLogged = "";
      const origWarn = console.warn;
      console.warn = (msg: string) => {
        warningLogged = msg;
      };

      try {
        const res1 = checkPackageCompatibility("express-session", "2.0.0");
        expect(res1.supported).toBe(false);
        expect(warningLogged).toContain("[BS9 ADAPTER WARNING]");
        expect(warningLogged).toContain("2.0.0");

        warningLogged = "";
        const res2 = checkPackageCompatibility("untracked-package", "1.0.0");
        expect(res2.supported).toBe(false);
        expect(warningLogged).toContain("Untracked package");
      } finally {
        console.warn = origWarn;
      }
    });
  });

  describe("2. Store CRUD Operations Against State Hub", () => {
    let server: HubServer;
    let socketPath: string;
    let stateDir: string;
    const namespace = "session-test-cluster";
    let token: string;

    beforeEach(async () => {
      socketPath = getUniqueSocketPath("crud");
      stateDir = getUniqueStateDir("crud");
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

    test("should perform get, set, and destroy operations backed by State Hub", async () => {
      const store = new Bs9SessionStore({ state });

      // 1. Initial get should return null
      const nonExistent = await store.get("sess_non_existent");
      expect(nonExistent).toBeNull();

      // 2. Set session with cookie maxAge
      const sessData = {
        cookie: {
          originalMaxAge: 3600000,
          maxAge: 3600000,
          expires: new Date(Date.now() + 3600000).toISOString(),
          httpOnly: true,
          path: "/",
        },
        user: { id: "user_42", role: "admin" },
      };

      await store.set("sess_1", sessData);

      // 3. Verify get returns session
      const fetched = await store.get("sess_1");
      expect(fetched).toEqual(sessData);

      // 4. Verify session is persisted directly into HubServer engine
      const inHub = server.engine.get(namespace, "sess:sess_1");
      expect(inHub).toEqual(sessData);

      // 5. Destroy session
      await store.destroy("sess_1");
      const afterDestroy = await store.get("sess_1");
      expect(afterDestroy).toBeNull();
      expect(server.engine.get(namespace, "sess:sess_1")).toBeNull();
    });

    test("should support callback-style for get, set, destroy, and touch", async () => {
      const store = new Bs9SessionStore({ state });

      const sessData = {
        cookie: { maxAge: 5000 },
        theme: "dark",
      };

      // Set via callback
      await new Promise<void>((resolve, reject) => {
        store.set("cb_sess", sessData, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Get via callback
      const retrieved = await new Promise<any>((resolve, reject) => {
        store.get("cb_sess", (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      expect(retrieved).toEqual(sessData);

      // Touch via callback
      await new Promise<void>((resolve, reject) => {
        store.touch(
          "cb_sess",
          { cookie: { maxAge: 10000 }, theme: "dark" },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Destroy via callback
      await new Promise<void>((resolve, reject) => {
        store.destroy("cb_sess", (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const finalCheck = await store.get("cb_sess");
      expect(finalCheck).toBeNull();
    });

    test("should track all(), length(), and clear() across sessions", async () => {
      const store = new Bs9SessionStore({ state, prefix: "s:" });

      expect(await store.length()).toBe(0);
      expect(await store.all()).toEqual({});

      await store.set("s1", { cookie: { maxAge: 10000 }, user: "A" });
      await store.set("s2", { cookie: { maxAge: 10000 }, user: "B" });
      await store.set("s3", { cookie: { maxAge: 10000 }, user: "C" });

      expect(await store.length()).toBe(3);
      const allSess = await store.all();
      expect(Object.keys(allSess).sort()).toEqual(["s1", "s2", "s3"]);
      expect(allSess.s1.user).toBe("A");
      expect(allSess.s2.user).toBe("B");
      expect(allSess.s3.user).toBe("C");

      // Destroy s2
      await store.destroy("s2");
      expect(await store.length()).toBe(2);
      const afterDel = await store.all();
      expect(Object.keys(afterDel).sort()).toEqual(["s1", "s3"]);

      // Clear all
      await store.clear();
      expect(await store.length()).toBe(0);
      expect(await store.all()).toEqual({});
    });

    test("should handle automatic TTL serialization matching cookie maxAge", async () => {
      const store = new Bs9SessionStore({ state });

      // Keep enough headroom for slower shared CI runners while still
      // exercising automatic expiration from cookie.maxAge.
      await store.set("quick_expire", {
        cookie: { maxAge: 500 },
        status: "ephemeral",
      });

      const alive = await store.get("quick_expire");
      expect(alive).not.toBeNull();
      expect(alive.status).toBe("ephemeral");

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 600));

      const expired = await store.get("quick_expire");
      expect(expired).toBeNull();
    });

    test("should work with a direct HubClient instance passed in options", async () => {
      const client = new HubClient({
        socketPath,
        namespace,
        authToken: token,
      });
      await client.connect();

      const store = new Bs9SessionStore({ client });

      await store.set("hub_client_sess", {
        cookie: { maxAge: 10000 },
        flag: "direct-hub-client",
      });

      const res = await store.get("hub_client_sess");
      expect(res.flag).toBe("direct-hub-client");

      await store.destroy("hub_client_sess");
      expect(await store.get("hub_client_sess")).toBeNull();

      await client.disconnect();
    });
  });

  describe("3. Auto-Patching session() in BS9 Environment", () => {
    let server: HubServer;
    let socketPath: string;
    let stateDir: string;
    let tokenFile: string;
    const namespace = "autopatch-cluster";
    let token: string;

    beforeEach(async () => {
      socketPath = getUniqueSocketPath("patch");
      stateDir = getUniqueStateDir("patch");
      server = new HubServer({ socketPath, stateDir });
      const reg = server.registerNamespaceToken(namespace);
      token = reg.token;
      mkdirSync(stateDir, { recursive: true });
      tokenFile = join(stateDir, "auth.token");
      writeFileSync(tokenFile, token, "utf-8");
      await server.start();

      // Configure BS9 environment variables
      process.env.BS9_HUB_SOCKET = socketPath;
      process.env.BS9_CLUSTER = "true";
      process.env.BS9_CLUSTER_NAME = namespace;
      process.env.BS9_AUTH_TOKEN_FILE = tokenFile;
      await resetRuntime();
    });

    afterEach(async () => {
      unpatchExpressSession();
      await resetRuntime();
      await server.stop();
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test("should detect BS9 cluster as active", () => {
      expect(isBs9ClusterActive()).toBe(true);
    });

    test("auto-patches session() when options.store is omitted in BS9 environment", async () => {
      initExpressSessionAdapter();
      const session = require("express-session");

      // User creates express-session middleware without specifying a store
      const sessionMiddleware = session({
        secret: "zero-code-secret",
        resave: false,
        saveUninitialized: true,
      });

      // Simulate an incoming Express request
      const req: any = {
        headers: {},
        url: "/",
        connection: {},
      };
      const res: any = {
        end: () => {},
        setHeader: () => {},
        getHeader: () => undefined,
      };

      await new Promise<void>((resolve) => {
        sessionMiddleware(req, res, () => {
          resolve();
        });
      });

      // Verify req.sessionStore is an instance of Bs9SessionStore
      expect(req.sessionStore).toBeInstanceOf(Bs9SessionStore);

      // Verify session can be saved and retrieved through BS9 State Hub
      req.session.testUser = "antigravity";
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Direct inspection: session should be in State Hub
      const storedSess = await req.sessionStore.get(req.sessionID);
      expect(storedSess).not.toBeNull();
      expect(storedSess.testUser).toBe("antigravity");

      // Verify it was stored in the HubServer KvEngine
      const hubEngineData = server.engine.get(namespace, `sess:${req.sessionID}`);
      expect(hubEngineData).not.toBeNull();
      expect(hubEngineData.testUser).toBe("antigravity");
    });

    test("preserves user-specified custom store when options.store is provided", async () => {
      initExpressSessionAdapter();

      // Custom store provided by user
      const customStore = new session.MemoryStore();

      const sessionMiddleware = session({
        secret: "custom-store-secret",
        store: customStore,
        resave: false,
        saveUninitialized: true,
      });

      const req: any = {
        headers: {},
        url: "/",
        connection: {},
      };
      const res: any = {
        end: () => {},
        setHeader: () => {},
        getHeader: () => undefined,
      };

      await new Promise<void>((resolve) => {
        sessionMiddleware(req, res, () => {
          resolve();
        });
      });

      expect(req.sessionStore).toBe(customStore);
      expect(req.sessionStore).not.toBeInstanceOf(Bs9SessionStore);
    });
  });

  describe("4. Standalone Mode Outside BS9 (Fallback to MemoryStore)", () => {
    beforeEach(() => {
      delete process.env.BS9_CLUSTER;
      delete process.env.BS9_CLUSTER_NAME;
      delete process.env.BS9_HUB_SOCKET;
      delete process.env.BS9_AUTH_TOKEN;
      delete process.env.BS9_AUTH_TOKEN_FILE;
      delete process.env.BS9_ALLOW_DEGRADED_LOCAL;
    });

    test("should detect environment is outside BS9", () => {
      expect(isBs9ClusterActive()).toBe(false);
    });

    test("session() outside BS9 falls back to default MemoryStore and does not crash", async () => {
      // Even if adapter is initialized or patched, outside BS9 it must not intercept
      initExpressSessionAdapter();

      const sessionMiddleware = session({
        secret: "standalone-secret",
        resave: false,
        saveUninitialized: true,
      });

      const req: any = {
        headers: {},
        url: "/",
        connection: {},
      };
      const res: any = {
        end: () => {},
        setHeader: () => {},
        getHeader: () => undefined,
      };

      await new Promise<void>((resolve) => {
        sessionMiddleware(req, res, () => {
          resolve();
        });
      });

      // Outside BS9, express-session should use default MemoryStore
      expect(req.sessionStore).toBeInstanceOf(session.MemoryStore);
      expect(req.sessionStore).not.toBeInstanceOf(Bs9SessionStore);

      // Session operations work in-memory
      req.session.count = 1;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const sess = await new Promise<any>((resolve) => {
        req.sessionStore.get(req.sessionID, (_: any, s: any) => resolve(s));
      });
      expect(sess.count).toBe(1);
    });

    test("Bs9SessionStore used directly outside BS9 operates in-memory without throwing", async () => {
      const store = new Bs9SessionStore({ state });

      await store.set("in_mem_sid", {
        cookie: { maxAge: 10000 },
        inMemory: true,
      });

      const fetched = await store.get("in_mem_sid");
      expect(fetched.inMemory).toBe(true);

      expect(await store.length()).toBe(1);

      await store.destroy("in_mem_sid");
      expect(await store.get("in_mem_sid")).toBeNull();
      expect(await store.length()).toBe(0);
    });
  });
});
