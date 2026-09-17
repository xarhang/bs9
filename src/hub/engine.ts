/**
 * BS9 - High-Performance In-Memory KV Engine
 *
 * Implements:
 * - Namespaced In-Memory Key-Value store.
 * - Operations: get, set, delete, incr (atomic), cas (compare-and-swap).
 * - TTL support with lazy eviction on access + active periodic sweep timer.
 * - Memory tracking with per-value (1 MB) and per-namespace (100 MB) limits.
 * - Strict security: rejects executable/serialized functions and prototype pollution.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { MAX_VALUE_SIZE, MAX_NAMESPACE_MEMORY } from "./protocol.js";

export interface KvEntry {
  value: any;
  expiresAt?: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface CasResult {
  success: boolean;
  currentValue: any;
}

export interface KvEngineOptions {
  maxValueSize?: number;
  maxNamespaceMemory?: number;
  evictionIntervalMs?: number;
}

const ENTRY_OVERHEAD_BYTES = 64;

export function estimateValueSize(val: any): number {
  if (typeof val === "string") {
    return Buffer.byteLength(val, "utf-8");
  }
  if (typeof val === "number") {
    return 8;
  }
  if (typeof val === "boolean") {
    return 4;
  }
  if (val === null || val === undefined) {
    return 0;
  }
  if (Buffer.isBuffer(val)) {
    return val.length;
  }
  if (typeof val === "object") {
    return Buffer.byteLength(JSON.stringify(val), "utf-8");
  }
  return 0;
}

export function validateSafeData(value: any, depth = 0): void {
  if (depth > 100) {
    throw new Error("Value nesting depth exceeds maximum limit of 100");
  }
  if (typeof value === "function") {
    throw new Error("Security violation: functions are not permitted in state hub");
  }
  if (typeof value === "symbol") {
    throw new Error("Security violation: symbols are not permitted in state hub");
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        validateSafeData(item, depth + 1);
      }
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        throw new Error("Security violation: serialized classes or custom prototypes are forbidden");
      }
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error("Security violation: prototype pollution key detected");
        }
        validateSafeData(value[key], depth + 1);
      }
    }
  }
}

export function isDeepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export class KvEngine {
  private stores: Map<string, Map<string, KvEntry>> = new Map();
  private memoryUsage: Map<string, number> = new Map();
  private maxValueSize: number;
  private maxNamespaceMemory: number;
  private evictionTimer: any = null;

  constructor(options: KvEngineOptions = {}) {
    this.maxValueSize = options.maxValueSize ?? MAX_VALUE_SIZE;
    this.maxNamespaceMemory = options.maxNamespaceMemory ?? MAX_NAMESPACE_MEMORY;

    const interval = options.evictionIntervalMs ?? 1000;
    if (interval > 0) {
      this.evictionTimer = setInterval(() => {
        this.evictExpiredKeys();
      }, interval);
      if (typeof this.evictionTimer.unref === "function") {
        this.evictionTimer.unref();
      }
    }
  }

  private getStore(namespace: string): Map<string, KvEntry> {
    let store = this.stores.get(namespace);
    if (!store) {
      store = new Map();
      this.stores.set(namespace, store);
      this.memoryUsage.set(namespace, 0);
    }
    return store;
  }

  public getNamespaceMemory(namespace: string): number {
    return this.memoryUsage.get(namespace) || 0;
  }

  /**
   * Retrieves value for namespace:key.
   * Lazily evicts expired keys.
   */
  public get(namespace: string, key: string): any | null {
    const store = this.stores.get(namespace);
    if (!store) return null;

    const entry = store.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      this.delete(namespace, key);
      return null;
    }

    return entry.value;
  }

  /**
   * Sets value for namespace:key with optional TTL in milliseconds.
   */
  public set(namespace: string, key: string, value: any, ttlMs?: number): boolean {
    validateSafeData(value);

    const valSize = estimateValueSize(value);
    if (valSize > this.maxValueSize) {
      throw new Error(`Value size ${valSize} exceeds maximum limit of ${this.maxValueSize} bytes`);
    }

    const keySize = Buffer.byteLength(key, "utf-8");
    const entrySize = keySize + valSize + ENTRY_OVERHEAD_BYTES;

    const store = this.getStore(namespace);
    const existing = store.get(key);
    const oldSize = existing ? existing.sizeBytes : 0;
    const currentMem = this.getNamespaceMemory(namespace);
    const newMem = currentMem - oldSize + entrySize;

    if (newMem > this.maxNamespaceMemory) {
      throw new Error(
        `Namespace memory limit exceeded: requested ${newMem} bytes, max allowed is ${this.maxNamespaceMemory} bytes`
      );
    }

    const now = Date.now();
    const expiresAt = typeof ttlMs === "number" && ttlMs > 0 ? now + ttlMs : undefined;

    const entry: KvEntry = {
      value,
      expiresAt,
      sizeBytes: entrySize,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    store.set(key, entry);
    this.memoryUsage.set(namespace, newMem);
    return true;
  }

  /**
   * Deletes a key from the namespace.
   */
  public delete(namespace: string, key: string): boolean {
    const store = this.stores.get(namespace);
    if (!store) return false;

    const existing = store.get(key);
    if (!existing) return false;

    store.delete(key);
    const currentMem = this.getNamespaceMemory(namespace);
    this.memoryUsage.set(namespace, Math.max(0, currentMem - existing.sizeBytes));

    // If expired at time of deletion, report false as it wasn't effectively active
    if (existing.expiresAt && Date.now() >= existing.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Atomically increments numeric value of key by delta.
   * If key does not exist or is expired, initializes to delta.
   */
  public incr(namespace: string, key: string, delta: number = 1): number {
    const current = this.get(namespace, key);
    let newValue: number;

    if (current === null || current === undefined) {
      newValue = delta;
    } else if (typeof current === "number") {
      newValue = current + delta;
    } else {
      throw new Error(`Cannot increment key "${key}": existing value is not a numeric value`);
    }

    const store = this.getStore(namespace);
    const existing = store.get(key);
    const ttlMs = existing?.expiresAt ? Math.max(1, existing.expiresAt - Date.now()) : undefined;

    this.set(namespace, key, newValue, ttlMs);
    return newValue;
  }

  /**
   * Compare-And-Swap (CAS) optimistic locking.
   * Updates key to newValue only if currentValue equals expectedValue.
   */
  public cas(
    namespace: string,
    key: string,
    expectedValue: any,
    newValue: any,
    ttlMs?: number
  ): CasResult {
    validateSafeData(expectedValue);
    validateSafeData(newValue);

    const currentValue = this.get(namespace, key);

    if (isDeepEqual(currentValue, expectedValue)) {
      this.set(namespace, key, newValue, ttlMs);
      return { success: true, currentValue: newValue };
    }

    return { success: false, currentValue };
  }

  /**
   * Periodic eviction of expired entries across all namespaces.
   */
  public evictExpiredKeys(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [namespace, store] of this.stores.entries()) {
      let freedBytes = 0;
      for (const [key, entry] of store.entries()) {
        if (entry.expiresAt && now >= entry.expiresAt) {
          store.delete(key);
          freedBytes += entry.sizeBytes;
          evicted++;
        }
      }
      if (freedBytes > 0) {
        const currentMem = this.getNamespaceMemory(namespace);
        this.memoryUsage.set(namespace, Math.max(0, currentMem - freedBytes));
      }
    }

    return evicted;
  }

  /**
   * Exports unexpired state for snapshot generation.
   */
  public exportState(namespace: string): Record<string, KvEntry> {
    const store = this.stores.get(namespace);
    if (!store) return {};

    const now = Date.now();
    const result: Record<string, KvEntry> = {};

    for (const [key, entry] of store.entries()) {
      if (!entry.expiresAt || now < entry.expiresAt) {
        result[key] = { ...entry };
      }
    }

    return result;
  }

  /**
   * Imports snapshot entries into in-memory store.
   */
  public importState(namespace: string, entries: Record<string, KvEntry>): void {
    const store = this.getStore(namespace);
    store.clear();
    let totalMem = 0;
    const now = Date.now();

    for (const [key, entry] of Object.entries(entries)) {
      if (!entry.expiresAt || now < entry.expiresAt) {
        const valSize = estimateValueSize(entry.value);
        const keySize = Buffer.byteLength(key, "utf-8");
        const entrySize = keySize + valSize + ENTRY_OVERHEAD_BYTES;
        entry.sizeBytes = entrySize;

        store.set(key, entry);
        totalMem += entrySize;
      }
    }

    this.memoryUsage.set(namespace, totalMem);
  }

  /**
   * Stops eviction timers and cleans up resources.
   */
  public close(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
}
