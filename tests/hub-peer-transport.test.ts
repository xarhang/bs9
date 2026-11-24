import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PeerTransport, PEER_NAMESPACE } from "../src/hub/peer-transport.js";
import { createEnvelope } from "../src/hub/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("PeerTransport (TCP + TLS + mutual HMAC)", () => {
  const dirs: string[] = [];
  const transports: PeerTransport[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "bs9-peer-test-"));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const t of transports.splice(0)) {
      await t.stop().catch(() => {});
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("establishes TLS connection, verifies mutual HMAC, and exchanges large frames", async () => {
    const stateDir = makeDir();
    const nodeA = new PeerTransport({
      nodeId: "node-a",
      listen: "127.0.0.1:0",
      clusterSecret: SECRET,
      stateDir,
    });
    transports.push(nodeA);
    await nodeA.start();

    const nodeB = new PeerTransport({
      nodeId: "node-b",
      listen: "127.0.0.1:0",
      clusterSecret: SECRET,
      peers: [nodeA.getListenAddress()],
      stateDir,
    });
    transports.push(nodeB);
    await nodeB.start();

    await waitFor(() => nodeA.isPeerConnected("node-b") && nodeB.isPeerConnected("node-a"));

    expect(nodeA.getTlsFingerprint()).toBeDefined();
    const peersOnA = nodeA.getConnectedPeers();
    expect(peersOnA).toHaveLength(1);
    expect(peersOnA[0].nodeId).toBe("node-b");
    expect(peersOnA[0].tlsFingerprint).toBeDefined();

    // Request/response with large payload (256 KB)
    const bigBlob = "x".repeat(256 * 1024);
    nodeA.on("message", (from, env) => {
      if (env.type === "ECHO_TEST") {
        nodeA.send(
          from,
          createEnvelope("ECHO_REPLY", PEER_NAMESPACE, { echoed: env.payload.blob.length }, env.id)
        );
      }
    });

    const reply = await nodeB.request("node-a", "ECHO_TEST", { blob: bigBlob });
    expect(reply.payload.echoed).toBe(256 * 1024);
  });

  test("rejects peer with wrong cluster secret", async () => {
    const stateDir = makeDir();
    const nodeA = new PeerTransport({
      nodeId: "node-a",
      listen: "127.0.0.1:0",
      clusterSecret: SECRET,
      stateDir,
    });
    transports.push(nodeA);
    await nodeA.start();

    let authFailed = false;
    nodeA.on("authFailed", () => {
      authFailed = true;
    });

    const badNode = new PeerTransport({
      nodeId: "node-bad",
      listen: "127.0.0.1:0",
      clusterSecret: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      peers: [nodeA.getListenAddress()],
      stateDir,
      reconnectBaseMs: 5000,
    });
    transports.push(badNode);
    await badNode.start();

    await waitFor(() => authFailed, 3000);
    expect(nodeA.isPeerConnected("node-bad")).toBe(false);
    expect(badNode.isPeerConnected("node-a")).toBe(false);
  });

  test("automatically reconnects when peer restarts", async () => {
    const stateDir = makeDir();
    let nodeA = new PeerTransport({
      nodeId: "node-a",
      listen: "127.0.0.1:0",
      clusterSecret: SECRET,
      stateDir,
    });
    transports.push(nodeA);
    await nodeA.start();
    const addrA = nodeA.getListenAddress();

    const nodeB = new PeerTransport({
      nodeId: "node-b",
      listen: "127.0.0.1:0",
      clusterSecret: SECRET,
      peers: [addrA],
      stateDir,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    });
    transports.push(nodeB);
    await nodeB.start();

    await waitFor(() => nodeB.isPeerConnected("node-a"));

    // Stop nodeA
    await nodeA.stop();
    await waitFor(() => !nodeB.isPeerConnected("node-a"));

    // Restart nodeA on the same address
    nodeA = new PeerTransport({
      nodeId: "node-a",
      listen: addrA,
      clusterSecret: SECRET,
      stateDir,
    });
    transports.push(nodeA);
    await nodeA.start();

    await waitFor(() => nodeB.isPeerConnected("node-a") && nodeA.isPeerConnected("node-b"));
  });
});
