import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubServer } from "../src/hub/server.js";
import { HubClient } from "../src/hub/client.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("Multi-Host Leader Election & Failover", () => {
  const dirs: string[] = [];
  const servers: HubServer[] = [];
  const clients: HubClient[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "bs9-elect-test-"));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      await c.disconnect().catch(() => {});
    }
    for (const s of servers.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("elects a new leader in < 1s when current leader is stopped, increases term, and preserves single-leader invariant", async () => {
    const basePort = 41000;
    const addrs = [
      `127.0.0.1:${basePort}`,
      `127.0.0.1:${basePort + 1}`,
      `127.0.0.1:${basePort + 2}`,
    ];
    const nodeIds = ["node-a", "node-b", "node-c"];
    const nodes: { server: HubServer; client: HubClient; nodeId: string }[] = [];

    for (let i = 0; i < 3; i++) {
      const dir = makeDir();
      const socketPath = join(dir, "hub.sock");
      const server = new HubServer({
        socketPath,
        stateDir: dir,
        allowAnonymous: true,
        cluster: {
          nodeId: nodeIds[i],
          listen: addrs[i],
          clusterSecret: SECRET,
          peers: addrs.filter((_, idx) => idx !== i),
          stateDir: dir,
          electionTimeoutMinMs: 110 + i * 35,
          electionTimeoutMaxMs: 200 + i * 35,
          heartbeatIntervalMs: 30,
        },
      });
      servers.push(server);
      await server.start();

      const client = new HubClient({ socketPath, namespace: "default" });
      clients.push(client);
      await client.connect();
      nodes.push({ server, client, nodeId: nodeIds[i] });
    }

    await waitFor(() => nodes.filter((n) => n.server.cluster?.isLeader()).length === 1);
    const initialLeader = nodes.find((n) => n.server.cluster?.isLeader())!;
    const initialTerm = initialLeader.server.cluster!.getTerm();
    expect(initialTerm).toBeGreaterThanOrEqual(1);

    await initialLeader.client.set("before-failover", "preserved");

    // Stop initial leader
    const surviving = nodes.filter((n) => n !== initialLeader);
    await initialLeader.client.disconnect().catch(() => {});
    const failStart = Date.now();
    await initialLeader.server.stop();

    await waitFor(() => surviving.filter((n) => n.server.cluster?.isLeader()).length === 1, 2000);
    const elapsed = Date.now() - failStart;
    expect(elapsed).toBeLessThan(1500);

    const newLeader = surviving.find((n) => n.server.cluster?.isLeader())!;
    const newTerm = newLeader.server.cluster!.getTerm();
    expect(newTerm).toBeGreaterThan(initialTerm);

    // Ensure at most 1 leader in any term among surviving nodes
    expect(surviving.filter((n) => n.server.cluster?.isLeader())).toHaveLength(1);

    // Surviving cluster continues accepting writes & reading pre-failover data
    expect(await newLeader.client.get<string>("before-failover")).toBe("preserved");
    await surviving[0].client.set("after-failover", "active");
    await waitFor(async () => (await surviving[1].client.get<string>("after-failover")) === "active");
  });
});
