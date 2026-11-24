---
layout: default
title: High Availability
description: Runtime architecture, shared state, and zero-downtime operations.
permalink: /high-availability/
---

# High-Availability Runtime Guide

This guide defines the supported high-availability behavior of BS9 1.8.0. It distinguishes automatic, zero-code process availability from application state that must use an explicit shared-state mechanism.

## Availability model

```text
Client traffic
      |
      +--> worker slot 0, generation N --+
      +--> worker slot 1, generation N --+--> shared port (SO_REUSEPORT)
      +--> worker slot 2, generation N --+
                                             |
                         controller + reconciler + same-host State Hub
```

`bs9 start app.ts -i max` creates one logical slot per selected CPU. Each physical worker is identified as `<app>-<slot>-g<generation>`. The operating system balances connections across workers sharing the port.

The controller is outside the HTTP data path. Existing workers continue serving if the controller restarts. The reconciler restores missing logical slots with a strictly higher physical generation.

## What works without application changes

Supported stateless Bun HTTP applications receive:

- `reusePort` injection for supported `Bun.serve` entry points;
- PM2-compatible `NODE_APP_INSTANCE`, starting at `0`;
- automatic restart and missing-slot reconciliation;
- replace-first rolling reload;
- readiness authentication before an old generation is drained;
- graceful request draining with a bounded timeout; and
- fail-closed topology operations protected by renewable cluster locks.

Run the following checks before claiming zero-downtime behavior for an application:

```bash
bs9 inspect-ha src/app.ts
bs9 verify-ha src/app.ts
```

`verify-ha` uses an isolated cluster by default. Use `--live` only when intentionally testing a running service.

## Stateful applications

Independent operating-system processes do not share arbitrary JavaScript heap variables. Module-level `Map`, `Set`, cache, queue, shopping-cart, login-session, or cron state is therefore not automatically replicated.

Use the typed runtime when state must survive a worker crash or reload:

```ts
import { State, Lease, Queue } from "bs9/runtime";

const state = new State();
await state.set("cart:user-123", { items: ["book"] }, { ttlMs: 3_600_000 });

const lease = new Lease();
const leader = await lease.acquire("daily-report", { ttlMs: 60_000 });
if (leader.acquired) {
  try {
    // Pass leader.fencingToken to protected downstream writes when possible.
    await generateDailyReport(leader.fencingToken!);
  } finally {
    await leader.release();
  }
}

const queue = new Queue();
await queue.push("email", { userId: "user-123" });
const job = await queue.pop("email", { timeoutMs: 5_000 });
// Drop-in cluster-safe Map & Set (backed by State Hub with CAS)
import { SharedMap, SharedSet, Bs9WebSessionStore, Bs9RateLimiter } from "bs9/runtime";

const carts = new SharedMap<{ items: string[] }>("carts", { ttlMs: 3_600_000 });
await carts.set("user-123", { items: ["book"] });

const online = new SharedSet<string>("online-users");
await online.add("user-123");

// Cluster-safe web sessions & rate limiting for Bun.serve / Hono / Elysia
const webSessions = new Bs9WebSessionStore();
const rateLimiter = new Bs9RateLimiter({ limit: 100, windowMs: 60_000 });
```

`Queue.pop` reserves and acknowledges the returned message through the current high-level client. Use lower-level Hub queue operations when application-controlled acknowledgement is required.

Inside a BS9 cluster, the runtime fails loudly if the State Hub cannot be reached. `BS9_ALLOW_DEGRADED_LOCAL=true` opts into process-local fallback and can produce divergent state; do not enable it for correctness-critical production state.

The supported `express-session` adapter can provide zero-code session persistence when no custom store is configured. For `Bun.serve`, Hono, Elysia, and standard Web `Request`/`Response` apps, use `Bs9WebSessionStore` and `Bs9RateLimiter`. Custom stores and other state libraries remain the application's responsibility.

## Reload safety

For each logical slot, BS9 performs these steps:

1. Acquire and continuously renew the cluster operation lock.
2. Start generation `N+1` while generation `N` remains available.
3. Wait for an authenticated `READY` signal after the replacement binds its port.
4. Ask generation `N` to drain active requests.
5. Stop generation `N` only after readiness and drain checks succeed.
6. Persist the new desired topology.

The command revalidates the lock at every destructive boundary. If ownership is lost, the operation aborts before further workers are changed. Readiness failure also leaves the old generation serving.

## Multi-Host State Hub (Opt-in)

By default, BS9 operates in **zero-config single-host mode** (workers communicate with the local State Hub over a Unix domain socket or Windows named pipe).

For 3–5 node clusters that need shared state (`State`, `SharedMap`, `SharedSet`, `Lease`, `Queue`) across hosts without external Redis/Postgres dependencies, BS9 includes an opt-in **Raft-lite replication engine over TLS**:

- **Zero application code changes**: Workers continue talking to their local Hub over UDS/Named Pipe. Follower Hubs transparently forward mutations (`set`, `incr`, `cas`, `lease`, `queue`) to the elected leader and wait for a majority quorum acknowledgement before replying.
- **Built-in TLS + mutual HMAC**: `bs9 hub init` generates a shared 256-bit cluster secret and automatic self-signed ECDSA TLS certificates (or use custom certs).
- **Term-based fencing tokens**: Lease fencing tokens encode `(term, counter)` so tokens remain strictly monotonic across leader failovers.
- **Automatic snapshot catch-up**: Lagging or restarted followers catch up via log streaming (`REPL_APPEND`) or full namespace snapshot transfer (`REPL_SNAPSHOT_CHUNK`).

> **Important**: Automatic failover requires **at least 3 nodes** (majority quorum = 2) to prevent split-brain under network partitions.

```bash
# 1. On Node 1: initialize cluster secret
bs9 hub init --node-id node-1

# 2. On Node 2 & Node 3: initialize with the same secret printed by Node 1
bs9 hub init --node-id node-2 --secret <CLUSTER_SECRET>
bs9 hub init --node-id node-3 --secret <CLUSTER_SECRET>

# 3. Start daemon on each host with peer addresses
BS9_HUB_LISTEN=0.0.0.0:7409 BS9_HUB_PEERS=10.0.0.2:7409,10.0.0.3:7409 bs9 daemon start

# 4. Inspect replication status, role, term, and commit index
bs9 hub status
bs9 hub peers
```

## Scope and limitations

- By default, the bundled State Hub coordinates processes on one host through a Unix domain socket or Windows named pipe. Multi-host replication is strictly opt-in (`BS9_HUB_PEERS` / `BS9_HUB_LISTEN`) and designed for small clusters (3–5 nodes).
- BS9 does not transparently replicate arbitrary heap variables.
- In multi-host mode, mutations wait for majority quorum over the network (typically +1–5 ms LAN RTT), while `KV_GET` defaults to fast local reads on followers.
- A successful `verify-ha` run proves the tested workload and scenario, not every possible downstream dependency failure.
- Singleton work must use a renewable lease and fencing token; assigning cron permanently to worker `0` is not crash-safe.

## Operational commands

```bash
bs9 daemon status
bs9 hub init
bs9 hub status
bs9 status
bs9 inspect-ha src/app.ts --json
bs9 verify-ha src/app.ts --json
bs9 reload app
bs9 scale app 4
```

See [CLI Commands](COMMANDS.md), [API Reference](API.md), [Architecture](../ARCHITECTURE.md), and [Production Guide](../PRODUCTION.md) for related details.

## License

BS9 is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [LICENSE](../LICENSE).
