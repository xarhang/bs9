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

describe("Multi-Host Chaos, Partition & Consistency Tests", () => {
  const dirs: string[] = [];
  const servers: HubServer[] = [];
  const clients: HubClient[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "bs9-chaos-test-"));
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

  let portOffset = 0;

  async function startCluster(replicationTimeoutMs = 2500) {
    const basePort = 51000 + (portOffset++ * 10);
    const addrs = [
      `127.0.0.1:${basePort}`,
      `127.0.0.1:${basePort + 1}`,
      `127.0.0.1:${basePort + 2}`,
    ];
    const nodeIds = ["node-1", "node-2", "node-3"];
    const nodes: { server: HubServer; client: HubClient; nodeId: string; addr: string; dir: string }[] = [];

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
          electionTimeoutMinMs: 160 + i * 50,
          electionTimeoutMaxMs: 280 + i * 50,
          heartbeatIntervalMs: 35,
          replicationTimeoutMs,
        },
      });
      servers.push(server);
      await server.start();

      const client = new HubClient({ socketPath, namespace: "chaos" });
      clients.push(client);
      await client.connect();
      nodes.push({ server, client, nodeId: nodeIds[i], addr: addrs[i], dir });
    }

    await waitFor(
      () =>
        nodes.filter((n) => n.server.cluster?.isLeader()).length === 1 &&
        nodes.every((n) => n.server.cluster?.transport.getConnectedPeers().length === 2)
    );
    return nodes;
  }

  test("isolated minority (1 of 3 nodes) cannot commit writes when majority is down", async () => {
    const nodes = await startCluster(600);
    const leader = nodes.find((n) => n.server.cluster?.isLeader())!;
    const followers = nodes.filter((n) => n !== leader);

    // Stop both followers so leader is now an isolated minority (1/3 < quorum 2)
    for (const f of followers) {
      await f.client.disconnect().catch(() => {});
      await f.server.stop();
    }

    // Attempt to write on isolated leader must fail with QUORUM_TIMEOUT
    let failed = false;
    try {
      await leader.client.set("split-brain-key", "must-not-commit");
    } catch (err) {
      failed = true;
      expect((err as Error).message).toContain("QUORUM_TIMEOUT");
    }
    expect(failed).toBe(true);
    // And local engine on isolated leader must NOT have applied the uncommitted write
    expect(await leader.client.get("split-brain-key")).toBeNull();
  });

  test("concurrent increments across all 3 nodes never lose updates and fencing tokens monotonically increase across leader failover", async () => {
    const nodes = await startCluster();

    // 1. Acquire lease on initial leader, record fencing token, then release
    const leader1 = nodes.find((n) => n.server.cluster?.isLeader())!;
    const l1 = await leader1.client.leaseAcquire("resource-lock", 10000, "owner-1");
    expect(l1.acquired).toBe(true);
    await leader1.client.leaseRelease("resource-lock", l1.fencingToken!);

    // 2. Concurrent increments across all 3 nodes (90 total: 30 per node)
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(nodes[0].client.incr("shared-counter", 1));
      tasks.push(nodes[1].client.incr("shared-counter", 1));
      tasks.push(nodes[2].client.incr("shared-counter", 1));
    }
    await Promise.all(tasks);

    const finalOnLeader = await leader1.client.get("shared-counter");
    expect(finalOnLeader).toBe(90);

    // 3. Queue message acked before failover is not redelivered after failover
    const pub = await nodes[1].client.queuePublish("orders", { id: 101 });
    const res1 = await nodes[2].client.queueReserve("orders", 5000, 1);
    expect(res1.messages).toHaveLength(1);
    expect(res1.messages[0].id).toBe(pub.messageId);
    const ack = await nodes[0].client.queueAck("orders", pub.messageId);
    expect(ack.acked).toBe(true);

    // 4. Kill leader1 -> wait for new leader in higher term -> fencing token must be strictly larger
    const surviving = nodes.filter((n) => n !== leader1);
    await leader1.client.disconnect().catch(() => {});
    await leader1.server.stop();

    await waitFor(() => surviving.filter((n) => n.server.cluster?.isLeader()).length === 1);
    const newLeader = surviving.find((n) => n.server.cluster?.isLeader())!;

    const l2 = await newLeader.client.leaseAcquire("resource-lock", 10000, "owner-2");
    expect(l2.acquired).toBe(true);
    expect(l2.fencingToken!).toBeGreaterThan(l1.fencingToken!);

    // Counter and queue ack state preserved on new leader
    expect(await newLeader.client.get<number>("shared-counter")).toBe(90);
    const resAfter = await newLeader.client.queueReserve("orders", 5000, 1);
    expect(resAfter.messages).toHaveLength(0);
  });
});
