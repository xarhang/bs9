/**
 * BS9 - Zero-Code Compatibility Adapter for express-session
 *
 * Implements:
 * - Bs9SessionStore: express-session Store backed by BS9 State Hub KV (`HubClient` or `State`).
 * - Automatic TTL serialization matching cookie `maxAge` or default session TTL.
 * - Standard Store operations: get, set, destroy, touch, all, length, clear.
 * - Zero-code auto-patching of express-session factory when running inside BS9.
 * - Safe non-interfering behavior when running outside BS9.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";
import { State } from "../state.js";
import { HubClient } from "../../hub/client.js";
import { isBs9Environment } from "../config.js";
import { checkPackageCompatibility } from "./registry.js";

const defaultState = new State();

// Base class for Session Store (inherits from EventEmitter)
const ExpressSessionStoreBase: any = EventEmitter;

export interface Bs9SessionStoreOptions {
  client?: HubClient | State;
  state?: State;
  prefix?: string;
  ttlMs?: number;
  ttl?: number; // seconds or ms
  indexKey?: string;
}

interface KvBackend {
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean | void>;
  delete(key: string): Promise<boolean>;
  cas<T = any>(
    key: string,
    expected: T,
    next: T,
    ttlMs?: number
  ): Promise<{ success: boolean; currentValue: T }>;
}

function createKvBackend(options: Bs9SessionStoreOptions): KvBackend {
  const target = options.client || options.state || defaultState;

  if (target instanceof HubClient) {
    return {
      get: (k) => target.get(k),
      set: (k, v, ttl) => target.set(k, v, ttl),
      delete: (k) => target.delete(k),
      cas: (k, exp, nxt, ttl) => target.cas(k, exp, nxt, ttl),
    };
  }

  // target is State or defaultState
  return {
    get: (k) => target.get(k),
    set: (k, v, ttl) => target.set(k, v, { ttlMs: ttl }),
    delete: (k) => target.delete(k),
    cas: (k, exp, nxt, ttl) => target.cas(k, exp, nxt, { ttlMs: ttl }),
  };
}

function computeSessionTtlMs(session: any, fallbackTtlMs: number): number {
  if (session && session.cookie) {
    if (typeof session.cookie.maxAge === "number" && session.cookie.maxAge > 0) {
      return Math.max(1, Math.ceil(session.cookie.maxAge));
    }
    if (session.cookie.expires) {
      const exp = new Date(session.cookie.expires).getTime();
      if (!isNaN(exp)) {
        const diff = exp - Date.now();
        return Math.max(1, Math.ceil(diff));
      }
    }
  }
  return Math.max(1, fallbackTtlMs);
}

/**
 * Checks if running inside a BS9 cluster environment.
 * Checks BS9_CLUSTER_NAME / BS9_AUTH_TOKEN_FILE / BS9_CLUSTER / BS9_HUB_SOCKET.
 */
export function isBs9ClusterActive(): boolean {
  const clusterName = process.env.BS9_CLUSTER_NAME;
  if (clusterName && clusterName.trim().length > 0) return true;

  const authTokenFile = process.env.BS9_AUTH_TOKEN_FILE;
  if (authTokenFile && authTokenFile.trim().length > 0) return true;

  const isCluster = process.env.BS9_CLUSTER;
  if (isCluster && isCluster !== "false" && isCluster !== "0") return true;

  const hubSocket = process.env.BS9_HUB_SOCKET;
  if (hubSocket && hubSocket.trim().length > 0) return true;

  return isBs9Environment();
}

/**
 * Bs9SessionStore
 * Express-session compatible store backed by BS9 State Hub KV.
 */
export class Bs9SessionStore extends ExpressSessionStoreBase {
  private kv: KvBackend;
  public prefix: string;
  public defaultTtlMs: number;
  public indexKey: string;

  constructor(options: Bs9SessionStoreOptions = {}) {
    super();
    this.kv = createKvBackend(options);
    this.prefix = options.prefix ?? "sess:";
    this.defaultTtlMs = options.ttlMs ?? (options.ttl ? options.ttl * 1000 : 86400000); // 24 hours
    this.indexKey = options.indexKey ?? `__bs9_session_index__:${this.prefix}`;
  }

  private async updateIndex(sid: string, expiresAt: number): Promise<void> {
    const now = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const curIndex = (await this.kv.get<Record<string, number>>(this.indexKey)) || {};
      const nextIndex: Record<string, number> = {};
      for (const [s, exp] of Object.entries(curIndex)) {
        if (exp > now && s !== sid) {
          nextIndex[s] = exp;
        }
      }
      nextIndex[sid] = expiresAt;
      const res = await this.kv.cas(this.indexKey, curIndex, nextIndex);
      if (res.success) return;
    }
    const cur = (await this.kv.get<Record<string, number>>(this.indexKey)) || {};
    cur[sid] = expiresAt;
    await this.kv.set(this.indexKey, cur);
  }

  private async removeFromIndex(sid: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const curIndex = await this.kv.get<Record<string, number>>(this.indexKey);
      if (!curIndex || !(sid in curIndex)) return;
      const nextIndex = { ...curIndex };
      delete nextIndex[sid];
      const res = await this.kv.cas(this.indexKey, curIndex, nextIndex);
      if (res.success) return;
    }
    const cur = await this.kv.get<Record<string, number>>(this.indexKey);
    if (cur && sid in cur) {
      delete cur[sid];
      await this.kv.set(this.indexKey, cur);
    }
  }

  /**
   * Fetch session by the given session ID.
   */
  public get(sid: string, callback?: (err?: any, session?: any) => void): Promise<any> {
    const promise = (async () => {
      const sess = await this.kv.get(this.prefix + sid);
      if (!sess) {
        return null;
      }

      // Check cookie expiration
      if (sess.cookie && sess.cookie.expires) {
        const exp = new Date(sess.cookie.expires).getTime();
        if (!isNaN(exp) && exp <= Date.now()) {
          await this.destroy(sid);
          return null;
        }
      }

      return sess;
    })();

    if (typeof callback === "function") {
      promise
        .then((result) => queueMicrotask(() => callback(null, result)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Commit the given session associated with sessionId to the store.
   */
  public set(sid: string, session: any, callback?: (err?: any) => void): Promise<void> {
    const promise = (async () => {
      const ttlMs = computeSessionTtlMs(session, this.defaultTtlMs);
      const expiresAt = Date.now() + ttlMs;

      await this.kv.set(this.prefix + sid, session, ttlMs);
      await this.updateIndex(sid, expiresAt);
    })();

    if (typeof callback === "function") {
      promise
        .then(() => queueMicrotask(() => callback(null)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Destroy the session associated with sessionId.
   */
  public destroy(sid: string, callback?: (err?: any) => void): Promise<void> {
    const promise = (async () => {
      await this.kv.delete(this.prefix + sid);
      await this.removeFromIndex(sid);
    })();

    if (typeof callback === "function") {
      promise
        .then(() => queueMicrotask(() => callback(null)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Touch the given session object associated with the given sessionId.
   * Refreshes expiration / TTL.
   */
  public touch(sid: string, session: any, callback?: (err?: any) => void): Promise<void> {
    const promise = (async () => {
      const current = await this.kv.get(this.prefix + sid);
      if (!current) return;

      if (session && session.cookie) {
        current.cookie = session.cookie;
      }

      const ttlMs = computeSessionTtlMs(current, this.defaultTtlMs);
      const expiresAt = Date.now() + ttlMs;

      await this.kv.set(this.prefix + sid, current, ttlMs);
      await this.updateIndex(sid, expiresAt);
    })();

    if (typeof callback === "function") {
      promise
        .then(() => queueMicrotask(() => callback(null)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Get all active sessions.
   */
  public all(
    callback?: (err?: any, sessions?: Record<string, any>) => void
  ): Promise<Record<string, any>> {
    const promise = (async () => {
      const index = (await this.kv.get<Record<string, number>>(this.indexKey)) || {};
      const now = Date.now();
      const sessions: Record<string, any> = {};

      for (const [sid, exp] of Object.entries(index)) {
        if (exp > now) {
          const sess = await this.kv.get(this.prefix + sid);
          if (sess) {
            sessions[sid] = sess;
          }
        }
      }

      return sessions;
    })();

    if (typeof callback === "function") {
      promise
        .then((result) => queueMicrotask(() => callback(null, result)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Get number of active sessions.
   */
  public length(callback?: (err?: any, len?: number) => void): Promise<number> {
    const promise = this.all().then((sessions) => Object.keys(sessions).length);

    if (typeof callback === "function") {
      promise
        .then((len) => queueMicrotask(() => callback(null, len)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Clear all sessions.
   */
  public clear(callback?: (err?: any) => void): Promise<void> {
    const promise = (async () => {
      const index = (await this.kv.get<Record<string, number>>(this.indexKey)) || {};
      for (const sid of Object.keys(index)) {
        await this.kv.delete(this.prefix + sid);
      }
      await this.kv.delete(this.indexKey);
    })();

    if (typeof callback === "function") {
      promise
        .then(() => queueMicrotask(() => callback(null)))
        .catch((err) => queueMicrotask(() => callback(err)));
    }

    return promise;
  }

  /**
   * Re-generate session (Store.prototype.regenerate compatibility).
   */
  public regenerate(req: any, fn: (err?: any) => void): void {
    const self = this;
    this.destroy(req.sessionID, (err) => {
      if (typeof req.sessionStore?.generate === "function") {
        req.sessionStore.generate(req);
      }
      fn?.(err);
    });
  }

  /**
   * Load session (Store.prototype.load compatibility).
   */
  public load(sid: string, fn: (err?: any, sess?: any) => void): void {
    const self = this;
    this.get(sid, (err, sess) => {
      if (err) return fn?.(err);
      if (!sess) return fn?.();
      fn?.(null, self.createSession(reqWithSid(sid, self), sess));
    });
  }

  /**
   * Create session from raw session data (Store.prototype.createSession compatibility).
   */
  public createSession(req: any, sess: any): any {
    let Cookie: any;
    let Session: any;
    try {
      Cookie = require("express-session/session/cookie");
      Session = require("express-session/session/session");
    } catch {}

    const expires = sess.cookie?.expires;
    const orig = sess.cookie?.originalMaxAge;

    if (Cookie) {
      sess.cookie = new Cookie(sess.cookie);
    }

    if (typeof expires === "string") {
      sess.cookie.expires = new Date(expires);
    }

    if (orig !== undefined && sess.cookie) {
      sess.cookie.originalMaxAge = orig;
    }

    if (Session) {
      req.session = new Session(req, sess);
      return req.session;
    }
    req.session = sess;
    return req.session;
  }
}

function reqWithSid(sid: string, store: any): any {
  return { sessionID: sid, sessionStore: store };
}

// Module interception & patch state
let originalExpressSessionFn: any = null;
let originalMemoryStore: any = null;

export function createBs9MemoryStoreProxy(origMemStore: any): any {
  if (!origMemStore || (origMemStore as any).__bs9_patched) {
    return origMemStore;
  }

  function Bs9MemoryStoreProxy(this: any, ...args: any[]) {
    if (isBs9ClusterActive()) {
      return new Bs9SessionStore();
    }
    return new origMemStore(...args);
  }

  Object.setPrototypeOf(Bs9MemoryStoreProxy.prototype, origMemStore.prototype);
  Object.assign(Bs9MemoryStoreProxy, origMemStore);
  (Bs9MemoryStoreProxy as any).__bs9_patched = true;
  (Bs9MemoryStoreProxy as any).__bs9_original = origMemStore;

  return Bs9MemoryStoreProxy;
}

function hookMemoryStoreModule(): void {
  try {
    const memPath = require.resolve("express-session/session/memory");
    if (!originalMemoryStore) {
      if (require.cache[memPath]) {
        originalMemoryStore = require.cache[memPath].exports;
      } else {
        originalMemoryStore = require(memPath);
      }
    }

    if (originalMemoryStore && !originalMemoryStore.__bs9_patched) {
      const proxy = createBs9MemoryStoreProxy(originalMemoryStore);
      if (require.cache[memPath]) {
        require.cache[memPath].exports = proxy;
      }
    }
  } catch {}
}

/**
 * Intercepts express-session factory function.
 * If running inside BS9 and options.store is omitted, defaults to Bs9SessionStore automatically.
 * When running outside BS9, returns normal express-session behavior.
 */
export function patchExpressSession(sessionModule?: any): any {
  let mod = sessionModule;
  if (!mod) {
    try {
      mod = require("express-session");
    } catch {
      return null;
    }
  }

  if (typeof mod !== "function") {
    return mod;
  }

  // Hook memory store module as well for defense-in-depth
  hookMemoryStoreModule();

  if (mod.__bs9_patched) {
    return mod;
  }

  // Verify compatibility with registry matrix
  const compat = checkPackageCompatibility("express-session");
  if (!compat.supported) {
    return mod;
  }

  originalExpressSessionFn = mod;

  function bs9SessionInterceptor(options?: any) {
    const opts = options ? { ...options } : {};
    // Auto-inject BS9 State Hub Store only if running inside BS9 and no store is provided
    if (!opts.store && isBs9ClusterActive()) {
      opts.store = new Bs9SessionStore();
    }
    return originalExpressSessionFn(opts);
  }

  // Preserve all prototype and static properties (Store, Cookie, Session, MemoryStore)
  Object.setPrototypeOf(bs9SessionInterceptor, Object.getPrototypeOf(mod));
  for (const prop of Object.getOwnPropertyNames(mod)) {
    if (prop === "prototype" || prop === "name" || prop === "length") continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(mod, prop);
      if (desc) {
        Object.defineProperty(bs9SessionInterceptor, prop, desc);
      }
    } catch {}
  }

  bs9SessionInterceptor.__bs9_patched = true;
  bs9SessionInterceptor.__bs9_original = mod;
  bs9SessionInterceptor.Bs9SessionStore = Bs9SessionStore;

  // Update require.cache if express-session is loaded
  try {
    const resolved = require.resolve("express-session");
    if (require.cache[resolved]) {
      require.cache[resolved].exports = bs9SessionInterceptor;
    }
  } catch {}

  return bs9SessionInterceptor;
}

/**
 * Restores original unpatched express-session function (primarily for test teardown).
 */
export function unpatchExpressSession(): void {
  try {
    const resolved = require.resolve("express-session");
    if (require.cache[resolved] && originalExpressSessionFn) {
      require.cache[resolved].exports = originalExpressSessionFn;
    }
  } catch {}

  try {
    const memPath = require.resolve("express-session/session/memory");
    if (require.cache[memPath] && originalMemoryStore) {
      require.cache[memPath].exports = originalMemoryStore;
    }
  } catch {}
}

/**
 * Initializes express-session auto-patching hook.
 * Pre-patches require.cache and hooks Module.prototype.require if running inside BS9.
 */
export function initExpressSessionAdapter(): void {
  if (!isBs9ClusterActive()) return;

  try {
    const Module = require("node:module");
    if (Module && Module.prototype && !Module.prototype.__bs9_session_hooked) {
      const origRequire = Module.prototype.require;
      Module.prototype.require = function (id: string, ...args: any[]) {
        const res = origRequire.apply(this, [id, ...args]);
        if (!isBs9ClusterActive()) return res;

        if (id === "express-session" || id.endsWith("/express-session") || id.endsWith("\\express-session")) {
          return patchExpressSession(res);
        }

        if (
          id === "./session/memory" ||
          id === "express-session/session/memory" ||
          id.endsWith("/session/memory") ||
          id.endsWith("\\session\\memory") ||
          id.endsWith("/session/memory.js") ||
          id.endsWith("\\session\\memory.js")
        ) {
          return createBs9MemoryStoreProxy(res);
        }

        return res;
      };
      Module.prototype.__bs9_session_hooked = true;
    }
  } catch {}

  hookMemoryStoreModule();

  try {
    const resolved = require.resolve("express-session");
    if (require.cache[resolved]) {
      patchExpressSession(require.cache[resolved].exports);
    }
  } catch {}
}
