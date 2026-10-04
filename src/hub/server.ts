/**
 * BS9 - State Hub Core Server
 *
 * Background daemon service hosting the in-memory state engine, WAL, and snapshot recovery:
 * - Listens on Unix Domain Socket (Linux/macOS) or Named Pipe (Windows).
 * - Implements 4-byte wire framing protocol with StreamingFrameDecoder.
 * - Authenticates clients via namespace tokens (BS9_AUTH_TOKEN_FILE, cluster tokens, or explicit tokens).
 * - Enforces strict payload & memory limits (16 MB frame, 1 MB per value, 100 MB per namespace).
 * - Never executes serialized user functions.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { ensurePrivateDirectory, securePrivateFile, writePrivateFile } from "../utils/private-files.js";
import {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  generateNonce,
  verifyHmac,
  generateToken,
  type Bs9Envelope,
  type HandshakeChallengePayload,
  type HandshakeResponsePayload,
  type HandshakeAckPayload,
  type HandshakeRejectPayload,
  type KvGetPayload,
  type KvGetResponsePayload,
  type KvSetPayload,
  type KvSetResponsePayload,
  type KvDeletePayload,
  type KvDeleteResponsePayload,
  type KvIncrPayload,
  type KvIncrResponsePayload,
  type KvCasPayload,
  type KvCasResponsePayload,
  type KvSnapshotPayload,
  type KvSnapshotResponsePayload,
  type KvErrorPayload,
  type LeaseAcquirePayload,
  type LeaseAcquireResponsePayload,
  type LeaseRenewPayload,
  type LeaseRenewResponsePayload,
  type LeaseReleasePayload,
  type LeaseReleaseResponsePayload,
  type QueuePublishPayload,
  type QueuePublishResponsePayload,
  type QueueReservePayload,
  type QueueReserveResponsePayload,
  type QueueAckPayload,
  type QueueAckResponsePayload,
  type QueueNackPayload,
  type QueueNackResponsePayload,
  type ReservedMessage,
  MAX_NAMESPACE_MEMORY,
  MAX_VALUE_SIZE,
} from "./protocol.js";
import { getPlatformInfo } from "../platform/detect.js";
import { KvEngine, type KvEngineOptions, type CasResult, estimateValueSize, isDeepEqual, validateSafeData } from "./engine.js";
import { WalManager, type WalManagerOptions, type RecoveryResult, type WalRecord } from "./wal.js";
import {
  LeaseManager,
  type LeaseAcquireResult,
  type LeaseRenewResult,
  type LeaseReleaseResult,
  type LeaseRecord,
} from "./leases.js";
import { QueueManager, type QueueMessage } from "./queues.js";

export interface HubServerOptions extends KvEngineOptions, WalManagerOptions {
  socketPath?: string;
  authToken?: string;
  authTokenFile?: string;
  handshakeTimeoutMs?: number;
  allowAnonymous?: boolean;
  autoRecover?: boolean;
}

interface AuthenticatedSession {
  socket: Socket;
  namespace: string;
  authenticatedAt: number;
}

export function getDefaultHubSocketPath(): string {
  if (process.env.BS9_HUB_SOCKET) {
    return process.env.BS9_HUB_SOCKET;
  }
  const platformInfo = getPlatformInfo();
  if (platformInfo.isWindows) {
    const safeUser = (process.env.USERNAME || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `\\\\.\\pipe\\bs9-hub-${safeUser}`;
  }
  return join(platformInfo.runtimeDir, "hub.sock");
}

export function isValidNamespace(namespace: string): boolean {
  return typeof namespace === "string" &&
    /^[a-zA-Z0-9._-]+$/.test(namespace) &&
    namespace.length <= 128 &&
    !namespace.includes("..") &&
    !namespace.includes("/") &&
    !namespace.includes("\\");
}

function assertFiniteDuration(value: number | undefined, field: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${field} must be a finite number`);
  }
}

function assertRequiredFiniteDuration(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
}

export class HubServer extends EventEmitter {
  private server: Server | null = null;
  private socketPath: string;
  private handshakeTimeoutMs: number;
  private allowAnonymous: boolean;
  private defaultAuthToken?: string;
  private authTokenFile?: string;
  private namespaceTokens: Map<string, string> = new Map();
  private activeSockets: Set<Socket> = new Set();
  private sessions: Map<Socket, AuthenticatedSession> = new Map();
  private recoveredNamespaces: Set<string> = new Set();
  private recoveryFailures: Map<string, Error> = new Map();
  private autoRecover: boolean;
  private isWalRecovered = false;
  private maxValueSize: number;
  private maxNamespaceMemory: number;

  public readonly engine: KvEngine;
  public readonly wal: WalManager;
  public readonly leases: LeaseManager;
  public readonly queues: QueueManager;

  constructor(options: HubServerOptions = {}) {
    super();
    this.socketPath = options.socketPath || getDefaultHubSocketPath();
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.allowAnonymous = options.allowAnonymous ?? false;
    this.autoRecover = options.autoRecover ?? true;
    this.maxValueSize = options.maxValueSize ?? MAX_VALUE_SIZE;
    this.maxNamespaceMemory = options.maxNamespaceMemory ?? MAX_NAMESPACE_MEMORY;
    this.defaultAuthToken = options.authToken || process.env.BS9_AUTH_TOKEN;
    this.authTokenFile = options.authTokenFile || process.env.BS9_AUTH_TOKEN_FILE;

    this.engine = new KvEngine(options);
    this.wal = new WalManager(options);
    this.leases = new LeaseManager();
    // Queue storage has an explicit budget alongside the engine's KV budget.
    // The same configured per-namespace limit governs both components, while
    // the legacy KV queue projection remains covered by the engine's own limit.
    this.queues = new QueueManager(1000, options.maxNamespaceMemory);
  }

  /**
   * Registers or updates an auth token for a specific namespace.
   */
  public registerNamespaceToken(namespace: string, explicitToken?: string): { token: string; tokenFilePath: string } {
    if (!isValidNamespace(namespace)) {
      throw new Error(`Security: Invalid namespace identifier: ${namespace}`);
    }

    const platformInfo = getPlatformInfo();
    const token = explicitToken || this.namespaceTokens.get(namespace) || generateToken();
    this.namespaceTokens.set(namespace, token);

    const tokensDir = join(platformInfo.runtimeDir, "tokens");
    if (platformInfo.isLinux) {
      ensurePrivateDirectory(platformInfo.runtimeDir);
      ensurePrivateDirectory(tokensDir);
    } else if (!existsSync(tokensDir)) {
      mkdirSync(tokensDir, { recursive: true });
    }

    const tokenFilePath = join(tokensDir, `${namespace}.token`);
    if (platformInfo.isLinux) writePrivateFile(tokenFilePath, token);
    else {
      writeFileSync(tokenFilePath, token, { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(tokenFilePath, 0o600);
      } catch {}
    }

    return { token, tokenFilePath };
  }

  /**
   * Resolves token for a given namespace.
   */
  public getNamespaceToken(namespace: string): string | null {
    if (!isValidNamespace(namespace)) {
      return null;
    }

    if (this.namespaceTokens.has(namespace)) {
      return this.namespaceTokens.get(namespace)!;
    }

    const platformInfo = getPlatformInfo();

    // Check cluster/runtime token file
    if (platformInfo.isLinux) {
      ensurePrivateDirectory(platformInfo.runtimeDir);
      const tokensDir = join(platformInfo.runtimeDir, "tokens");
      if (existsSync(tokensDir)) ensurePrivateDirectory(tokensDir);
    }
    const tokenFilePath = join(platformInfo.runtimeDir, "tokens", `${namespace}.token`);
    if (existsSync(tokenFilePath)) {
      try {
        if (platformInfo.isLinux) {
          ensurePrivateDirectory(join(platformInfo.runtimeDir, "tokens"));
          securePrivateFile(tokenFilePath);
        }
        const token = readFileSync(tokenFilePath, "utf-8").trim();
        this.namespaceTokens.set(namespace, token);
        return token;
      } catch {}
    }

    // Check custom authTokenFile
    if (this.authTokenFile && existsSync(this.authTokenFile)) {
      try {
        const content = readFileSync(this.authTokenFile, "utf-8").trim();
        if (content.startsWith("{")) {
          const parsed = JSON.parse(content);
          if (parsed[namespace]) {
            return String(parsed[namespace]);
          }
        } else if (content.length > 0) {
          return content;
        }
      } catch {}
    }

    return this.defaultAuthToken || null;
  }

  public isListening(): boolean {
    return this.server !== null;
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }

  public isRecovered(): boolean {
    return this.isWalRecovered;
  }

  public getRecoveredNamespacesCount(): number {
    return this.recoveredNamespaces.size;
  }

  /**
   * Starts the Hub service listening on UDS / Named Pipe.
   */
  public async start(): Promise<void> {
    const platformInfo = getPlatformInfo();

    if (this.autoRecover) {
      const diskNamespaces = this.wal.listNamespacesOnDisk();
      for (const ns of diskNamespaces) {
        try {
          this.ensureRecovered(ns);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(`[HubServer] Namespace "${ns}" is unavailable after recovery failed: ${error.message}`);
        }
      }
      this.isWalRecovered = true;
    } else {
      this.isWalRecovered = true;
    }

    // Clean up stale Unix domain socket
    if (!platformInfo.isWindows && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        this.handleClientConnection(socket);
      });

      this.server.on("error", (err: Error) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        if (!platformInfo.isWindows) {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {}
        }
        this.emit("listening", this.socketPath);
        resolve();
      });
    });
  }

  /**
   * Stops the Hub service and disconnects clients.
   */
  public async stop(): Promise<void> {
    this.engine.close();
    this.leases.close();
    this.queues.close();
    this.wal.close();

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    this.activeSockets.clear();
    this.sessions.clear();

    if (!this.server) return;

    const srv = this.server;
    this.server = null;

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          const platformInfo = getPlatformInfo();
          if (!platformInfo.isWindows && existsSync(this.socketPath)) {
            try {
              unlinkSync(this.socketPath);
            } catch {}
          }
          resolve();
        }
      };

      const fallbackTimer = setTimeout(done, 500);
      try {
        srv.close(() => {
          clearTimeout(fallbackTimer);
          done();
        });
        if (typeof srv.unref === "function") {
          srv.unref();
        }
      } catch {
        clearTimeout(fallbackTimer);
        done();
      }
    });
  }

  /**
   * Ensures state for namespace has been recovered from snapshot and WAL.
   */
  public ensureRecovered(namespace: string): RecoveryResult {
    if (this.recoveredNamespaces.has(namespace)) {
      return {
        snapshotLoaded: false,
        entriesFromSnapshot: 0,
        replayedWalRecords: 0,
        truncatedBytes: 0,
      };
    }
    const previousFailure = this.recoveryFailures.get(namespace);
    if (previousFailure) throw previousFailure;

    try {
      const result = this.wal.recover(namespace, this.engine, this.leases, this.queues);
      this.reconcileCompatibilityProjections(namespace);
      this.recoveredNamespaces.add(namespace);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recoveryFailures.set(namespace, error);
      throw error;
    }
  }

  private reconcileCompatibilityProjections(namespace: string): void {
    const existingEntries = this.engine.exportState(namespace);
    for (const key of Object.keys(existingEntries)) {
      if (key.startsWith("__bs9_queue:") || key.startsWith("__bs9_lease:")) {
        this.engine.delete(namespace, key);
      }
    }

    for (const [queueName, messages] of Object.entries(this.queues.exportState(namespace))) {
      if (messages.length === 0) continue;
      const projection = this.queues.getQueueProjection(namespace, queueName);
      if (!projection) continue;
      try {
        this.engine.set(namespace, `__bs9_queue:${queueName}`, projection);
      } catch {
        // The compatibility projection is optional; durable queue state is authoritative.
      }
    }

    const now = Date.now();
    for (const [leaseName, state] of Object.entries(this.leases.exportState(namespace))) {
      const lease = state.record;
      if (!lease || lease.expiresAt <= now) continue;
      const ttlMs = Math.max(1, lease.expiresAt - now);
      try {
        this.engine.set(namespace, `__bs9_lease:${leaseName}`, String(lease.fencingToken), ttlMs);
      } catch {
        // The compatibility projection is optional; durable lease state is authoritative.
      }
    }
  }

  /**
   * Direct programmatic KV methods for in-process access
   */
  public get(namespace: string, key: string): any | null {
    this.ensureRecovered(namespace);
    return this.engine.get(namespace, key);
  }

  private appendWalRecord(
    namespace: string,
    record: Omit<WalRecord, "seq" | "timestamp"> & { timestamp?: number }
  ): void {
    const walRecord = {
      ...record,
      seq: this.wal.peekNextSeq(namespace),
      timestamp: record.timestamp ?? Date.now(),
    } as WalRecord;
    this.wal.appendWithSnapshot(namespace, walRecord, {
      engine: this.engine,
      leases: this.leases,
      queues: this.queues,
    });
  }

  private canonicalizeValue(value: any): any {
    validateSafeData(value);
    if (value === undefined) return undefined;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new Error(`Value must be JSON serializable for durable Hub state: ${(error as Error).message}`);
    }
    if (typeof serialized !== "string") {
      throw new Error("Value must be JSON serializable for durable Hub state");
    }
    return JSON.parse(serialized);
  }

  private preflightSet(namespace: string, key: string, value: any): any {
    if (typeof key !== "string") throw new Error("KV key must be a string");
    const canonicalValue = this.canonicalizeValue(value);
    const valueSize = estimateValueSize(canonicalValue);
    if (valueSize > this.maxValueSize) {
      throw new Error(`Value size ${valueSize} exceeds maximum limit of ${this.maxValueSize} bytes`);
    }

    // Do not evict an expired entry before the WAL append. Expired entries are
    // omitted from exportState, so this conservative preflight may count an
    // expired target key twice, but if it passes KvEngine.set cannot exceed the
    // same configured bound.
    const entries = this.engine.exportState(namespace);
    const oldSize = Object.prototype.hasOwnProperty.call(entries, key)
      ? entries[key].sizeBytes
      : 0;
    const entrySize = Buffer.byteLength(key, "utf-8") + valueSize + 64;
    const requested = this.engine.getNamespaceMemory(namespace) - oldSize + entrySize;
    if (requested > this.maxNamespaceMemory) {
      throw new Error(
        `Namespace memory limit exceeded: requested ${requested} bytes, max allowed is ${this.maxNamespaceMemory} bytes`
      );
    }
    return canonicalValue;
  }

  private getLogicalValue(namespace: string, key: string): any | null {
    // exportState omits expired entries without changing memory, allowing a
    // durable mutation to be appended before KvEngine performs lazy cleanup.
    const entries = this.engine.exportState(namespace);
    return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key].value : null;
  }

  public set(namespace: string, key: string, value: any, ttlMs?: number): boolean {
    this.ensureRecovered(namespace);
    assertFiniteDuration(ttlMs, "TTL");
    const durableValue = this.preflightSet(namespace, key, value);
    this.appendWalRecord(namespace, {
      op: "set",
      key,
      value: durableValue,
      ttlMs,
    });
    return this.engine.set(namespace, key, durableValue, ttlMs);
  }

  public delete(namespace: string, key: string): boolean {
    this.ensureRecovered(namespace);
    if (typeof key !== "string") throw new Error("KV key must be a string");
    this.appendWalRecord(namespace, {
      op: "del",
      key,
    });
    return this.engine.delete(namespace, key);
  }

  public incr(namespace: string, key: string, delta: number = 1): number {
    this.ensureRecovered(namespace);
    if (typeof key !== "string") throw new Error("KV key must be a string");
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      throw new Error("Increment delta must be a finite number");
    }
    const current = this.getLogicalValue(namespace, key);
    if (current !== null && current !== undefined && typeof current !== "number") {
      throw new Error(`Cannot increment key "${key}": existing value is not a numeric value`);
    }
    const newValue = current === null || current === undefined ? delta : current + delta;
    if (!Number.isFinite(newValue)) throw new Error("Increment result must be a finite number");
    this.preflightSet(namespace, key, newValue);
    this.appendWalRecord(namespace, {
      op: "incr",
      key,
      delta,
    });
    return this.engine.incr(namespace, key, delta);
  }

  public cas(
    namespace: string,
    key: string,
    expectedValue: any,
    newValue: any,
    ttlMs?: number
  ): CasResult {
    this.ensureRecovered(namespace);
    assertFiniteDuration(ttlMs, "TTL");
    if (typeof key !== "string") throw new Error("KV key must be a string");
    const durableExpected = this.canonicalizeValue(expectedValue);
    const durableNewValue = this.canonicalizeValue(newValue);
    const currentValue = this.getLogicalValue(namespace, key);
    if (!isDeepEqual(currentValue, durableExpected)) return { success: false, currentValue };
    this.preflightSet(namespace, key, durableNewValue);
    this.appendWalRecord(namespace, {
      op: "cas",
      key,
      expectedValue: durableExpected,
      newValue: durableNewValue,
      ttlMs,
    });
    return this.engine.cas(namespace, key, durableExpected, durableNewValue, ttlMs);
  }

  // --- Direct Programmatic Lease Methods ---

  public leaseAcquire(
    namespace: string,
    leaseName: string,
    ttlMs: number,
    ownerId: string
  ): LeaseAcquireResult {
    this.ensureRecovered(namespace);
    assertRequiredFiniteDuration(ttlMs, "Lease TTL");
    const existing = this.leases.get(namespace, leaseName);
    if (existing) return this.leases.acquire(namespace, leaseName, ttlMs, ownerId);
    const timestamp = Date.now();
    const fencingToken = this.leases.getCurrentFencingToken(namespace, leaseName) + 1;
    const expiresAt = timestamp + ttlMs;
    this.appendWalRecord(namespace, {
      op: "lease_acquire",
      leaseName,
      ownerId,
      fencingToken,
      expiresAt,
      ttlMs,
      timestamp,
    });
    this.leases.applyAcquire(namespace, leaseName, ownerId, fencingToken, expiresAt, timestamp);
    this.syncLeaseProjection(namespace, leaseName, fencingToken, ttlMs);
    return { acquired: true, fencingToken, expiresAt, currentOwner: ownerId };
  }

  public leaseRenew(
    namespace: string,
    leaseName: string,
    fencingToken: number,
    ttlMs: number
  ): LeaseRenewResult {
    this.ensureRecovered(namespace);
    assertRequiredFiniteDuration(ttlMs, "Lease TTL");
    const existing = this.leases.exportState(namespace)[leaseName]?.record;
    if (!existing || existing.fencingToken !== fencingToken) {
      // A failed renew does not mutate LeaseManager; preserve its existing error text.
      return this.leases.renew(namespace, leaseName, fencingToken, ttlMs);
    }
    const timestamp = Date.now();
    const expiresAt = timestamp + ttlMs;
    this.appendWalRecord(namespace, {
      op: "lease_renew",
      leaseName,
      fencingToken,
      expiresAt,
      ttlMs,
      timestamp,
    });
    this.leases.applyRenew(namespace, leaseName, fencingToken, expiresAt);
    this.syncLeaseProjection(namespace, leaseName, fencingToken, ttlMs);
    return { renewed: true, expiresAt, fencingToken };
  }

  public leaseRelease(
    namespace: string,
    leaseName: string,
    fencingToken: number
  ): LeaseReleaseResult {
    this.ensureRecovered(namespace);
    const existing = this.leases.exportState(namespace)[leaseName]?.record;
    if (!existing || existing.fencingToken !== fencingToken) return { released: false };
    this.appendWalRecord(namespace, {
      op: "lease_release",
      leaseName,
      fencingToken,
    });
    this.leases.applyRelease(namespace, leaseName, fencingToken);
    this.engine.delete(namespace, `__bs9_lease:${leaseName}`);
    return { released: true };
  }

  private syncLeaseProjection(namespace: string, leaseName: string, fencingToken: number, ttlMs: number): void {
    const key = `__bs9_lease:${leaseName}`;
    try {
      this.engine.set(namespace, key, String(fencingToken), ttlMs);
    } catch {
      // Lease state is stored independently in the durable lease snapshot/WAL.
      this.engine.delete(namespace, key);
    }
  }

  // --- Direct Programmatic Queue Methods ---

  public queuePublish(
    namespace: string,
    queueName: string,
    payload: any,
    options?: Record<string, any>
  ): { messageId: string } {
    this.ensureRecovered(namespace);
    const prepared = this.queues.preparePublish(namespace, queueName, payload, options);
    const seq = this.wal.peekNextSeq(namespace);
    this.wal.appendQueueRecord(namespace, {
      seq,
      op: "queue_publish",
      queueName,
      messageId: prepared.message.id,
      payload: prepared.message.payload,
      options: prepared.message.options,
      createdAt: prepared.message.createdAt,
      timestamp: Date.now(),
    }, { engine: this.engine, leases: this.leases, queues: this.queues });
    const result = this.queues.publishPrepared(namespace, queueName, prepared);
    this.syncQueueToEngine(namespace, queueName);
    return result;
  }

  public queueReserve(
    namespace: string,
    queueName: string,
    visibilityTimeoutMs: number = 30000,
    maxMessages: number = 1
  ): ReservedMessage[] {
    this.ensureRecovered(namespace);
    assertFiniteDuration(visibilityTimeoutMs, "Queue visibility timeout");
    return this.queues.reserve(namespace, queueName, visibilityTimeoutMs, maxMessages);
  }

  public queueAck(
    namespace: string,
    queueName: string,
    messageId: string
  ): boolean {
    this.ensureRecovered(namespace);
    if (!this.queues.hasMessage(namespace, queueName, messageId)) return false;
    const seq = this.wal.peekNextSeq(namespace);
    this.wal.appendQueueRecord(namespace, {
      seq,
      op: "queue_ack",
      queueName,
      messageId,
      timestamp: Date.now(),
    }, { engine: this.engine, leases: this.leases, queues: this.queues });
    const acked = this.queues.ack(namespace, queueName, messageId);
    if (acked) this.syncQueueToEngine(namespace, queueName);
    return acked;
  }

  public queueNack(
    namespace: string,
    queueName: string,
    messageId: string
  ): boolean {
    this.ensureRecovered(namespace);
    if (!this.queues.hasMessage(namespace, queueName, messageId)) return false;
    const seq = this.wal.peekNextSeq(namespace);
    this.wal.appendQueueRecord(namespace, {
      seq,
      op: "queue_nack",
      queueName,
      messageId,
      timestamp: Date.now(),
    }, { engine: this.engine, leases: this.leases, queues: this.queues });
    return this.queues.nack(namespace, queueName, messageId);
  }

  private syncQueueToEngine(namespace: string, queueName: string): void {
    const key = `__bs9_queue:${queueName}`;
    const projection = this.queues.getQueueProjection(namespace, queueName);
    if (!projection || projection.length === 0) {
      this.engine.delete(namespace, key);
      return;
    }
    try {
      this.engine.set(namespace, key, projection);
    } catch {
      // This legacy KV projection has a 1 MiB per-value limit. The durable
      // queue itself has its own namespace budget, so a larger queue must not
      // be rejected or reported as failed after its WAL commit.
      this.engine.delete(namespace, key);
    }
  }

  public snapshot(namespace: string): string {
    this.ensureRecovered(namespace);
    return this.wal.createSnapshot(namespace, this.engine, this.leases, this.queues);
  }

  /**
   * Handles incoming client connection over stream socket.
   */
  private handleClientConnection(socket: Socket): void {
    this.activeSockets.add(socket);
    const decoder = new StreamingFrameDecoder();
    const nonce = generateNonce();
    let authenticatedSession: AuthenticatedSession | null = null;

    // Send challenge immediately
    const challengeEnvelope = createEnvelope<HandshakeChallengePayload>(
      "HANDSHAKE_CHALLENGE",
      "system",
      { nonce }
    );
    try {
      socket.write(encodeFrame(challengeEnvelope));
    } catch {
      socket.destroy();
      return;
    }

    const authTimer = setTimeout(() => {
      if (!authenticatedSession) {
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      try {
        const envelopes = decoder.push(chunk);
        for (const envelope of envelopes) {
          if (!authenticatedSession) {
            // First message must be HANDSHAKE_RESPONSE
            if (envelope.type !== "HANDSHAKE_RESPONSE") {
              socket.destroy();
              return;
            }

            const payload = envelope.payload as HandshakeResponsePayload;
            const namespace = payload.namespace || "default";

            let authSuccess = false;

            if (this.allowAnonymous) {
              authSuccess = true;
            } else {
              const expectedToken = this.getNamespaceToken(namespace);
              if (expectedToken) {
                if (payload.hmac && verifyHmac(nonce, expectedToken, payload.hmac)) {
                  authSuccess = true;
                } else if ((payload as any).token) {
                  const clientTokenBuf = Buffer.from(String((payload as any).token));
                  const expectedTokenBuf = Buffer.from(expectedToken);
                  if (
                    clientTokenBuf.length === expectedTokenBuf.length &&
                    timingSafeEqual(clientTokenBuf, expectedTokenBuf)
                  ) {
                    authSuccess = true;
                  }
                }
              }
            }

            if (!authSuccess) {
              const rejectEnv = createEnvelope<HandshakeRejectPayload>(
                "HANDSHAKE_REJECT",
                namespace,
                { reason: "Authentication failed: invalid token or HMAC" }
              );
              try {
                socket.write(encodeFrame(rejectEnv));
              } catch {}
              socket.destroy();
              return;
            }

            clearTimeout(authTimer);
            authenticatedSession = {
              socket,
              namespace,
              authenticatedAt: Date.now(),
            };
            this.sessions.set(socket, authenticatedSession);

            // Recover namespace on authentication
            this.ensureRecovered(namespace);

            const ackEnv = createEnvelope<HandshakeAckPayload>(
              "HANDSHAKE_ACK",
              namespace,
              { authenticated: true, workerKey: namespace }
            );
            socket.write(encodeFrame(ackEnv));
            continue;
          }

          // Authenticated dispatch
          this.handleAuthenticatedEnvelope(socket, authenticatedSession, envelope);
        }
      } catch (err) {
        try {
          const errEnv = createEnvelope<KvErrorPayload>("KV_ERROR", "system", {
            error: (err as Error).message,
            code: "PROTOCOL_ERROR",
          });
          socket.write(encodeFrame(errEnv));
        } catch {}
        socket.destroy();
      }
    });

    const cleanup = () => {
      clearTimeout(authTimer);
      this.activeSockets.delete(socket);
      this.sessions.delete(socket);
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  /**
   * Dispatches envelopes from authenticated clients.
   */
  private handleAuthenticatedEnvelope(
    socket: Socket,
    session: AuthenticatedSession,
    envelope: Bs9Envelope
  ): void {
    const namespace = session.namespace;

    // Reject operations targeting a namespace different from the authenticated one
    if (envelope.namespace && envelope.namespace !== namespace && envelope.namespace !== "system") {
      const errEnv = createEnvelope<KvErrorPayload>(
        "KV_ERROR",
        namespace,
        {
          error: `Unauthorized: session is bound to namespace "${namespace}"`,
          code: "UNAUTHORIZED_NAMESPACE",
        },
        envelope.id
      );
      socket.write(encodeFrame(errEnv));
      return;
    }

    try {
      switch (envelope.type) {
        case "KV_GET": {
          const payload = envelope.payload as KvGetPayload;
          const value = this.engine.get(namespace, payload.key);
          const resEnv = createEnvelope<KvGetResponsePayload>(
            "KV_GET_RESPONSE",
            namespace,
            {
              key: payload.key,
              found: value !== null,
              value,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "KV_SET": {
          const payload = envelope.payload as KvSetPayload;
          this.set(namespace, payload.key, payload.value, payload.ttlMs);
          const resEnv = createEnvelope<KvSetResponsePayload>(
            "KV_SET_RESPONSE",
            namespace,
            {
              key: payload.key,
              success: true,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "KV_DELETE": {
          const payload = envelope.payload as KvDeletePayload;
          const deleted = this.delete(namespace, payload.key);
          const resEnv = createEnvelope<KvDeleteResponsePayload>(
            "KV_DELETE_RESPONSE",
            namespace,
            {
              key: payload.key,
              deleted,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "KV_INCR": {
          const payload = envelope.payload as KvIncrPayload;
          const delta = typeof payload.delta === "number" ? payload.delta : 1;
          const newValue = this.incr(namespace, payload.key, delta);
          const resEnv = createEnvelope<KvIncrResponsePayload>(
            "KV_INCR_RESPONSE",
            namespace,
            {
              key: payload.key,
              value: newValue,
              success: true,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "KV_CAS": {
          const payload = envelope.payload as KvCasPayload;
          const casResult = this.cas(
            namespace,
            payload.key,
            payload.expectedValue,
            payload.newValue,
            payload.ttlMs
          );

          const resEnv = createEnvelope<KvCasResponsePayload>(
            "KV_CAS_RESPONSE",
            namespace,
            {
              key: payload.key,
              success: casResult.success,
              currentValue: casResult.currentValue,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "KV_SNAPSHOT": {
          const snapshotPath = this.snapshot(namespace);
          const resEnv = createEnvelope<KvSnapshotResponsePayload>(
            "KV_SNAPSHOT_RESPONSE",
            namespace,
            {
              success: true,
              snapshotPath,
              timestamp: Date.now(),
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "LEASE_ACQUIRE": {
          const payload = envelope.payload as LeaseAcquirePayload;
          const result = this.leaseAcquire(
            namespace,
            payload.leaseName,
            payload.ttlMs,
            payload.ownerId
          );
          const resEnv = createEnvelope<LeaseAcquireResponsePayload>(
            "LEASE_ACQUIRE_RESPONSE",
            namespace,
            {
              leaseName: payload.leaseName,
              acquired: result.acquired,
              fencingToken: result.fencingToken,
              expiresAt: result.expiresAt,
              currentOwner: result.currentOwner,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "LEASE_RENEW": {
          const payload = envelope.payload as LeaseRenewPayload;
          const result = this.leaseRenew(
            namespace,
            payload.leaseName,
            payload.fencingToken,
            payload.ttlMs
          );
          const resEnv = createEnvelope<LeaseRenewResponsePayload>(
            "LEASE_RENEW_RESPONSE",
            namespace,
            {
              leaseName: payload.leaseName,
              renewed: result.renewed,
              expiresAt: result.expiresAt,
              fencingToken: result.fencingToken,
              error: result.error,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "LEASE_RELEASE": {
          const payload = envelope.payload as LeaseReleasePayload;
          const result = this.leaseRelease(
            namespace,
            payload.leaseName,
            payload.fencingToken
          );
          const resEnv = createEnvelope<LeaseReleaseResponsePayload>(
            "LEASE_RELEASE_RESPONSE",
            namespace,
            {
              leaseName: payload.leaseName,
              released: result.released,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "QUEUE_PUBLISH": {
          const payload = envelope.payload as QueuePublishPayload;
          const result = this.queuePublish(
            namespace,
            payload.queueName,
            payload.payload,
            payload.options
          );
          const resEnv = createEnvelope<QueuePublishResponsePayload>(
            "QUEUE_PUBLISH_RESPONSE",
            namespace,
            {
              queueName: payload.queueName,
              messageId: result.messageId,
              success: true,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "QUEUE_RESERVE": {
          const payload = envelope.payload as QueueReservePayload;
          const messages = this.queueReserve(
            namespace,
            payload.queueName,
            payload.visibilityTimeoutMs,
            payload.maxMessages
          );
          const resEnv = createEnvelope<QueueReserveResponsePayload>(
            "QUEUE_RESERVE_RESPONSE",
            namespace,
            {
              queueName: payload.queueName,
              messages,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "QUEUE_ACK": {
          const payload = envelope.payload as QueueAckPayload;
          const acked = this.queueAck(namespace, payload.queueName, payload.messageId);
          const resEnv = createEnvelope<QueueAckResponsePayload>(
            "QUEUE_ACK_RESPONSE",
            namespace,
            {
              queueName: payload.queueName,
              messageId: payload.messageId,
              acked,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        case "QUEUE_NACK": {
          const payload = envelope.payload as QueueNackPayload;
          const nacked = this.queueNack(namespace, payload.queueName, payload.messageId);
          const resEnv = createEnvelope<QueueNackResponsePayload>(
            "QUEUE_NACK_RESPONSE",
            namespace,
            {
              queueName: payload.queueName,
              messageId: payload.messageId,
              nacked,
            },
            envelope.id
          );
          socket.write(encodeFrame(resEnv));
          break;
        }

        default: {
          const errEnv = createEnvelope<KvErrorPayload>(
            "KV_ERROR",
            namespace,
            {
              error: `Unsupported hub operation type: ${envelope.type}`,
              code: "UNKNOWN_OPERATION",
            },
            envelope.id
          );
          socket.write(encodeFrame(errEnv));
          break;
        }
      }
    } catch (err) {
      const errEnv = createEnvelope<KvErrorPayload>(
        "KV_ERROR",
        namespace,
        {
          error: (err as Error).message,
          code: (err as Error & { code?: string }).code || "OPERATION_FAILED",
        },
        envelope.id
      );
      try {
        socket.write(encodeFrame(errEnv));
      } catch {}
    }
  }
}
