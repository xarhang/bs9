/**
 * BS9 - SharedMap & SharedSet (`bs9/runtime`)
 *
 * Drop-in, cluster-safe collection wrappers backed by the BS9 State Hub:
 * - SharedMap<V>: async Map-like API (get, set, has, delete, keys, values, entries, size, clear)
 * - SharedSet<T>: async Set-like API (add, has, delete, values, size, clear)
 * - Uses Compare-And-Swap (CAS) for race-free index updates across workers.
 * - Automatically falls back to in-memory execution when running outside BS9.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { State } from "./state.js";
import type { RuntimeBackend } from "./backend.js";

export interface SharedCollectionOptions {
  /** Default TTL in milliseconds for entries (SharedMap) or the collection */
  ttlMs?: number;
  /** Optional custom RuntimeBackend */
  backend?: RuntimeBackend;
}

const MAX_CAS_RETRIES = 16;

export class SharedMap<V = any> {
  private readonly state: State;
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly defaultTtlMs?: number;

  constructor(namespace: string, options: SharedCollectionOptions = {}) {
    if (!namespace || typeof namespace !== "string") {
      throw new Error("SharedMap requires a non-empty namespace string");
    }
    this.state = new State(options.backend);
    this.prefix = `bs9:map:${namespace}:`;
    this.indexKey = `bs9:map-idx:${namespace}`;
    this.defaultTtlMs = options.ttlMs;
  }

  private itemKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private async updateIndex(mutator: (keys: string[]) => string[] | null): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const current = (await this.state.get<string[]>(this.indexKey)) ?? [];
      const next = mutator(current);
      if (next === null) return;
      const res = await this.state.cas<string[] | null>(
        this.indexKey,
        current.length === 0 && (await this.state.get(this.indexKey)) === null ? null : current,
        next
      );
      if (res.success) return;
    }
    throw new Error(`SharedMap(${this.prefix}): CAS retry limit exceeded updating index`);
  }

  public async get(key: string): Promise<V | undefined> {
    const val = await this.state.get<V>(this.itemKey(key));
    return val === null ? undefined : val;
  }

  public async has(key: string): Promise<boolean> {
    const val = await this.state.get<V>(this.itemKey(key));
    return val !== null;
  }

  public async set(key: string, value: V, options?: { ttlMs?: number }): Promise<this> {
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    await this.state.set(this.itemKey(key), value, ttlMs !== undefined ? { ttlMs } : undefined);
    await this.updateIndex((keys) => (keys.includes(key) ? null : [...keys, key]));
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    const existed = await this.state.delete(this.itemKey(key));
    if (existed) {
      await this.updateIndex((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : null));
    }
    return existed;
  }

  public async keys(): Promise<string[]> {
    const tracked = (await this.state.get<string[]>(this.indexKey)) ?? [];
    const live: string[] = [];
    const expired: string[] = [];

    for (const k of tracked) {
      const val = await this.state.get<V>(this.itemKey(k));
      if (val !== null) {
        live.push(k);
      } else {
        expired.push(k);
      }
    }

    if (expired.length > 0) {
      const expiredSet = new Set(expired);
      await this.updateIndex((keys) => keys.filter((k) => !expiredSet.has(k)));
    }
    return live;
  }

  public async values(): Promise<V[]> {
    const entries = await this.entries();
    return entries.map(([, v]) => v);
  }

  public async entries(): Promise<[string, V][]> {
    const tracked = (await this.state.get<string[]>(this.indexKey)) ?? [];
    const result: [string, V][] = [];
    const expired: string[] = [];

    for (const k of tracked) {
      const val = await this.state.get<V>(this.itemKey(k));
      if (val !== null) {
        result.push([k, val]);
      } else {
        expired.push(k);
      }
    }

    if (expired.length > 0) {
      const expiredSet = new Set(expired);
      await this.updateIndex((keys) => keys.filter((k) => !expiredSet.has(k)));
    }
    return result;
  }

  public async size(): Promise<number> {
    return (await this.keys()).length;
  }

  public async clear(): Promise<void> {
    const tracked = (await this.state.get<string[]>(this.indexKey)) ?? [];
    for (const k of tracked) {
      await this.state.delete(this.itemKey(k));
    }
    await this.state.delete(this.indexKey);
  }
}

export class SharedSet<T = string | number> {
  private readonly state: State;
  private readonly key: string;
  private readonly defaultTtlMs?: number;

  constructor(namespace: string, options: SharedCollectionOptions = {}) {
    if (!namespace || typeof namespace !== "string") {
      throw new Error("SharedSet requires a non-empty namespace string");
    }
    this.state = new State(options.backend);
    this.key = `bs9:set:${namespace}`;
    this.defaultTtlMs = options.ttlMs;
  }

  private async updateSet(mutator: (items: T[]) => { next: T[]; changed: boolean }): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const raw = await this.state.get<T[]>(this.key);
      const current = raw ?? [];
      const { next, changed } = mutator(current);
      if (!changed) return false;
      const res = await this.state.cas<T[] | null>(
        this.key,
        raw === null ? null : current,
        next,
        this.defaultTtlMs !== undefined ? { ttlMs: this.defaultTtlMs } : undefined
      );
      if (res.success) return true;
    }
    throw new Error(`SharedSet(${this.key}): CAS retry limit exceeded`);
  }

  public async add(value: T): Promise<this> {
    await this.updateSet((items) =>
      items.includes(value)
        ? { next: items, changed: false }
        : { next: [...items, value], changed: true }
    );
    return this;
  }

  public async has(value: T): Promise<boolean> {
    const items = (await this.state.get<T[]>(this.key)) ?? [];
    return items.includes(value);
  }

  public async delete(value: T): Promise<boolean> {
    return this.updateSet((items) =>
      items.includes(value)
        ? { next: items.filter((i) => i !== value), changed: true }
        : { next: items, changed: false }
    );
  }

  public async values(): Promise<T[]> {
    return (await this.state.get<T[]>(this.key)) ?? [];
  }

  public async size(): Promise<number> {
    return (await this.values()).length;
  }

  public async clear(): Promise<void> {
    await this.state.delete(this.key);
  }
}
