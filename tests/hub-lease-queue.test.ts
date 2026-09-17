import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HubServer } from "../src/hub/server.js";
import { HubClient } from "../src/hub/client.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync } from "node:fs";
import { getPlatformInfo } from "../src/platform/detect.js";

const testSocket = process.platform === "win32"
  ? `\\\\.\\pipe\\bs9-lease-queue-test-${Date.now()}`
  : join(homedir(), `.bs9-lease-queue-test-${Date.now()}.sock`);

describe("Milestone 5: Distributed Leases, Durable Queues & WAL Persistence", () => {
  let server: HubServer;
  let client: HubClient;
  const namespace = "lease-queue-test";
  const token = "secret-token-lq-555";
  const platformInfo = getPlatformInfo();
  const testStateDir = join(platformInfo.stateDir, "hub-data", namespace);

  beforeAll(async () => {
    if (existsSync(testStateDir)) {
      try { rmSync(testStateDir, { recursive: true, force: true }); } catch {}
    }

    server = new HubServer({
      socketPath: testSocket,
      stateDir: testStateDir,
      allowAnonymous: false,
    });
    server.registerNamespaceToken(namespace, token);
    await server.start();

    client = new HubClient({
      socketPath: testSocket,
      namespace,
      authToken: token,
    });
    const connected = await client.connect();
    expect(connected).toBe(true);
  });

  afterAll(async () => {
    await client.disconnect();
    await server.stop();
    if (existsSync(testStateDir)) {
      try { rmSync(testStateDir, { recursive: true, force: true }); } catch {}
    }
  });

  describe("1. Distributed Leases with Strictly Monotonic Fencing Tokens", () => {
    test("should acquire free lease with initial fencing token 1", async () => {
      const res = await client.leaseAcquire("task-cron", 5000, "worker-1");
      expect(res.acquired).toBe(true);
      expect(res.fencingToken).toBe(1);
      expect(res.expiresAt).toBeGreaterThan(Date.now());
      expect(res.currentOwner).toBe("worker-1");
    });

    test("should reject second worker while lease is active", async () => {
      const res = await client.leaseAcquire("task-cron", 5000, "worker-2");
      expect(res.acquired).toBe(false);
      expect(res.currentOwner).toBe("worker-1");
      expect(res.fencingToken).toBe(1);
    });

    test("should renew active lease with valid fencing token", async () => {
      const renewRes = await client.leaseRenew("task-cron", 1, 10000);
      expect(renewRes.renewed).toBe(true);
      expect(renewRes.fencingToken).toBe(1);
      expect(renewRes.expiresAt).toBeGreaterThan(Date.now() + 5000);
    });

    test("should reject renew if fencing token does not match", async () => {
      const renewRes = await client.leaseRenew("task-cron", 999, 10000);
      expect(renewRes.renewed).toBe(false);
      expect(renewRes.error).toBeDefined();
    });

    test("should release lease with valid fencing token and allow immediate re-acquire with incremented token", async () => {
      const releaseRes = await client.leaseRelease("task-cron", 1);
      expect(releaseRes.released).toBe(true);

      const reacquire = await client.leaseAcquire("task-cron", 5000, "worker-2");
      expect(reacquire.acquired).toBe(true);
      expect(reacquire.fencingToken).toBe(2); // strictly monotonic increment: 1 -> 2
      expect(reacquire.currentOwner).toBe("worker-2");

      await client.leaseRelease("task-cron", 2);
    });

    test("should failover lease automatically after TTL expires", async () => {
      const res1 = await client.leaseAcquire("quick-lease", 150, "worker-temp");
      expect(res1.acquired).toBe(true);
      expect(res1.fencingToken).toBe(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 200));

      const res2 = await client.leaseAcquire("quick-lease", 5000, "worker-takeover");
      expect(res2.acquired).toBe(true);
      expect(res2.fencingToken).toBe(2);
      expect(res2.currentOwner).toBe("worker-takeover");

      await client.leaseRelease("quick-lease", 2);
    });
  });

  describe("2. Durable Queues with Visibility Timeout & Redelivery", () => {
    test("should publish messages and reserve in FIFO order", async () => {
      const pub1 = await client.queuePublish("orders", { orderId: 101, amount: 25.5 });
      const pub2 = await client.queuePublish("orders", { orderId: 102, amount: 40.0 });
      expect(pub1.messageId).toBeDefined();
      expect(pub2.messageId).toBeDefined();

      const reserve1 = await client.queueReserve("orders", 10000, 1);
      expect(reserve1.messages.length).toBe(1);
      expect(reserve1.messages[0].id).toBe(pub1.messageId);
      expect(reserve1.messages[0].payload).toEqual({ orderId: 101, amount: 25.5 });
      expect(reserve1.messages[0].deliveryCount).toBe(1);

      const reserve2 = await client.queueReserve("orders", 10000, 1);
      expect(reserve2.messages.length).toBe(1);
      expect(reserve2.messages[0].id).toBe(pub2.messageId);
      expect(reserve2.messages[0].payload).toEqual({ orderId: 102, amount: 40.0 });

      // Ack both
      const ack1 = await client.queueAck("orders", pub1.messageId);
      const ack2 = await client.queueAck("orders", pub2.messageId);
      expect(ack1.acked).toBe(true);
      expect(ack2.acked).toBe(true);

      const emptyReserve = await client.queueReserve("orders", 1000, 1);
      expect(emptyReserve.messages.length).toBe(0);
    });

    test("should redeliver unacknowledged message after visibility timeout", async () => {
      const pub = await client.queuePublish("jobs", { jobId: "job-vis-test" });
      const msgId = pub.messageId;

      // Reserve with short visibility timeout (150ms)
      const res1 = await client.queueReserve("jobs", 150, 1);
      expect(res1.messages.length).toBe(1);
      expect(res1.messages[0].id).toBe(msgId);
      expect(res1.messages[0].deliveryCount).toBe(1);

      // Immediate subsequent reserve should yield nothing
      const resIntermediate = await client.queueReserve("jobs", 150, 1);
      expect(resIntermediate.messages.length).toBe(0);

      // Wait for visibility timeout to expire
      await new Promise((r) => setTimeout(r, 220));

      // Second reserve should redeliver message with deliveryCount = 2
      const res2 = await client.queueReserve("jobs", 10000, 1);
      expect(res2.messages.length).toBe(1);
      expect(res2.messages[0].id).toBe(msgId);
      expect(res2.messages[0].deliveryCount).toBe(2);

      await client.queueAck("jobs", msgId);
    });

    test("should immediately redeliver on nack", async () => {
      const pub = await client.queuePublish("retries", { step: "process" });
      const msgId = pub.messageId;

      const res1 = await client.queueReserve("retries", 30000, 1);
      expect(res1.messages.length).toBe(1);

      // Nack message
      const nackRes = await client.queueNack("retries", msgId);
      expect(nackRes.nacked).toBe(true);

      // Immediate subsequent reserve should successfully re-reserve the nacked message
      const res2 = await client.queueReserve("retries", 30000, 1);
      expect(res2.messages.length).toBe(1);
      expect(res2.messages[0].id).toBe(msgId);

      await client.queueAck("retries", msgId);
    });
  });

  describe("3. Crash Recovery & WAL Persistence of Leases and Queues", () => {
    test("should recover active lease and queue state after Hub restart", async () => {
      // 1. Setup initial state
      const leaseRes = await client.leaseAcquire("persistent-cron", 60000, "node-alpha");
      expect(leaseRes.acquired).toBe(true);

      await client.queuePublish("persistent-queue", { task: "billing" });
      await client.queuePublish("persistent-queue", { task: "email" });

      // Reserve 1 item and ack it, leave 1 unreserved
      const reserved = await client.queueReserve("persistent-queue", 60000, 1);
      expect(reserved.messages.length).toBe(1);
      await client.queueAck("persistent-queue", reserved.messages[0].id);

      // 2. Abruptly stop client and server
      await client.disconnect();
      await server.stop();

      // 3. Start a new HubServer on a new socket using the exact same stateDir
      const restartSocket = process.platform === "win32"
        ? `\\\\.\\pipe\\bs9-restart-test-${Date.now()}`
        : join(homedir(), `.bs9-restart-test-${Date.now()}.sock`);

      const recoveredServer = new HubServer({
        socketPath: restartSocket,
        stateDir: testStateDir,
        allowAnonymous: false,
      });
      recoveredServer.registerNamespaceToken(namespace, token);
      await recoveredServer.start();

      const recoveredClient = new HubClient({
        socketPath: restartSocket,
        namespace,
        authToken: token,
      });
      await recoveredClient.connect();

      // 4. Verify lease state was restored
      const leaseCheck = await recoveredClient.leaseAcquire("persistent-cron", 60000, "node-beta");
      expect(leaseCheck.acquired).toBe(false); // still locked by node-alpha
      expect(leaseCheck.currentOwner).toBe("node-alpha");

      // 5. Verify remaining queue item was restored and can be consumed
      const queueCheck = await recoveredClient.queueReserve("persistent-queue", 60000, 1);
      expect(queueCheck.messages.length).toBe(1);
      expect(queueCheck.messages[0].payload).toEqual({ task: "email" });
      await recoveredClient.queueAck("persistent-queue", queueCheck.messages[0].id);

      // Cleanup
      await recoveredClient.disconnect();
      await recoveredServer.stop();
    });
  });
});
