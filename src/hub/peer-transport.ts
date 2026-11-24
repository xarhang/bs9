/**
 * BS9 - Peer-to-Peer Hub Transport (TCP + TLS)
 *
 * Implements:
 * - Zero-config TLS certificate generation (auto self-signed cert via openssl in <stateDir>/hub-peer/)
 *   or user-provided TLS cert/key/CA.
 * - Mutual HMAC authentication using a shared cluster secret (computeHmac / verifyHmac).
 * - Reuse of strict 4-byte BE framing (encodeFrame / StreamingFrameDecoder).
 * - Automatic outbound reconnect with exponential backoff + RTT tracking.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  createServer as createTlsServer,
  connect as tlsConnect,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";
import {
  createServer as createNetServer,
  connect as netConnect,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";
import {
  createEnvelope,
  encodeFrame,
  StreamingFrameDecoder,
  generateNonce,
  computeHmac,
  verifyHmac,
  type Bs9Envelope,
  type PeerHelloPayload,
  type PeerHelloAckPayload,
} from "./protocol.js";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";

export const PEER_NAMESPACE = "__bs9_peer__";

export interface PeerEndpoint {
  nodeId?: string;
  address: string; // "host:port"
}

export interface PeerTlsOptions {
  /** Enable TLS (default: true). Can be disabled only for plain TCP testing if explicitly set to false. */
  enabled?: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  /** Optional pinned SHA-256 certificate fingerprint (hex). */
  pinnedFingerprint?: string;
}

export interface PeerTransportOptions {
  nodeId: string;
  listen: string; // "host:port" or ":port"
  clusterSecret: string;
  peers?: (string | PeerEndpoint)[];
  stateDir?: string;
  tls?: PeerTlsOptions;
  handshakeTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface ConnectedPeerInfo {
  nodeId: string;
  address: string;
  direction: "inbound" | "outbound";
  connectedAt: number;
  lastSeenAt: number;
  rttMs: number;
  tlsFingerprint?: string;
}

interface InternalPeerSession {
  nodeId: string;
  address: string;
  direction: "inbound" | "outbound";
  socket: NetSocket | TLSSocket;
  connectedAt: number;
  lastSeenAt: number;
  rttMs: number;
  tlsFingerprint?: string;
}

export function parseHostPort(spec: string): { host: string; port: number } {
  const trimmed = spec.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`Invalid peer address "${spec}" (expected host:port)`);
  }
  const hostPart = trimmed.slice(0, lastColon).replace(/^\[|\]$/g, "") || "127.0.0.1";
  const port = Number(trimmed.slice(lastColon + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port in peer address "${spec}"`);
  }
  return { host: hostPart, port };
}

// Track generated certs in-process to avoid regenerating when tests share or create multiple nodes quickly.
const certCache = new Map<string, { cert: Buffer; key: Buffer; fingerprint: string }>();

export function ensurePeerTlsIdentity(
  peerDir: string,
  clusterSecret: string,
  tlsOpts?: PeerTlsOptions
): { cert: Buffer; key: Buffer; ca?: Buffer; fingerprint: string } {
  if (tlsOpts?.certPath && tlsOpts?.keyPath) {
    const cert = readFileSync(tlsOpts.certPath);
    const key = readFileSync(tlsOpts.keyPath);
    const ca = tlsOpts.caPath ? readFileSync(tlsOpts.caPath) : undefined;
    const fingerprint = computeCertFingerprint(cert);
    return { cert, key, ca, fingerprint };
  }

  ensurePrivateDirectory(peerDir);
  // Derive deterministic cluster tag so rotating cluster secret invalidates cached self-signed cert.
  const secretTag = createHash("sha256").update(clusterSecret).digest("hex").slice(0, 16);
  const certPath = join(peerDir, `peer-${secretTag}.crt`);
  const keyPath = join(peerDir, `peer-${secretTag}.key`);

  const cached = certCache.get(secretTag);
  if (cached) {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      writeFileSync(certPath, cached.cert, { mode: 0o600 });
      writeFileSync(keyPath, cached.key, { mode: 0o600 });
    }
    return cached;
  }

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-subj",
        `/CN=bs9-peer-${secretTag}`,
      ],
      { stdio: "ignore" }
    );
    securePrivateFile(keyPath);
    securePrivateFile(certPath);
  }

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const fingerprint = computeCertFingerprint(cert);
  const entry = { cert, key, fingerprint };
  certCache.set(secretTag, entry);
  return entry;
}

export function computeCertFingerprint(certPem: Buffer | string): string {
  try {
    const x509 = new X509Certificate(certPem);
    return x509.fingerprint256.replace(/:/g, "").toLowerCase();
  } catch {
    return createHash("sha256").update(certPem).digest("hex");
  }
}

export class PeerTransport extends EventEmitter {
  public readonly nodeId: string;
  public readonly listenAddress: string;
  private readonly clusterSecret: string;
  private readonly stateDir: string;
  private readonly tlsOpts: PeerTlsOptions;
  private readonly handshakeTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private server: TlsServer | NetServer | null = null;
  private boundPort: number = 0;
  private running = false;
  private tlsIdentity: { cert: Buffer; key: Buffer; ca?: Buffer; fingerprint: string } | null = null;

  private readonly configuredPeers = new Map<string, PeerEndpoint>(); // key: address
  private readonly sessions = new Map<string, InternalPeerSession>(); // key: remote nodeId
  private readonly rawSockets = new Set<NetSocket | TLSSocket>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly pendingRequests = new Map<
    string,
    { resolve: (env: Bs9Envelope<any>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(options: PeerTransportOptions) {
    super();
    if (!options.nodeId || typeof options.nodeId !== "string") {
      throw new Error("PeerTransport requires a non-empty nodeId");
    }
    if (!options.clusterSecret || options.clusterSecret.length < 16) {
      throw new Error("PeerTransport requires a clusterSecret of at least 16 characters");
    }
    this.nodeId = options.nodeId;
    this.listenAddress = options.listen;
    this.clusterSecret = options.clusterSecret;
    this.stateDir = options.stateDir || getPlatformInfo().stateDir;
    this.tlsOpts = { enabled: true, ...options.tls };
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 150;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 3000;

    for (const p of options.peers ?? []) {
      const ep: PeerEndpoint = typeof p === "string" ? { address: p } : p;
      this.configuredPeers.set(ep.address, ep);
    }
  }

  public getListenAddress(): string {
    const { host } = parseHostPort(this.listenAddress);
    return `${host}:${this.boundPort || parseHostPort(this.listenAddress).port}`;
  }

  public getTlsFingerprint(): string | undefined {
    return this.tlsIdentity?.fingerprint;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const peerDir = join(this.stateDir, "hub-peer", this.nodeId);
    ensurePrivateDirectory(peerDir);

    const { host, port } = parseHostPort(this.listenAddress);

    if (this.tlsOpts.enabled !== false) {
      this.tlsIdentity = ensurePeerTlsIdentity(peerDir, this.clusterSecret, this.tlsOpts);
      this.server = createTlsServer(
        {
          cert: this.tlsIdentity.cert,
          key: this.tlsIdentity.key,
          ca: this.tlsIdentity.ca,
          requestCert: false,
          rejectUnauthorized: Boolean(this.tlsIdentity.ca),
        },
        (socket) => this.handleInboundSocket(socket, "tls")
      );
    } else {
      this.server = createNetServer((socket) => this.handleInboundSocket(socket, "tcp"));
    }

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      const onError = (err: Error) => reject(err);
      srv.once("error", onError);
      srv.listen(port, host, () => {
        srv.removeListener("error", onError);
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          this.boundPort = addr.port;
        } else {
          this.boundPort = port;
        }
        resolve();
      });
    });

    // Initiate outbound connections to configured peers
    for (const ep of this.configuredPeers.values()) {
      if (ep.address === this.getListenAddress() || ep.nodeId === this.nodeId) continue;
      this.connectToPeer(ep);
    }
  }

  public async stop(): Promise<void> {
    this.running = false;

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("PeerTransport stopped"));
      this.pendingRequests.delete(id);
    }

    for (const s of this.sessions.values()) {
      try {
        s.socket.destroy();
      } catch {}
    }
    this.sessions.clear();

    for (const sock of this.rawSockets) {
      try {
        sock.destroy();
      } catch {}
    }
    this.rawSockets.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  public addPeer(endpoint: string | PeerEndpoint): void {
    const ep: PeerEndpoint = typeof endpoint === "string" ? { address: endpoint } : endpoint;
    if (ep.address === this.getListenAddress() || ep.nodeId === this.nodeId) return;
    this.configuredPeers.set(ep.address, ep);
    if (this.running) {
      this.connectToPeer(ep);
    }
  }

  public getConnectedPeers(): ConnectedPeerInfo[] {
    const out: ConnectedPeerInfo[] = [];
    for (const s of this.sessions.values()) {
      out.push({
        nodeId: s.nodeId,
        address: s.address,
        direction: s.direction,
        connectedAt: s.connectedAt,
        lastSeenAt: s.lastSeenAt,
        rttMs: s.rttMs,
        tlsFingerprint: s.tlsFingerprint,
      });
    }
    return out;
  }

  public getConfiguredPeerAddresses(): string[] {
    return Array.from(this.configuredPeers.keys());
  }

  public isPeerConnected(nodeId: string): boolean {
    const s = this.sessions.get(nodeId);
    return Boolean(s && !s.socket.destroyed);
  }

  public updatePeerRtt(nodeId: string, rttMs: number): void {
    const s = this.sessions.get(nodeId);
    if (s && Number.isFinite(rttMs) && rttMs >= 0) {
      s.rttMs = s.rttMs === 0 ? rttMs : Math.round(s.rttMs * 0.7 + rttMs * 0.3);
      s.lastSeenAt = Date.now();
    }
  }

  public send(nodeId: string, envelope: Bs9Envelope<any>): boolean {
    const session = this.sessions.get(nodeId);
    if (!session || session.socket.destroyed) return false;
    try {
      session.socket.write(encodeFrame(envelope));
      return true;
    } catch {
      return false;
    }
  }

  public broadcast(envelope: Bs9Envelope<any>): string[] {
    const frame = encodeFrame(envelope);
    const sentTo: string[] = [];
    for (const [nodeId, session] of this.sessions.entries()) {
      if (session.socket.destroyed) continue;
      try {
        session.socket.write(frame);
        sentTo.push(nodeId);
      } catch {}
    }
    return sentTo;
  }

  public request<TReq = any, TRes = any>(
    nodeId: string,
    type: string,
    payload: TReq,
    timeoutMs: number = 3000,
    namespace: string = PEER_NAMESPACE
  ): Promise<Bs9Envelope<TRes>> {
    const session = this.sessions.get(nodeId);
    if (!session || session.socket.destroyed) {
      return Promise.reject(new Error(`Peer "${nodeId}" is not connected`));
    }
    const env = createEnvelope<TReq>(type, namespace, payload);
    return new Promise<Bs9Envelope<TRes>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(env.id);
        reject(new Error(`Peer request ${type} to "${nodeId}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(env.id, { resolve, reject, timer });
      try {
        session.socket.write(encodeFrame(env));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(env.id);
        reject(err as Error);
      }
    });
  }

  private handleInboundSocket(socket: NetSocket | TLSSocket, mode: "tls" | "tcp"): void {
    this.rawSockets.add(socket);
    const decoder = new StreamingFrameDecoder();
    let authenticatedNodeId: string | null = null;
    const serverChallenge = generateNonce();
    let clientNonce: string | null = null;
    let clientFp: string | undefined;

    const handshakeTimer = setTimeout(() => {
      if (!authenticatedNodeId) {
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      let envelopes: Bs9Envelope[];
      try {
        envelopes = decoder.push(chunk);
      } catch {
        clearTimeout(handshakeTimer);
        socket.destroy();
        return;
      }

      for (const env of envelopes) {
        if (!authenticatedNodeId) {
          if (env.type === "PEER_HELLO") {
            const payload = env.payload as PeerHelloPayload & { hmac?: string };
            if (!payload?.nodeId || !payload?.nonce || payload.nodeId === this.nodeId) {
              clearTimeout(handshakeTimer);
              socket.destroy();
              return;
            }
            if (
              !payload.hmac ||
              !verifyHmac(
                `hello:${payload.nonce}:${payload.nodeId}:${payload.tlsFingerprint || ""}`,
                this.clusterSecret,
                payload.hmac
              )
            ) {
              clearTimeout(handshakeTimer);
              this.emit("authFailed", { direction: "inbound", nodeId: payload.nodeId });
              socket.destroy();
              return;
            }
            clientNonce = payload.nonce;
            clientFp = payload.tlsFingerprint;
            // Reply with our HMAC of client's nonce + our challenge nonce for mutual auth
            const myFp = this.tlsIdentity?.fingerprint;
            const ack = createEnvelope<PeerHelloAckPayload>(
              "PEER_HELLO_ACK",
              PEER_NAMESPACE,
              {
                nodeId: this.nodeId,
                hmac: computeHmac(`${clientNonce}:${this.nodeId}:${myFp || ""}`, this.clusterSecret),
                challengeNonce: serverChallenge,
                tlsFingerprint: myFp,
              },
              env.id
            );
            socket.write(encodeFrame(ack));
          } else if (env.type === "PEER_HELLO_ACK" && clientNonce) {
            const payload = env.payload as PeerHelloAckPayload;
            if (
              !payload?.nodeId ||
              !payload?.hmac ||
              !verifyHmac(`${serverChallenge}:${payload.nodeId}`, this.clusterSecret, payload.hmac)
            ) {
              clearTimeout(handshakeTimer);
              this.emit("authFailed", { direction: "inbound", nodeId: payload?.nodeId });
              socket.destroy();
              return;
            }
            clearTimeout(handshakeTimer);
            authenticatedNodeId = payload.nodeId;
            const remoteAddr = `${socket.remoteAddress || "127.0.0.1"}:${socket.remotePort || 0}`;
            this.registerSession(authenticatedNodeId, remoteAddr, "inbound", socket, mode, clientFp);
          } else {
            clearTimeout(handshakeTimer);
            socket.destroy();
            return;
          }
          continue;
        }

        this.dispatchEnvelope(authenticatedNodeId, env);
      }
    });

    const cleanup = () => {
      clearTimeout(handshakeTimer);
      this.rawSockets.delete(socket);
      if (authenticatedNodeId) {
        const current = this.sessions.get(authenticatedNodeId);
        if (current && current.socket === socket) {
          this.sessions.delete(authenticatedNodeId);
          this.rejectPendingForPeer(authenticatedNodeId);
          this.emit("peerDisconnected", authenticatedNodeId);
        }
      }
    };
    socket.on("close", cleanup);
    socket.on("error", () => cleanup());
  }

  private rejectPendingForPeer(_nodeId: string): void {
    // Reject all in-flight RPCs if their socket was replaced or closed so callers can retry immediately
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject(new Error("Peer connection reset during request"));
    }
  }

  private connectToPeer(ep: PeerEndpoint): void {
    if (!this.running) return;
    if (ep.nodeId && this.isPeerConnected(ep.nodeId)) return;

    const { host, port } = parseHostPort(ep.address);
    let socket: NetSocket | TLSSocket;

    if (this.tlsOpts.enabled !== false) {
      socket = tlsConnect({
        host,
        port,
        cert: this.tlsIdentity?.cert,
        key: this.tlsIdentity?.key,
        ca: this.tlsIdentity?.ca,
        rejectUnauthorized: Boolean(this.tlsIdentity?.ca),
      });
    } else {
      socket = netConnect({ host, port });
    }
    this.rawSockets.add(socket);

    const decoder = new StreamingFrameDecoder();
    const clientNonce = generateNonce();
    let authenticatedNodeId: string | null = null;

    const handshakeTimer = setTimeout(() => {
      if (!authenticatedNodeId) {
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);

    const onConnected = () => {
      if (this.tlsOpts.enabled !== false && this.tlsOpts.pinnedFingerprint) {
        const peerCert = (socket as TLSSocket).getPeerCertificate();
        if (!peerCert || !peerCert.raw) {
          socket.destroy();
          return;
        }
        const fp = createHash("sha256").update(peerCert.raw).digest("hex").toLowerCase();
        if (fp !== this.tlsOpts.pinnedFingerprint.replace(/:/g, "").toLowerCase()) {
          this.emit("authFailed", { direction: "outbound", address: ep.address, reason: "fingerprint_mismatch" });
          socket.destroy();
          return;
        }
      }

      const myFp = this.tlsIdentity?.fingerprint;
      const hello = createEnvelope<PeerHelloPayload & { hmac: string }>("PEER_HELLO", PEER_NAMESPACE, {
        nodeId: this.nodeId,
        nonce: clientNonce,
        listenAddress: this.getListenAddress(),
        tlsFingerprint: myFp,
        hmac: computeHmac(`hello:${clientNonce}:${this.nodeId}:${myFp || ""}`, this.clusterSecret),
      });
      socket.write(encodeFrame(hello));
    };

    if (this.tlsOpts.enabled !== false) {
      socket.once("secureConnect", onConnected);
    } else {
      socket.once("connect", onConnected);
    }

    socket.on("data", (chunk: Buffer) => {
      let envelopes: Bs9Envelope[];
      try {
        envelopes = decoder.push(chunk);
      } catch {
        clearTimeout(handshakeTimer);
        socket.destroy();
        return;
      }

      for (const env of envelopes) {
        if (!authenticatedNodeId) {
          if (env.type === "PEER_HELLO_ACK") {
            const payload = env.payload as PeerHelloAckPayload;
            if (
              !payload?.nodeId ||
              !payload?.hmac ||
              !payload?.challengeNonce ||
              payload.nodeId === this.nodeId ||
              !verifyHmac(
                `${clientNonce}:${payload.nodeId}:${payload.tlsFingerprint || ""}`,
                this.clusterSecret,
                payload.hmac
              )
            ) {
              clearTimeout(handshakeTimer);
              this.emit("authFailed", { direction: "outbound", address: ep.address });
              socket.destroy();
              return;
            }
            // Complete mutual auth by responding to server's challengeNonce
            const finalAck = createEnvelope<PeerHelloAckPayload>("PEER_HELLO_ACK", PEER_NAMESPACE, {
              nodeId: this.nodeId,
              hmac: computeHmac(`${payload.challengeNonce}:${this.nodeId}`, this.clusterSecret),
              tlsFingerprint: this.tlsIdentity?.fingerprint,
            });
            socket.write(encodeFrame(finalAck));

            clearTimeout(handshakeTimer);
            authenticatedNodeId = payload.nodeId;
            ep.nodeId = authenticatedNodeId;
            this.reconnectAttempts.delete(ep.address);
            this.registerSession(
              authenticatedNodeId,
              ep.address,
              "outbound",
              socket,
              this.tlsOpts.enabled !== false ? "tls" : "tcp",
              payload.tlsFingerprint
            );
          } else {
            clearTimeout(handshakeTimer);
            socket.destroy();
            return;
          }
          continue;
        }

        this.dispatchEnvelope(authenticatedNodeId, env);
      }
    });

    const scheduleReconnect = () => {
      clearTimeout(handshakeTimer);
      this.rawSockets.delete(socket);
      if (authenticatedNodeId) {
        const current = this.sessions.get(authenticatedNodeId);
        if (current && current.socket === socket) {
          this.sessions.delete(authenticatedNodeId);
          this.emit("peerDisconnected", authenticatedNodeId);
        }
      }
      if (!this.running || !this.configuredPeers.has(ep.address)) return;
      if (this.reconnectTimers.has(ep.address)) return;

      const attempts = (this.reconnectAttempts.get(ep.address) || 0) + 1;
      this.reconnectAttempts.set(ep.address, attempts);
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * Math.pow(1.5, Math.min(attempts, 10)));
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(ep.address);
        this.connectToPeer(ep);
      }, delay);
      this.reconnectTimers.set(ep.address, timer);
    };

    socket.on("close", scheduleReconnect);
    socket.on("error", () => {});
  }

  private registerSession(
    remoteNodeId: string,
    address: string,
    direction: "inbound" | "outbound",
    socket: NetSocket | TLSSocket,
    mode: "tls" | "tcp",
    peerFingerprint?: string
  ): void {
    const existing = this.sessions.get(remoteNodeId);
    if (existing && existing.socket !== socket && !existing.socket.destroyed) {
      // Deterministic tie-breaker for simultaneous open: keep connection initiated by smaller nodeId
      const keepNew =
        direction === "outbound" ? this.nodeId < remoteNodeId : remoteNodeId < this.nodeId;
      if (!keepNew) {
        socket.destroy();
        return;
      }
      try {
        existing.socket.destroy();
      } catch {}
    }

    let tlsFingerprint: string | undefined = peerFingerprint;
    if (!tlsFingerprint && mode === "tls") {
      try {
        const cert = (socket as TLSSocket).getPeerCertificate();
        if (cert?.raw) {
          tlsFingerprint = createHash("sha256").update(cert.raw).digest("hex");
        }
      } catch {}
    }

    const now = Date.now();
    this.sessions.set(remoteNodeId, {
      nodeId: remoteNodeId,
      address,
      direction,
      socket,
      connectedAt: now,
      lastSeenAt: now,
      rttMs: 0,
      tlsFingerprint,
    });
    this.emit("peerConnected", remoteNodeId, address, direction);
  }

  private dispatchEnvelope(fromNodeId: string, env: Bs9Envelope<any>): void {
    const session = this.sessions.get(fromNodeId);
    if (session) {
      session.lastSeenAt = Date.now();
    }

    if (env.replyTo) {
      const pending = this.pendingRequests.get(env.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(env.replyTo);
        pending.resolve(env);
        return;
      }
    }

    this.emit("message", fromNodeId, env);
  }
}
