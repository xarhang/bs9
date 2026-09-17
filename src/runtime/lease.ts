/**
 * BS9 - Runtime Lease Client (Distributed Lock & Single Execution Coordinator)
 *
 * Implements:
 * - Distributed leases backed by BS9 State Hub in cluster mode or in-memory fallback.
 * - Monotonically increasing fencing tokens (fencingToken: number).
 * - acquire(name, options): returns { acquired, fencingToken, token, expiresAt, currentOwner, release, renew }
 * - renew(name, fencingToken, ttlMs): extends lease expiration
 * - release(name, fencingToken): clears lease with fencing token validation
 * - runOnce(name, fn, options): executes single task under distributed lease
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { State } from "./state.js";
import { getDefaultRuntimeBackend, RuntimeBackend } from "./backend.js";

export interface LeaseAcquireResult {
  acquired: boolean;
  fencingToken?: number;
  token?: string;
  expiresAt?: number;
  currentOwner?: string;
  release: () => Promise<void>;
  renew?: (ttlMs?: number) => Promise<boolean>;
}

export class Lease {
  private customBackend?: RuntimeBackend;

  constructor(stateOrBackend?: State | RuntimeBackend) {
    if (stateOrBackend instanceof RuntimeBackend) {
      this.customBackend = stateOrBackend;
    }
  }

  private get backend(): RuntimeBackend {
    return this.customBackend || getDefaultRuntimeBackend();
  }

  public async acquire(
    name: string,
    options?: { ttlMs?: number; ownerId?: string }
  ): Promise<LeaseAcquireResult> {
    const ownerId = options?.ownerId || randomUUID();
    const ttlMs = options?.ttlMs ?? 60000;

    await this.backend.ensureConnected();
    const client = this.backend.getHubClient();
    const namespace = this.backend.getConfig().namespace || "default";

    if (client) {
      const res = await client.leaseAcquire(name, ttlMs, ownerId);
      if (res.acquired) {
        let released = false;
        return {
          acquired: true,
          fencingToken: res.fencingToken,
          token: String(res.fencingToken),
          expiresAt: res.expiresAt,
          currentOwner: ownerId,
          release: async () => {
            if (released) return;
            released = true;
            await client.leaseRelease(name, res.fencingToken);
          },
          renew: async (extendTtlMs?: number) => {
            const r = await client.leaseRenew(name, res.fencingToken, extendTtlMs ?? ttlMs);
            return r.renewed;
          },
        };
      } else {
        return {
          acquired: false,
          fencingToken: res.fencingToken,
          token: undefined,
          expiresAt: res.expiresAt,
          currentOwner: res.currentOwner,
          release: async () => {},
          renew: async () => false,
        };
      }
    }

    // In-memory mode (standalone or degraded fallback)
    const mgr = this.backend.getInMemoryLeases();
    const engine = this.backend.getInMemoryEngine();
    const res = mgr.acquire(namespace, name, ttlMs, ownerId);

    if (res.acquired) {
      let released = false;
      engine.set(namespace, `__bs9_lease:${name}`, String(res.fencingToken), ttlMs);
      return {
        acquired: true,
        fencingToken: res.fencingToken,
        token: String(res.fencingToken),
        expiresAt: res.expiresAt,
        currentOwner: ownerId,
        release: async () => {
          if (released) return;
          released = true;
          mgr.release(namespace, name, res.fencingToken);
          engine.delete(namespace, `__bs9_lease:${name}`);
        },
        renew: async (extendTtlMs?: number) => {
          const r = mgr.renew(namespace, name, res.fencingToken, extendTtlMs ?? ttlMs);
          if (r.renewed) {
            engine.set(namespace, `__bs9_lease:${name}`, String(res.fencingToken), extendTtlMs ?? ttlMs);
          }
          return r.renewed;
        },
      };
    } else {
      return {
        acquired: false,
        fencingToken: res.fencingToken,
        token: undefined,
        expiresAt: res.expiresAt,
        currentOwner: res.currentOwner,
        release: async () => {},
        renew: async () => false,
      };
    }
  }

  public async renew(
    name: string,
    fencingToken: number,
    ttlMs: number = 60000
  ): Promise<boolean> {
    await this.backend.ensureConnected();
    const client = this.backend.getHubClient();
    const namespace = this.backend.getConfig().namespace || "default";

    if (client) {
      const res = await client.leaseRenew(name, fencingToken, ttlMs);
      return res.renewed;
    }

    const mgr = this.backend.getInMemoryLeases();
    const res = mgr.renew(namespace, name, fencingToken, ttlMs);
    if (res.renewed) {
      this.backend.getInMemoryEngine().set(namespace, `__bs9_lease:${name}`, String(fencingToken), ttlMs);
    }
    return res.renewed;
  }

  public async release(name: string, fencingToken: number): Promise<boolean> {
    await this.backend.ensureConnected();
    const client = this.backend.getHubClient();
    const namespace = this.backend.getConfig().namespace || "default";

    if (client) {
      const res = await client.leaseRelease(name, fencingToken);
      return res.released;
    }

    const mgr = this.backend.getInMemoryLeases();
    const res = mgr.release(namespace, name, fencingToken);
    if (res.released) {
      this.backend.getInMemoryEngine().delete(namespace, `__bs9_lease:${name}`);
    }
    return res.released;
  }

  public async runOnce(
    name: string,
    fn: () => Promise<any>,
    options?: { ttlMs?: number; ownerId?: string }
  ): Promise<boolean> {
    const ttlMs = options?.ttlMs ?? 60000;
    const lock = await this.acquire(name, { ttlMs, ownerId: options?.ownerId });
    if (!lock.acquired) {
      return false;
    }

    try {
      await fn();
      return true;
    } catch (err) {
      await lock.release().catch(() => {});
      throw err;
    }
  }
}
