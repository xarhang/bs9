/**
 * BS9 - Bun Native Cluster Preload & Lifecycle Hook
 *
 * Capabilities:
 * - Automatically injects `reusePort: true` into `Bun.serve(...)`.
 * - Tracks active in-flight HTTP requests.
 * - Emits LIFECYCLE_READY only after `server.port` binds.
 * - Coordinates two-phase graceful draining (stops accepting new connections, drains in-flight requests).
 * - Non-destructive signal coordinator: invokes application cleanup hooks, sets bounded drain timeout.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { LifecycleClient } from "../cluster/lifecycle-client.js";
import { initExpressSessionAdapter } from "../runtime/adapters/express-session.js";

// Active server references and in-flight tracking
let activeServer: any = null;
let inFlightRequests = 0;
let lifecycleClient: LifecycleClient | null = null;

const drainTimeoutMs = parseInt(process.env.BS9_DRAIN_TIMEOUT_MS || "10000", 10);

/**
 * Perform server drain: stop accepting new connections and await active requests.
 */
async function performDrain(timeoutMs: number): Promise<{ inFlightRemaining: number }> {
  if (activeServer && typeof activeServer.stop === "function") {
    try {
      // server.stop(false) closes listener without violently dropping active connections
      activeServer.stop(false);
    } catch {}
  }

  const startTime = Date.now();
  while (inFlightRequests > 0 && Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }

  return { inFlightRemaining: inFlightRequests };
}

// 1. Initialize lifecycle client if running under BS9 cluster
if (process.env.BS9_CLUSTER === "true") {
  try {
    lifecycleClient = new LifecycleClient({
      clusterName: process.env.BS9_CLUSTER_NAME,
      slot: parseInt(process.env.NODE_APP_INSTANCE || process.env.BS9_CLUSTER_ID || "0", 10),
      generation: parseInt(process.env.BS9_CLUSTER_GENERATION || "1", 10),
      authTokenFile: process.env.BS9_AUTH_TOKEN_FILE,
      autoConnect: true,
    });

    lifecycleClient.onDrain(async (timeout) => {
      return await performDrain(timeout || drainTimeoutMs);
    });
  } catch (err) {
    // Controller client error should never crash user application
  }
}

// 2. Patch Bun.serve if Bun runtime is present
if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
  const originalServe = Bun.serve.bind(Bun);

  // @ts-ignore
  Bun.serve = function (options: any) {
    if (options && typeof options === "object") {
      // Enforce reusePort in cluster mode
      if (process.env.BS9_REUSE_PORT === "true" && options.reusePort === undefined) {
        options.reusePort = true;
      }

      // Override or set port from environment if requested
      if ((options.port === undefined || process.env.BS9_OVERRIDE_PORT === "true") && process.env.PORT) {
        options.port = parseInt(process.env.PORT, 10);
      }

      // Wrap fetch handler to track in-flight requests
      const originalFetch = options.fetch;
      if (typeof originalFetch === "function") {
        options.fetch = function (...args: any[]) {
          // performDrain closes the listener. Requests already accepted by the
          // kernel must still complete normally; returning 503 here creates a
          // visible outage during an otherwise replace-first rolling reload.
          inFlightRequests++;
          try {
            const result = originalFetch.apply(this, args);
            if (result && typeof result.then === "function") {
              return result.finally(() => {
                inFlightRequests--;
              });
            }
            inFlightRequests--;
            return result;
          } catch (err) {
            inFlightRequests--;
            throw err;
          }
        };
      }
    }

    const server = originalServe(options);
    activeServer = server;

    // Report READY to controller once server binds successfully
    if (lifecycleClient && server && server.port) {
      lifecycleClient.reportReady(server.port, { framework: "bun.serve" }).catch(() => {});
      lifecycleClient.startHeartbeat();
    }

    return server;
  };
}

// 3. Two-phase graceful draining is coordinated via IPC (DRAIN_REQUEST -> DRAINED).
// Preload intentionally does NOT attach a SIGTERM listener that suppresses termination
// or invokes process.exit, allowing user application lifecycle cleanup hooks to run normally.

// 4. Zero-Code Compatibility Adapters (express-session)
if (process.env.BS9_CLUSTER === "true" || process.env.BS9_CLUSTER_NAME || process.env.BS9_AUTH_TOKEN_FILE) {
  try {
    initExpressSessionAdapter();
  } catch {}
}
