/**
 * BS9 - Cluster-Safe Web & Bun Framework Adapters (`bs9/runtime`)
 *
 * Provides zero-dependency, cluster-safe building blocks for Bun.serve, Hono,
 * Elysia, and standard Web Request/Response handlers backed by the BS9 State Hub:
 * - Bs9WebSessionStore: Session persistence across workers (get, set, destroy, touch)
 * - Bs9RateLimiter: Atomic cluster-wide rate limiting using State.incr()
 * - Cookie helpers: parseSessionCookie, formatSessionCookie
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { State } from "../state.js";
import type { RuntimeBackend } from "../backend.js";

export interface WebSessionStoreOptions {
  /** Key prefix in State Hub (default: "bs9:websess:") */
  prefix?: string;
  /** Default session TTL in ms (default: 86_400_000 = 24h) */
  ttlMs?: number;
  /** Optional custom RuntimeBackend */
  backend?: RuntimeBackend;
}

export class Bs9WebSessionStore<T = Record<string, any>> {
  private readonly state: State;
  private readonly prefix: string;
  private readonly defaultTtlMs: number;

  constructor(options: WebSessionStoreOptions = {}) {
    this.state = new State(options.backend);
    this.prefix = options.prefix ?? "bs9:websess:";
    this.defaultTtlMs = options.ttlMs ?? 86_400_000;
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  public createSessionId(): string {
    return crypto.randomUUID();
  }

  public async get(sessionId: string): Promise<T | null> {
    if (!sessionId) return null;
    return this.state.get<T>(this.key(sessionId));
  }

  public async set(sessionId: string, data: T, ttlMs?: number): Promise<void> {
    await this.state.set(this.key(sessionId), data, {
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
  }

  public async touch(sessionId: string, ttlMs?: number): Promise<boolean> {
    const existing = await this.get(sessionId);
    if (existing === null) return false;
    await this.set(sessionId, existing, ttlMs);
    return true;
  }

  public async destroy(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    return this.state.delete(this.key(sessionId));
  }
}

export interface RateLimiterOptions {
  /** Maximum requests allowed per window (default: 100) */
  limit?: number;
  /** Window duration in milliseconds (default: 60_000 = 1m) */
  windowMs?: number;
  /** Key prefix in State Hub (default: "bs9:ratelimit:") */
  prefix?: string;
  /** Optional custom RuntimeBackend */
  backend?: RuntimeBackend;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  limit: number;
  resetAtMs: number;
}

export class Bs9RateLimiter {
  private readonly state: State;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly prefix: string;

  constructor(options: RateLimiterOptions = {}) {
    this.state = new State(options.backend);
    this.limit = options.limit ?? 100;
    this.windowMs = options.windowMs ?? 60_000;
    this.prefix = options.prefix ?? "bs9:ratelimit:";
  }

  public async consume(identifier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const resetAtMs = (bucket + 1) * this.windowMs;
    const key = `${this.prefix}${identifier}:${bucket}`;

    const count = await this.state.incr(key, 1);
    if (count === 1) {
      // Set expiration on first hit of the window bucket
      await this.state.set(key, count, { ttlMs: Math.max(1000, resetAtMs - now + 1000) });
    }

    return {
      allowed: count <= this.limit,
      count,
      remaining: Math.max(0, this.limit - count),
      limit: this.limit,
      resetAtMs,
    };
  }
}

export function parseSessionCookie(
  cookieHeader: string | null | undefined,
  cookieName: string = "bs9_sid"
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    if (name === cookieName) {
      const val = part.slice(eqIdx + 1).trim();
      return val ? decodeURIComponent(val) : null;
    }
  }
  return null;
}

export function formatSessionCookie(
  sessionId: string,
  options: {
    cookieName?: string;
    maxAgeSec?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  } = {}
): string {
  const name = options.cookieName ?? "bs9_sid";
  const parts = [`${name}=${encodeURIComponent(sessionId)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${options.maxAgeSec}`);
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}
