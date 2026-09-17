/**
 * BS9 - Distributed Lease Manager with Strictly Monotonic Fencing Tokens
 *
 * Implements:
 * - Distributed mutual exclusion locks per namespace.
 * - Monotonically increasing fencing tokens (incremented on every acquire)
 *   to prevent split-brain & zombie leaders.
 * - TTL expiration, renew, and release operations.
 * - State export and import for Snapshot and WAL replay.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface LeaseRecord {
  namespace: string;
  leaseName: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  fencingToken: number;
  expiresAt?: number;
  currentOwner?: string;
}

export interface LeaseRenewResult {
  renewed: boolean;
  fencingToken?: number;
  expiresAt?: number;
  error?: string;
}

export interface LeaseReleaseResult {
  released: boolean;
}

export interface LeaseSnapshotState {
  record: LeaseRecord | null;
  lastFencingToken: number;
}

export class LeaseManager {
  private leases: Map<string, LeaseRecord> = new Map();
  private fencingTokens: Map<string, number> = new Map();

  private getKey(namespace: string, leaseName: string): string {
    return `${namespace}:${leaseName}`;
  }

  /**
   * Attempts to acquire lease for namespace:leaseName.
   * If free or expired, increments strictly monotonic fencingToken,
   * sets expiresAt = Date.now() + ttlMs, records ownerId,
   * and returns { acquired: true, fencingToken, expiresAt }.
   * If busy and not expired, returns { acquired: false, currentOwner, expiresAt, fencingToken }.
   */
  public acquire(
    namespace: string,
    leaseName: string,
    ttlMs: number,
    ownerId: string
  ): LeaseAcquireResult {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);
    const now = Date.now();

    // If busy and unexpired
    if (existing && now < existing.expiresAt) {
      return {
        acquired: false,
        currentOwner: existing.ownerId,
        expiresAt: existing.expiresAt,
        fencingToken: existing.fencingToken,
      };
    }

    // Free or expired -> increment strictly monotonic fencing token
    const currentToken = this.fencingTokens.get(key) || 0;
    const nextToken = currentToken + 1;
    this.fencingTokens.set(key, nextToken);

    const expiresAt = now + ttlMs;
    const record: LeaseRecord = {
      namespace,
      leaseName,
      ownerId,
      fencingToken: nextToken,
      expiresAt,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.leases.set(key, record);

    return {
      acquired: true,
      fencingToken: nextToken,
      expiresAt,
      currentOwner: ownerId,
    };
  }

  /**
   * Renews an active lease.
   * Validates fencingToken matches current lease and hasn't expired.
   * If valid, extends expiresAt = Date.now() + ttlMs.
   */
  public renew(
    namespace: string,
    leaseName: string,
    fencingToken: number,
    ttlMs: number
  ): LeaseRenewResult {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);
    const now = Date.now();

    if (!existing) {
      return { renewed: false, error: "Lease not found" };
    }

    if (existing.fencingToken !== fencingToken) {
      return { renewed: false, error: "Fencing token mismatch" };
    }

    if (now >= existing.expiresAt) {
      return { renewed: false, error: "Lease has expired" };
    }

    existing.expiresAt = now + ttlMs;
    existing.updatedAt = now;

    return {
      renewed: true,
      expiresAt: existing.expiresAt,
      fencingToken,
    };
  }

  /**
   * Releases an active lease.
   * Validates fencingToken matches; if so, clears the lease.
   * Fencing token counter remains preserved for strict monotonicity.
   */
  public release(
    namespace: string,
    leaseName: string,
    fencingToken: number
  ): LeaseReleaseResult {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);

    if (!existing) {
      return { released: false };
    }

    if (existing.fencingToken !== fencingToken) {
      return { released: false };
    }

    this.leases.delete(key);
    return { released: true };
  }

  /**
   * Retrieves active unexpired lease record, or null.
   */
  public get(namespace: string, leaseName: string): LeaseRecord | null {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);
    if (!existing) return null;

    if (Date.now() >= existing.expiresAt) {
      this.leases.delete(key);
      return null;
    }

    return { ...existing };
  }

  /**
   * Returns current fencing token for namespace:leaseName.
   */
  public getCurrentFencingToken(namespace: string, leaseName: string): number {
    const key = this.getKey(namespace, leaseName);
    return this.fencingTokens.get(key) || 0;
  }

  // --- WAL Replay Methods ---

  public applyAcquire(
    namespace: string,
    leaseName: string,
    ownerId: string,
    fencingToken: number,
    expiresAt: number,
    createdAt?: number
  ): void {
    const key = this.getKey(namespace, leaseName);
    const now = Date.now();
    const record: LeaseRecord = {
      namespace,
      leaseName,
      ownerId,
      fencingToken,
      expiresAt,
      createdAt: createdAt ?? now,
      updatedAt: now,
    };
    this.leases.set(key, record);
    const currentToken = this.fencingTokens.get(key) || 0;
    if (fencingToken > currentToken) {
      this.fencingTokens.set(key, fencingToken);
    }
  }

  public applyRenew(
    namespace: string,
    leaseName: string,
    fencingToken: number,
    expiresAt: number
  ): void {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);
    if (existing && existing.fencingToken === fencingToken) {
      existing.expiresAt = expiresAt;
      existing.updatedAt = Date.now();
    }
  }

  public applyRelease(
    namespace: string,
    leaseName: string,
    fencingToken: number
  ): void {
    const key = this.getKey(namespace, leaseName);
    const existing = this.leases.get(key);
    if (existing && existing.fencingToken === fencingToken) {
      this.leases.delete(key);
    }
  }

  // --- Snapshot Export / Import ---

  public exportState(namespace: string): Record<string, LeaseSnapshotState> {
    const prefix = `${namespace}:`;
    const result: Record<string, LeaseSnapshotState> = {};
    const now = Date.now();

    for (const [key, lastFencingToken] of this.fencingTokens.entries()) {
      if (key.startsWith(prefix)) {
        const leaseName = key.slice(prefix.length);
        const record = this.leases.get(key);
        const activeRecord = record && now < record.expiresAt ? { ...record } : null;
        result[leaseName] = {
          record: activeRecord,
          lastFencingToken,
        };
      }
    }

    return result;
  }

  public importState(
    namespace: string,
    data: Record<string, LeaseSnapshotState>
  ): void {
    const now = Date.now();
    for (const [leaseName, state] of Object.entries(data)) {
      const key = this.getKey(namespace, leaseName);
      if (state.lastFencingToken > (this.fencingTokens.get(key) || 0)) {
        this.fencingTokens.set(key, state.lastFencingToken);
      }
      if (state.record && now < state.record.expiresAt) {
        this.leases.set(key, { ...state.record });
      } else {
        this.leases.delete(key);
      }
    }
  }

  public close(): void {
    this.leases.clear();
    this.fencingTokens.clear();
  }
}
