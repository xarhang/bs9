/**
 * BS9 - Startup Readiness Gate (--wait-ready)
 *
 * Polls a newly started service's HTTP health endpoint on loopback until it
 * responds with a non-5xx status or throws if `timeoutMs` elapses.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface ReadinessOptions {
  host?: string;
  port: number;
  path?: string;
  protocol?: "http" | "https";
  timeoutMs?: number;
  intervalMs?: number;
}

export async function waitForServiceReady(options: ReadinessOptions): Promise<{ ready: boolean; elapsedMs: number; status?: number }> {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid readiness port: ${options.port}`);
  }

  const rawHost = options.host || "127.0.0.1";
  const probeHost = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  const path = options.path?.startsWith("/") ? options.path : `/${options.path || "healthz"}`;
  const protocol = options.protocol === "https" ? "https" : "http";
  const timeoutMs = Math.max(200, options.timeoutMs ?? 15000);
  const intervalMs = Math.max(50, options.intervalMs ?? 150);

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const targetUrl = `${protocol}://${probeHost}:${port}${path}`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(1500, timeoutMs)),
      });
      if (res.status < 500) {
        await res.body?.cancel();
        return { ready: true, elapsedMs: Date.now() - startedAt, status: res.status };
      }
      await res.body?.cancel();
    } catch {
      // Service still booting
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Service failed readiness check at ${targetUrl} within ${timeoutMs}ms`);
}
