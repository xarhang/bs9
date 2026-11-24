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
import { existsSync, lstatSync, unlinkSync, chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
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
import {
  ClusterCoordinator,
  type HubClusterOptions,
  type ClusterStatusInfo,
} from "./membership.js";
import type { ReplLogEntry } from "./protocol.js";
import type { SnapshotData } from "./wal.js";

export interface HubServerOptions extends KvEngineOptions, WalManagerOptions {
  socketPath?: string;
  authToken?: string;
  authTokenFile?: string;
  handshakeTimeoutMs?: number;
  allowAnonymous?: boolean;
  autoRecover?: boolean;
  /** Optional multi-host Raft-lite cluster replication options (opt-in). */
  cluster?: HubClusterOptions;
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
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${field} must be a finite number greater than 0`);
  }
}

function assertRequiredFiniteDuration(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite number greater than 0`);
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
  public readonly cluster: ClusterCoordinator | null = null;

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

    if (options.cluster) {
      this.cluster = new ClusterCoordinator(
        {
          ...options.cluster,
          stateDir: options.cluster.stateDir ?? options.stateDir,
        },
        {
          onApplyCommittedEntry: (entry) => this.applyReplicatedEntry(entry),
          onExportAllSnapshots: () => this.exportAllNamespaceSnapshots(),
          onInstallAllSnapshots: (namespaces) => this.installAllNamespaceSnapshots(namespaces),
          onExecuteForwardedWrite: (env) => this.executeReplicatedEnvelopeOnLeader(env),
        }
      );
    }
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
    const isPosix = platformInfo.isLinux || platformInfo.isMacOS;
    if (isPosix) {
      ensurePrivateDirectory(platformInfo.runtimeDir);
      ensurePrivateDirectory(tokensDir);
    } else if (!existsSync(tokensDir)) {
      mkdirSync(tokensDir, { recursive: true });
    }

    const tokenFilePath = join(tokensDir, `${namespace}.token`);
    if (isPosix) writePrivateFile(tokenFilePath, token);
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
    const isPosix = platformInfo.isLinux || platformInfo.isMacOS;

    // Check cluster/runtime token file
    if (isPosix) {
      ensurePrivateDirectory(platformInfo.runtimeDir);
      const tokensDir = join(platformInfo.runtimeDir, "tokens");
      if (existsSync(tokensDir)) ensurePrivateDirectory(tokensDir);
    }
    const tokenFilePath = join(platformInfo.runtimeDir, "tokens", `${namespace}.token`);
    if (existsSync(tokenFilePath)) {
      try {
        if (isPosix) {
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
          if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, namespace) && parsed[namespace]) {
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

  public getClusterStatus(): ClusterStatusInfo | null {
    return this.cluster ? this.cluster.getStatus() : null;
  }

  /**
   * Starts the Hub service listening on UDS / Named Pipe (and optional PeerTransport if cluster mode is enabled).
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

    // Clean up stale Unix domain socket (including dangling symlinks)
    if (!platformInfo.isWindows) {
      try {
        lstatSync(this.socketPath);
        unlinkSync(this.socketPath);
      } catch {}
    }

    await new Promise<void>((resolve, reject) => {
      const srv = createServer((socket: Socket) => {
        this.handleClientConnection(socket);
      });
      this.server = srv;

      const onListenError = (err: Error) => {
        if (this.server === srv) {
          this.server = null;
        }
        reject(err);
      };
      srv.once("error", onListenError);

      srv.listen(this.socketPath, () => {
        srv.off("error", onListenError);
        if (!platformInfo.isWindows) {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {}
        }
        this.emit("listening", this.socketPath);
        resolve();
      });
    });

    if (this.cluster) {
      await this.cluster.start();
    }
  }

  /**
   * Stops the Hub service and disconnects clients.
   */
  public async stop(): Promise<void> {
    if (this.cluster) {
      await this.cluster.stop().catch(() => {});
    }
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
    if (typeof leaseName !== "string" || leaseName.length === 0) {
      throw new Error("leaseName must be a non-empty string");
    }
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw new Error("ownerId must be a non-empty string");
    }
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
    if (typeof leaseName !== "string" || leaseName.length === 0) {
      throw new Error("leaseName must be a non-empty string");
    }
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
    if (this.activeSockets.size >= 1024) {
      socket.destroy();
      return;
    }
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
            const namespace = typeof payload?.namespace === "string" && payload.namespace ? payload.namespace : "default";

            let authSuccess = false;

            if (!isValidNamespace(namespace)) {
              authSuccess = false;
            } else if (this.allowAnonymous) {
              authSuccess = true;
            } else {
              const expectedToken = this.getNamespaceToken(namespace);
              if (expectedToken) {
                if (payload.hmac && verifyHmac(nonce, expectedToken, payload.hmac)) {
                  authSuccess = true;
                } else if ((payload as any).token) {
                  const clientDigest = createHash("sha256").update(String((payload as any).token)).digest();
                  const expectedDigest = createHash("sha256").update(expectedToken).digest();
                  if (timingSafeEqual(clientDigest, expectedDigest)) {
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

    if (this.cluster) {
      this.handleClusterAuthenticatedEnvelope(socket, namespace, envelope);
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

  // --- Multi-Host Cluster Replication Methods (Opt-in) ---

  private handleClusterAuthenticatedEnvelope(
    socket: Socket,
    namespace: string,
    envelope: Bs9Envelope
  ): void {
    const boundEnv: Bs9Envelope = { ...envelope, namespace };

    // Local fast-path for KV_GET unless linearizable consistency is requested
    if (boundEnv.type === "KV_GET") {
      const payload = boundEnv.payload as KvGetPayload & { consistency?: "local" | "linearizable" };
      if (payload?.consistency !== "linearizable" || this.cluster!.isLeader()) {
        try {
          const value = this.get(namespace, payload.key);
          const resEnv = createEnvelope<KvGetResponsePayload>(
            "KV_GET_RESPONSE",
            namespace,
            { key: payload.key, found: value !== null, value },
            boundEnv.id
          );
          socket.write(encodeFrame(resEnv));
        } catch (err) {
          const errEnv = createEnvelope<KvErrorPayload>(
            "KV_ERROR",
            namespace,
            { error: (err as Error).message, code: "OPERATION_FAILED" },
            boundEnv.id
          );
          socket.write(encodeFrame(errEnv));
        }
        return;
      }
    }

    if (boundEnv.type === "KV_SNAPSHOT") {
      try {
        const snapshotPath = this.snapshot(namespace);
        const resEnv = createEnvelope<KvSnapshotResponsePayload>(
          "KV_SNAPSHOT_RESPONSE",
          namespace,
          { success: true, snapshotPath, timestamp: Date.now() },
          boundEnv.id
        );
        socket.write(encodeFrame(resEnv));
      } catch (err) {
        const errEnv = createEnvelope<KvErrorPayload>(
          "KV_ERROR",
          namespace,
          { error: (err as Error).message, code: "OPERATION_FAILED" },
          boundEnv.id
        );
        socket.write(encodeFrame(errEnv));
      }
      return;
    }

    const promise = this.cluster!.isLeader()
      ? this.executeReplicatedEnvelopeOnLeader(boundEnv)
      : this.cluster!.forwardWriteToLeader(boundEnv);

    promise
      .then((resEnv) => {
        try {
          socket.write(encodeFrame(resEnv));
        } catch {}
      })
      .catch((err: Error) => {
        const errEnv = createEnvelope<KvErrorPayload>(
          "KV_ERROR",
          namespace,
          {
            error: err.message,
            code: (err as Error & { code?: string }).code || "CLUSTER_OPERATION_FAILED",
          },
          boundEnv.id
        );
        try {
          socket.write(encodeFrame(errEnv));
        } catch {}
      });
  }

  private async proposeAndCommitWalRecord(
    namespace: string,
    record: Omit<WalRecord, "seq" | "timestamp"> & { timestamp?: number }
  ): Promise<WalRecord> {
    const seq = this.wal.peekNextSeq(namespace);
    const timestamp = record.timestamp ?? Date.now();
    const term = this.cluster ? this.cluster.getTerm() : undefined;
    const walRecord = {
      ...record,
      seq,
      timestamp,
      ...(term !== undefined ? { term } : {}),
    } as WalRecord;

    if (this.cluster) {
      const entry = await this.cluster.proposeRecord(namespace, walRecord);
      walRecord.replIndex = entry.index;
      walRecord.term = entry.term;
      return walRecord;
    }

    if (
      walRecord.op === "queue_publish" ||
      walRecord.op === "queue_ack" ||
      walRecord.op === "queue_nack"
    ) {
      this.wal.appendQueueRecord(namespace, walRecord, {
        engine: this.engine,
        leases: this.leases,
        queues: this.queues,
      });
    } else {
      this.wal.appendWithSnapshot(namespace, walRecord, {
        engine: this.engine,
        leases: this.leases,
        queues: this.queues,
      });
    }
    return walRecord;
  }

  private async executeReplicatedEnvelopeOnLeader(envelope: Bs9Envelope<any>): Promise<Bs9Envelope<any>> {
    const namespace = envelope.namespace || "default";
    this.ensureRecovered(namespace);

    switch (envelope.type) {
      case "KV_GET": {
        const payload = envelope.payload as KvGetPayload;
        const value = this.engine.get(namespace, payload.key);
        return createEnvelope<KvGetResponsePayload>(
          "KV_GET_RESPONSE",
          namespace,
          { key: payload.key, found: value !== null, value },
          envelope.id
        );
      }

      case "KV_SET": {
        const payload = envelope.payload as KvSetPayload;
        assertFiniteDuration(payload.ttlMs, "TTL");
        const durableValue = this.preflightSet(namespace, payload.key, payload.value);
        await this.proposeAndCommitWalRecord(namespace, {
          op: "set",
          key: payload.key,
          value: durableValue,
          ttlMs: payload.ttlMs,
        });
        this.engine.set(namespace, payload.key, durableValue, payload.ttlMs);
        return createEnvelope<KvSetResponsePayload>(
          "KV_SET_RESPONSE",
          namespace,
          { key: payload.key, success: true },
          envelope.id
        );
      }

      case "KV_DELETE": {
        const payload = envelope.payload as KvDeletePayload;
        if (typeof payload.key !== "string") throw new Error("KV key must be a string");
        await this.proposeAndCommitWalRecord(namespace, {
          op: "del",
          key: payload.key,
        });
        const deleted = this.engine.delete(namespace, payload.key);
        return createEnvelope<KvDeleteResponsePayload>(
          "KV_DELETE_RESPONSE",
          namespace,
          { key: payload.key, deleted },
          envelope.id
        );
      }

      case "KV_INCR": {
        const payload = envelope.payload as KvIncrPayload;
        const delta = typeof payload.delta === "number" ? payload.delta : 1;
        if (typeof payload.key !== "string") throw new Error("KV key must be a string");
        if (!Number.isFinite(delta)) throw new Error("Increment delta must be a finite number");
        const current = this.getLogicalValue(namespace, payload.key);
        if (current !== null && current !== undefined && typeof current !== "number") {
          throw new Error(`Cannot increment key "${payload.key}": existing value is not a numeric value`);
        }
        const nextVal = current === null || current === undefined ? delta : current + delta;
        if (!Number.isFinite(nextVal)) throw new Error("Increment result must be a finite number");
        this.preflightSet(namespace, payload.key, nextVal);
        await this.proposeAndCommitWalRecord(namespace, {
          op: "incr",
          key: payload.key,
          delta,
        });
        const value = this.engine.incr(namespace, payload.key, delta);
        return createEnvelope<KvIncrResponsePayload>(
          "KV_INCR_RESPONSE",
          namespace,
          { key: payload.key, value, success: true },
          envelope.id
        );
      }

      case "KV_CAS": {
        const payload = envelope.payload as KvCasPayload;
        assertFiniteDuration(payload.ttlMs, "TTL");
        if (typeof payload.key !== "string") throw new Error("KV key must be a string");
        const durableExpected = this.canonicalizeValue(payload.expectedValue);
        const durableNewValue = this.canonicalizeValue(payload.newValue);
        const current = this.getLogicalValue(namespace, payload.key);
        if (!isDeepEqual(current, durableExpected)) {
          return createEnvelope<KvCasResponsePayload>(
            "KV_CAS_RESPONSE",
            namespace,
            { key: payload.key, success: false, currentValue: current },
            envelope.id
          );
        }
        this.preflightSet(namespace, payload.key, durableNewValue);
        await this.proposeAndCommitWalRecord(namespace, {
          op: "cas",
          key: payload.key,
          expectedValue: durableExpected,
          newValue: durableNewValue,
          ttlMs: payload.ttlMs,
        });
        const casResult = this.engine.cas(
          namespace,
          payload.key,
          durableExpected,
          durableNewValue,
          payload.ttlMs
        );
        return createEnvelope<KvCasResponsePayload>(
          "KV_CAS_RESPONSE",
          namespace,
          { key: payload.key, success: casResult.success, currentValue: casResult.currentValue },
          envelope.id
        );
      }

      case "LEASE_ACQUIRE": {
        const payload = envelope.payload as LeaseAcquirePayload;
        if (typeof payload.leaseName !== "string" || payload.leaseName.length === 0) {
          throw new Error("leaseName must be a non-empty string");
        }
        if (typeof payload.ownerId !== "string" || payload.ownerId.length === 0) {
          throw new Error("ownerId must be a non-empty string");
        }
        assertRequiredFiniteDuration(payload.ttlMs, "Lease TTL");
        const existing = this.leases.get(namespace, payload.leaseName);
        if (existing) {
          const res = this.leases.acquire(namespace, payload.leaseName, payload.ttlMs, payload.ownerId);
          return createEnvelope<LeaseAcquireResponsePayload>(
            "LEASE_ACQUIRE_RESPONSE",
            namespace,
            {
              leaseName: payload.leaseName,
              acquired: res.acquired,
              fencingToken: res.fencingToken,
              expiresAt: res.expiresAt,
              currentOwner: res.currentOwner,
            },
            envelope.id
          );
        }
        const timestamp = Date.now();
        const currentToken = this.leases.getCurrentFencingToken(namespace, payload.leaseName);
        const localBase = (currentToken % 0x80000000) + 1;
        const fencingToken = this.cluster
          ? Math.max(currentToken + 1, this.cluster.computeFencingToken(localBase))
          : currentToken + 1;
        const expiresAt = timestamp + payload.ttlMs;
        await this.proposeAndCommitWalRecord(namespace, {
          op: "lease_acquire",
          leaseName: payload.leaseName,
          ownerId: payload.ownerId,
          fencingToken,
          expiresAt,
          ttlMs: payload.ttlMs,
          timestamp,
        });
        this.leases.applyAcquire(namespace, payload.leaseName, payload.ownerId, fencingToken, expiresAt, timestamp);
        this.syncLeaseProjection(namespace, payload.leaseName, fencingToken, payload.ttlMs);
        return createEnvelope<LeaseAcquireResponsePayload>(
          "LEASE_ACQUIRE_RESPONSE",
          namespace,
          {
            leaseName: payload.leaseName,
            acquired: true,
            fencingToken,
            expiresAt,
            currentOwner: payload.ownerId,
          },
          envelope.id
        );
      }

      case "LEASE_RENEW": {
        const payload = envelope.payload as LeaseRenewPayload;
        if (typeof payload.leaseName !== "string" || payload.leaseName.length === 0) {
          throw new Error("leaseName must be a non-empty string");
        }
        assertRequiredFiniteDuration(payload.ttlMs, "Lease TTL");
        const existing = this.leases.exportState(namespace)[payload.leaseName]?.record;
        if (!existing || existing.fencingToken !== payload.fencingToken) {
          const failed = this.leases.renew(namespace, payload.leaseName, payload.fencingToken, payload.ttlMs);
          return createEnvelope<LeaseRenewResponsePayload>(
            "LEASE_RENEW_RESPONSE",
            namespace,
            {
              leaseName: payload.leaseName,
              renewed: failed.renewed,
              expiresAt: failed.expiresAt,
              fencingToken: failed.fencingToken,
              error: failed.error,
            },
            envelope.id
          );
        }
        const timestamp = Date.now();
        const expiresAt = timestamp + payload.ttlMs;
        await this.proposeAndCommitWalRecord(namespace, {
          op: "lease_renew",
          leaseName: payload.leaseName,
          fencingToken: payload.fencingToken,
          expiresAt,
          ttlMs: payload.ttlMs,
          timestamp,
        });
        this.leases.applyRenew(namespace, payload.leaseName, payload.fencingToken, expiresAt);
        this.syncLeaseProjection(namespace, payload.leaseName, payload.fencingToken, payload.ttlMs);
        return createEnvelope<LeaseRenewResponsePayload>(
          "LEASE_RENEW_RESPONSE",
          namespace,
          {
            leaseName: payload.leaseName,
            renewed: true,
            expiresAt,
            fencingToken: payload.fencingToken,
          },
          envelope.id
        );
      }

      case "LEASE_RELEASE": {
        const payload = envelope.payload as LeaseReleasePayload;
        const existing = this.leases.exportState(namespace)[payload.leaseName]?.record;
        if (!existing || existing.fencingToken !== payload.fencingToken) {
          return createEnvelope<LeaseReleaseResponsePayload>(
            "LEASE_RELEASE_RESPONSE",
            namespace,
            { leaseName: payload.leaseName, released: false },
            envelope.id
          );
        }
        await this.proposeAndCommitWalRecord(namespace, {
          op: "lease_release",
          leaseName: payload.leaseName,
          fencingToken: payload.fencingToken,
        });
        this.leases.applyRelease(namespace, payload.leaseName, payload.fencingToken);
        this.engine.delete(namespace, `__bs9_lease:${payload.leaseName}`);
        return createEnvelope<LeaseReleaseResponsePayload>(
          "LEASE_RELEASE_RESPONSE",
          namespace,
          { leaseName: payload.leaseName, released: true },
          envelope.id
        );
      }

      case "QUEUE_PUBLISH": {
        const payload = envelope.payload as QueuePublishPayload;
        const prepared = this.queues.preparePublish(namespace, payload.queueName, payload.payload, payload.options);
        await this.proposeAndCommitWalRecord(namespace, {
          op: "queue_publish",
          queueName: payload.queueName,
          messageId: prepared.message.id,
          payload: prepared.message.payload,
          options: prepared.message.options,
          createdAt: prepared.message.createdAt,
        });
        const result = this.queues.publishPrepared(namespace, payload.queueName, prepared);
        this.syncQueueToEngine(namespace, payload.queueName);
        return createEnvelope<QueuePublishResponsePayload>(
          "QUEUE_PUBLISH_RESPONSE",
          namespace,
          { queueName: payload.queueName, messageId: result.messageId, success: true },
          envelope.id
        );
      }

      case "QUEUE_RESERVE": {
        const payload = envelope.payload as QueueReservePayload;
        const messages = this.queueReserve(
          namespace,
          payload.queueName,
          payload.visibilityTimeoutMs,
          payload.maxMessages
        );
        return createEnvelope<QueueReserveResponsePayload>(
          "QUEUE_RESERVE_RESPONSE",
          namespace,
          { queueName: payload.queueName, messages },
          envelope.id
        );
      }

      case "QUEUE_ACK": {
        const payload = envelope.payload as QueueAckPayload;
        if (!this.queues.hasMessage(namespace, payload.queueName, payload.messageId)) {
          return createEnvelope<QueueAckResponsePayload>(
            "QUEUE_ACK_RESPONSE",
            namespace,
            { queueName: payload.queueName, messageId: payload.messageId, acked: false },
            envelope.id
          );
        }
        await this.proposeAndCommitWalRecord(namespace, {
          op: "queue_ack",
          queueName: payload.queueName,
          messageId: payload.messageId,
        });
        const acked = this.queues.ack(namespace, payload.queueName, payload.messageId);
        if (acked) this.syncQueueToEngine(namespace, payload.queueName);
        return createEnvelope<QueueAckResponsePayload>(
          "QUEUE_ACK_RESPONSE",
          namespace,
          { queueName: payload.queueName, messageId: payload.messageId, acked },
          envelope.id
        );
      }

      case "QUEUE_NACK": {
        const payload = envelope.payload as QueueNackPayload;
        if (!this.queues.hasMessage(namespace, payload.queueName, payload.messageId)) {
          return createEnvelope<QueueNackResponsePayload>(
            "QUEUE_NACK_RESPONSE",
            namespace,
            { queueName: payload.queueName, messageId: payload.messageId, nacked: false },
            envelope.id
          );
        }
        await this.proposeAndCommitWalRecord(namespace, {
          op: "queue_nack",
          queueName: payload.queueName,
          messageId: payload.messageId,
        });
        const nacked = this.queues.nack(namespace, payload.queueName, payload.messageId);
        return createEnvelope<QueueNackResponsePayload>(
          "QUEUE_NACK_RESPONSE",
          namespace,
          { queueName: payload.queueName, messageId: payload.messageId, nacked },
          envelope.id
        );
      }

      default:
        throw new Error(`Unsupported hub operation type: ${envelope.type}`);
    }
  }

  private applyReplicatedEntry(entry: ReplLogEntry): void {
    const namespace = entry.namespace;
    this.ensureRecovered(namespace);
    const incoming = entry.record as WalRecord;
    const localRecord: WalRecord = {
      ...incoming,
      seq: incoming.seq || 1,
      term: entry.term,
      replIndex: entry.index,
    };

    this.wal.applyRecord(this.engine, this.leases, this.queues, namespace, localRecord);
    this.reconcileCompatibilityProjections(namespace);
  }

  private exportAllNamespaceSnapshots(): Record<string, SnapshotData> {
    const allNamespaces = new Set<string>([
      ...this.recoveredNamespaces,
      ...this.wal.listNamespacesOnDisk(),
    ]);
    const out: Record<string, SnapshotData> = {};
    for (const ns of allNamespaces) {
      try {
        this.ensureRecovered(ns);
      } catch {
        continue;
      }
      out[ns] = {
        version: 1,
        namespace: ns,
        lastWalSeq: this.wal.getCurrentSeq(ns),
        timestamp: Date.now(),
        entries: this.engine.exportState(ns),
        leases: this.leases.exportState(ns),
        queues: this.queues.exportState(ns),
      };
    }
    return out;
  }

  private installAllNamespaceSnapshots(namespaces: Record<string, SnapshotData>): void {
    for (const [ns, snap] of Object.entries(namespaces)) {
      if (!isValidNamespace(ns) || !snap) continue;
      this.engine.importState(ns, snap.entries ?? {});
      if (snap.leases) this.leases.importState(ns, snap.leases);
      if (snap.queues) this.queues.importState(ns, snap.queues);
      this.reconcileCompatibilityProjections(ns);
      this.recoveredNamespaces.add(ns);
      try {
        this.wal.createSnapshot(ns, this.engine, this.leases, this.queues);
      } catch {}
    }
  }
}
