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
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("Multi-Host Hub Replication (3-Node Raft-lite Cluster)", () => {
  const dirs: string[] = [];
  const servers: HubServer[] = [];
  const clients: HubClient[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "bs9-repl-test-"));
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

  async function startThreeNodeCluster(maxReplEntriesInMemory?: number) {
    // Allocate 3 distinct ports in the 31000+ range
    const basePort = 31000 + (portOffset++ * 10);
    const addrs = [
      `127.0.0.1:${basePort}`,
      `127.0.0.1:${basePort + 1}`,
      `127.0.0.1:${basePort + 2}`,
    ];
    const nodeIds = ["node-1", "node-2", "node-3"];

    const nodes: { server: HubServer; client: HubClient; dir: string; addr: string; nodeId: string }[] = [];

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
          electionTimeoutMinMs: 120 + i * 40,
          electionTimeoutMaxMs: 220 + i * 40,
          heartbeatIntervalMs: 35,
          maxReplEntriesInMemory,
        },
      });
      servers.push(server);
      await server.start();

      const client = new HubClient({
        socketPath,
        namespace: "app-prod",
      });
      clients.push(client);
      await client.connect();

      nodes.push({ server, client, dir, addr: addrs[i], nodeId: nodeIds[i] });
    }

    await waitFor(() => {
      const leaders = nodes.filter((n) => n.server.cluster?.isLeader());
      return (
        leaders.length === 1 &&
        nodes.every((n) => n.server.cluster?.transport.getConnectedPeers().length === 2)
      );
    }, 5000);

    return nodes;
  }

  test("replicates KV set/get/incr/cas/delete across all 3 nodes and forwards writes from followers", async () => {
    const nodes = await startThreeNodeCluster();
    const leader = nodes.find((n) => n.server.cluster?.isLeader())!;
    const followers = nodes.filter((n) => !n.server.cluster?.isLeader());
    expect(followers).toHaveLength(2);

    // 1. Write via leader's UDS client
    await leader.client.set("greeting", { hello: "world" });

    // Wait for followers to apply committed log entry
    await waitFor(async () => {
      const v1 = await followers[0].client.get("greeting");
      const v2 = await followers[1].client.get("greeting");
      return v1?.hello === "world" && v2?.hello === "world";
    });

    // 2. Write via follower[0] UDS client (transparently forwarded to leader & replicated)
    await followers[0].client.set("from-follower", 42);
    const valOnLeader = await leader.client.get("from-follower");
    expect(valOnLeader).toBe(42);

    await waitFor(async () => (await followers[1].client.get("from-follower")) === 42);

    // 3. Atomic INCR across all 3 nodes
    await leader.client.incr("hits", 1);
    await followers[0].client.incr("hits", 2);
    const totalHits = await followers[1].client.incr("hits", 3);
    expect(totalHits).toBe(6);

    // 4. CAS via follower
    const casOk = await followers[1].client.cas("hits", 6, 100);
    expect(casOk.success).toBe(true);
    const casFail = await followers[0].client.cas("hits", 6, 200);
    expect(casFail.success).toBe(false);
    expect(casFail.currentValue).toBe(100);
  });

  test("replicates leases and queues across nodes via UDS clients", async () => {
    const nodes = await startThreeNodeCluster();
    const [n1, n2, n3] = nodes;

    // Acquire lease on n1
    const lease1 = await n1.client.leaseAcquire("cron-job", 10000, "worker-1");
    expect(lease1.acquired).toBe(true);
    expect(lease1.fencingToken).toBeGreaterThan(0);

    // Second acquire on n2 for same lease must fail while held by worker-1
    const lease2 = await n2.client.leaseAcquire("cron-job", 10000, "worker-2");
    expect(lease2.acquired).toBe(false);
    expect(lease2.currentOwner).toBe("worker-1");

    // Release from n3 using fencingToken, then acquire on n2 succeeds with strictly higher fencingToken
    const rel = await n3.client.leaseRelease("cron-job", lease1.fencingToken!);
    expect(rel.released).toBe(true);

    const lease3 = await n2.client.leaseAcquire("cron-job", 10000, "worker-2");
    expect(lease3.acquired).toBe(true);
    expect(lease3.fencingToken!).toBeGreaterThan(lease1.fencingToken!);

    // Queue publish on n1 (follower or leader), reserve & ack on n2
    const pub = await n1.client.queuePublish("jobs", { task: "email" });
    expect(pub.messageId).toBeDefined();

    const reserved = await n2.client.queueReserve("jobs", 5000, 1);
    expect(reserved.messages).toHaveLength(1);
    expect(reserved.messages[0].payload).toEqual({ task: "email" });

    const acked = await n3.client.queueAck("jobs", reserved.messages[0].id);
    expect(acked.acked).toBe(true);
  });

  test("catches up a lagging follower via snapshot transfer when log entries were compacted", async () => {
    // Keep only 5 entries in memory so compaction triggers quickly
    const nodes = await startThreeNodeCluster(5);
    const leader = nodes.find((n) => n.server.cluster?.isLeader())!;
    const lagging = nodes.find((n) => !n.server.cluster?.isLeader())!;

    // Stop lagging follower while leader and remaining follower continue committing > 10 entries
    await lagging.client.disconnect().catch(() => {});
    await lagging.server.stop();

    for (let i = 1; i <= 15; i++) {
      await leader.client.set(`key-${i}`, `val-${i}`);
    }

    // Restart lagging follower on same address and stateDir
    const restarted = new HubServer({
      socketPath: join(lagging.dir, "hub.sock"),
      stateDir: lagging.dir,
      allowAnonymous: true,
      cluster: {
        nodeId: lagging.nodeId,
        listen: lagging.addr,
        clusterSecret: SECRET,
        peers: nodes.filter((n) => n.nodeId !== lagging.nodeId).map((n) => n.addr),
        stateDir: lagging.dir,
        electionTimeoutMinMs: 250,
        electionTimeoutMaxMs: 400,
        heartbeatIntervalMs: 35,
        maxReplEntriesInMemory: 5,
      },
    });
    servers.push(restarted);
    await restarted.start();

    const reClient = new HubClient({
      socketPath: join(lagging.dir, "hub.sock"),
      namespace: "app-prod",
    });
    clients.push(reClient);
    await reClient.connect();

    await waitFor(async () => {
      const v1 = await reClient.get("key-1");
      const v15 = await reClient.get("key-15");
      return v1 === "val-1" && v15 === "val-15";
    }, 5000);
  });
});
