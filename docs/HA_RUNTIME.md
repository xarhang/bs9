---
layout: default
title: High Availability
description: Runtime architecture, shared state, and zero-downtime operations.
permalink: /high-availability/
---

# High-Availability Runtime Guide

This guide defines the supported high-availability behavior of BS9 1.6.7. It distinguishes automatic, zero-code process availability from application state that must use an explicit shared-state mechanism.

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
```

`Queue.pop` reserves and acknowledges the returned message through the current high-level client. Use lower-level Hub queue operations when application-controlled acknowledgement is required.

Inside a BS9 cluster, the runtime fails loudly if the State Hub cannot be reached. `BS9_ALLOW_DEGRADED_LOCAL=true` opts into process-local fallback and can produce divergent state; do not enable it for correctness-critical production state.

The supported `express-session` adapter can provide zero-code session persistence when no custom store is configured. Custom stores and other state libraries remain the application's responsibility.

## Reload safety

For each logical slot, BS9 performs these steps:

1. Acquire and continuously renew the cluster operation lock.
2. Start generation `N+1` while generation `N` remains available.
3. Wait for an authenticated `READY` signal after the replacement binds its port.
4. Ask generation `N` to drain active requests.
5. Stop generation `N` only after readiness and drain checks succeed.
6. Persist the new desired topology.

The command revalidates the lock at every destructive boundary. If ownership is lost, the operation aborts before further workers are changed. Readiness failure also leaves the old generation serving.

## Scope and limitations

- The bundled State Hub coordinates processes on one host through a Unix domain socket or Windows named pipe.
- BS9 does not transparently replicate arbitrary heap variables.
- The bundled State Hub is not a multi-node consensus database. Multi-host deployments must place durable shared state in an external system designed for that topology.
- A successful `verify-ha` run proves the tested workload and scenario, not every possible downstream dependency failure.
- Singleton work must use a renewable lease and fencing token; assigning cron permanently to worker `0` is not crash-safe.

## Operational commands

```bash
bs9 daemon status
bs9 status
bs9 inspect-ha src/app.ts --json
bs9 verify-ha src/app.ts --json
bs9 reload app
bs9 scale app 4
```

See [CLI Commands](COMMANDS.md), [API Reference](API.md), [Architecture](../ARCHITECTURE.md), and [Production Guide](../PRODUCTION.md) for related details.

## License

BS9 is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [LICENSE](../LICENSE).
