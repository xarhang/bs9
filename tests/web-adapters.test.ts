/**
 * BS9 - Web & Framework Adapters Unit Tests
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  Bs9WebSessionStore,
  Bs9RateLimiter,
  parseSessionCookie,
  formatSessionCookie,
  resetRuntime,
} from "../src/runtime/index.js";

describe("Web & Framework Adapters (`bs9/runtime`)", () => {
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

  test("Bs9WebSessionStore supports createSessionId, set, get, touch, destroy", async () => {
    const sessions = new Bs9WebSessionStore<{ userId: string; role: string }>();
    const sid = sessions.createSessionId();
    expect(typeof sid).toBe("string");
    expect(sid.length).toBeGreaterThan(10);

    expect(await sessions.get(sid)).toBeNull();
    expect(await sessions.touch(sid)).toBe(false);

    await sessions.set(sid, { userId: "u1", role: "admin" });
    expect(await sessions.get(sid)).toEqual({ userId: "u1", role: "admin" });
    expect(await sessions.touch(sid, 60_000)).toBe(true);

    expect(await sessions.destroy(sid)).toBe(true);
    expect(await sessions.get(sid)).toBeNull();
  });

  test("Bs9RateLimiter enforces limit and tracks remaining count", async () => {
    const limiter = new Bs9RateLimiter({ limit: 3, windowMs: 10_000 });

    const r1 = await limiter.consume("ip:1.2.3.4");
    expect(r1.allowed).toBe(true);
    expect(r1.count).toBe(1);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.consume("ip:1.2.3.4");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.consume("ip:1.2.3.4");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await limiter.consume("ip:1.2.3.4");
    expect(r4.allowed).toBe(false);
    expect(r4.count).toBe(4);
    expect(r4.remaining).toBe(0);
  });

  test("parseSessionCookie and formatSessionCookie round-trip cleanly", () => {
    const header = formatSessionCookie("abc-123", {
      cookieName: "sid",
      maxAgeSec: 3600,
      secure: true,
      sameSite: "Strict",
    });
    expect(header).toContain("sid=abc-123");
    expect(header).toContain("Max-Age=3600");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");

    const parsed = parseSessionCookie("theme=dark; sid=abc-123; foo=bar", "sid");
    expect(parsed).toBe("abc-123");
    expect(parseSessionCookie("theme=dark", "sid")).toBeNull();
  });
});
