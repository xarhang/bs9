/**
 * BS9 - Runtime State Client
 *
 * Implements:
 * - get<T>(key: string): Promise<T | null>
 * - set<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<void>
 * - delete(key: string): Promise<boolean>
 * - incr(key: string, delta?: number): Promise<number>
 * - cas<T>(key: string, expectedValue: T, newValue: T, options?: { ttlMs?: number }): Promise<{ success: boolean; currentValue: T }>
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getDefaultRuntimeBackend, RuntimeBackend } from "./backend.js";

export class State {
  private customBackend?: RuntimeBackend;

  constructor(backend?: RuntimeBackend) {
    this.customBackend = backend;
  }

  private get backend(): RuntimeBackend {
    return this.customBackend || getDefaultRuntimeBackend();
  }

  public async get<T = any>(key: string): Promise<T | null> {
    const adapter = await this.backend.getAdapter();
    return adapter.get<T>(key);
  }

  public async set<T = any>(key: string, value: T, options?: { ttlMs?: number }): Promise<void> {
    const adapter = await this.backend.getAdapter();
    await adapter.set(key, value, options?.ttlMs);
  }

  public async delete(key: string): Promise<boolean> {
    const adapter = await this.backend.getAdapter();
    return adapter.delete(key);
  }

  public async incr(key: string, delta: number = 1): Promise<number> {
    const adapter = await this.backend.getAdapter();
    return adapter.incr(key, delta);
  }

  public async cas<T = any>(
    key: string,
    expectedValue: T,
    newValue: T,
    options?: { ttlMs?: number }
  ): Promise<{ success: boolean; currentValue: T }> {
    const adapter = await this.backend.getAdapter();
    return adapter.cas<T>(key, expectedValue, newValue, options?.ttlMs);
  }
}
