/**
 * BS9 - Write-Ahead Log (WAL) & Snapshot Persistence Manager
 *
 * Implements:
 * - Append-only WAL file: wal.log with length-prefixed records and CRC32 checksums.
 * - Atomic snapshot generation: temp file -> fsync -> atomic rename to snapshot.json.
 * - Recovery on Hub start: loads snapshot.json, replays subsequent valid WAL records,
 *   and safely truncates corrupted or partial trailing bytes.
 *
 * Directory layout: <stateDir>/hub-data/<namespace>/
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, mkdirSync, openSync, readSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, readdirSync, fchmodSync, fstatSync, statSync, ftruncateSync, unlinkSync, rmdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { getPlatformInfo } from "../platform/detect.js";
import { MAX_FRAME_SIZE, MAX_NAMESPACE_MEMORY } from "./protocol.js";
import { estimateValueSize, validateSafeData, type KvEngine, type KvEntry } from "./engine.js";
import type { LeaseManager, LeaseSnapshotState } from "./leases.js";
import type { QueueManager, QueueMessage } from "./queues.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";

export type WalOp =
  | "set"
  | "del"
  | "incr"
  | "cas"
  | "lease_acquire"
  | "lease_renew"
  | "lease_release"
  | "queue_publish"
  | "queue_ack"
  | "queue_nack";

export interface WalRecord {
  seq: number;
  op: WalOp;
  key?: string;
  value?: any;
  ttlMs?: number;
  delta?: number;
  expectedValue?: any;
  newValue?: any;
  timestamp: number;

  // Lease fields
  leaseName?: string;
  ownerId?: string;
  fencingToken?: number;
  expiresAt?: number;

  // Queue fields
  queueName?: string;
  messageId?: string;
  payload?: any;
  options?: Record<string, any>;
  createdAt?: number;
}

export interface SnapshotData {
  version: 1;
  namespace: string;
  lastWalSeq: number;
  timestamp: number;
  entries: Record<string, KvEntry>;
  leases?: Record<string, LeaseSnapshotState>;
  queues?: Record<string, QueueMessage[]>;
}

export interface RecoveryResult {
  snapshotLoaded: boolean;
  entriesFromSnapshot: number;
  replayedWalRecords: number;
  truncatedBytes: number;
}

export interface WalManagerOptions {
  stateDir?: string;
  /** Maximum append-only WAL size per namespace. Defaults to the documented 100 MiB namespace budget. */
  maxWalBytes?: number;
}

// Keep WAL growth within the Hub's existing 100 MiB per-namespace budget.
export const MAX_NAMESPACE_WAL_BYTES = MAX_NAMESPACE_MEMORY;

export interface QueueWalSnapshotSources {
  engine: KvEngine;
  leases?: LeaseManager;
  queues?: QueueManager;
}

export class WalManager {
  private stateDir: string;
  private baseDataDir: string;
  private maxWalBytes: number;
  private namespaceFd: Map<string, number> = new Map();
  private namespaceSeq: Map<string, number> = new Map();
  private writeBlockedNamespaces: Set<string> = new Set();
  private recoveryBlockedNamespaces: Set<string> = new Set();

  constructor(options: WalManagerOptions = {}) {
    const stateDir = options.stateDir || getPlatformInfo().stateDir;
    this.stateDir = stateDir;
    this.baseDataDir = join(stateDir, "hub-data");
    this.maxWalBytes = options.maxWalBytes ?? MAX_NAMESPACE_WAL_BYTES;
    if (!Number.isSafeInteger(this.maxWalBytes) || this.maxWalBytes <= 0) {
      throw new RangeError("maxWalBytes must be a positive safe integer");
    }
  }

  public getNamespaceDir(namespace: string): string {
    // Keep legacy paths for the injective subset. Encode dots, underscores, and
    // all other characters because the old sanitizer collapsed them to "_".
    const safeNamespace = /^[a-zA-Z0-9-]+$/.test(namespace)
      ? namespace
      : `~${Buffer.from(namespace, "utf-8").toString("hex")}`;
    return join(this.baseDataDir, safeNamespace);
  }

  private getLegacyNamespaceDir(namespace: string): string {
    return join(this.baseDataDir, namespace.replace(/[^a-zA-Z0-9_-]/g, "_"));
  }

  public getWalPath(namespace: string): string {
    return join(this.getNamespaceDir(namespace), "wal.log");
  }

  public getSnapshotPath(namespace: string): string {
    return join(this.getNamespaceDir(namespace), "snapshot.json");
  }

  public getNextSeq(namespace: string): number {
    const current = this.namespaceSeq.get(namespace) || 0;
    const next = current + 1;
    this.namespaceSeq.set(namespace, next);
    return next;
  }

  /** Returns the next sequence without reserving it before a durable append. */
  public peekNextSeq(namespace: string): number {
    return (this.namespaceSeq.get(namespace) || 0) + 1;
  }

  public getCurrentSeq(namespace: string): number {
    return this.namespaceSeq.get(namespace) || 0;
  }

  public listNamespacesOnDisk(): string[] {
    if (!existsSync(this.baseDataDir)) return [];
    if (process.platform === "linux") {
      ensurePrivateDirectory(this.stateDir);
      ensurePrivateDirectory(this.baseDataDir);
    }
    let entries;
    try {
      entries = readdirSync(this.baseDataDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const namespaces = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = join(this.baseDataDir, entry.name);
      if (process.platform === "linux") {
        ensurePrivateDirectory(entryDir);
        for (const filename of ["snapshot.json", "wal.log"]) {
          const filePath = join(entryDir, filename);
          if (existsSync(filePath)) securePrivateFile(filePath);
        }
      }
      try {
        if (this.isMigrationTempDirectory(entry.name)) continue;
        if (entry.name.startsWith("~")) {
          const encoded = entry.name.slice(1);
          if (/^(?:[0-9a-f]{2})+$/i.test(encoded)) {
            const namespace = Buffer.from(encoded, "hex").toString("utf-8");
            if (`~${Buffer.from(namespace, "utf-8").toString("hex")}` === entry.name) {
              namespaces.add(namespace);
              continue;
            }
          }
          if (existsSync(join(this.baseDataDir, entry.name, "wal.log")) ||
              existsSync(join(this.baseDataDir, entry.name, "snapshot.json"))) {
            throw this.namespaceAliasError(entry.name, "invalid encoded namespace directory");
          }
          continue;
        }

        const legacyDir = join(this.baseDataDir, entry.name);
        const snapshotPath = join(legacyDir, "snapshot.json");
        const walPath = join(legacyDir, "wal.log");
        const hasSnapshot = existsSync(snapshotPath);
        const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
        if (!hasSnapshot && walBytes === 0) continue;

        if (!entry.name.includes("_")) {
          // These names were mapped injectively by the old path sanitizer.
          namespaces.add(entry.name);
          continue;
        }

        // An underscore directory may represent an old dotted name. Only the
        // snapshot's namespace field can prove ownership; a WAL-only legacy
        // directory is ambiguous and must not be replayed into the wrong tenant.
        if (!hasSnapshot) {
          throw this.namespaceAliasError(entry.name, "legacy WAL has no identifying snapshot");
        }
        const snapshot = this.readSnapshotIdentity(snapshotPath);
        if (!snapshot || this.getLegacyNamespaceDir(snapshot.namespace) !== legacyDir) {
          throw this.namespaceAliasError(entry.name, "legacy snapshot does not prove namespace ownership");
        }
        this.ensureLegacySnapshotCopied(snapshot.namespace, snapshotPath, walBytes);
        namespaces.add(snapshot.namespace);
      } catch (error) {
        if ((error as Error & { code?: string }).code !== "LEGACY_NAMESPACE_PATH_AMBIGUOUS") {
          throw error;
        }
        // Keep the Hub available for unaffected namespaces. Recovery of this
        // legacy namespace will still fail closed in ensureLegacyNamespaceSafe
        // until an operator resolves its aliased WAL state.
        console.warn(`[WalManager] Skipping ambiguous legacy namespace directory '${entry.name}': ${(error as Error).message}`);
      }
    }
    return [...namespaces];
  }

  private isMigrationTempDirectory(name: string): boolean {
    const match = /^~((?:[0-9a-f]{2})+)\.migrate\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(name);
    if (!match) return false;
    const namespace = Buffer.from(match[1], "hex").toString("utf-8");
    return `~${Buffer.from(namespace, "utf-8").toString("hex")}` === `~${match[1].toLowerCase()}` &&
      this.getNamespaceDir(namespace) === join(this.baseDataDir, `~${match[1].toLowerCase()}`);
  }

  private namespaceAliasError(namespaceOrPath: string, reason: string): Error & { code: string } {
    const error = new Error(
      `[LEGACY_NAMESPACE_PATH_AMBIGUOUS] Cannot safely recover legacy Hub data at "${namespaceOrPath}": ${reason}`
    ) as Error & { code: string };
    error.code = "LEGACY_NAMESPACE_PATH_AMBIGUOUS";
    return error;
  }

  private readSnapshotIdentity(snapshotPath: string): SnapshotData | null {
    try {
      if (process.platform === "linux") securePrivateFile(snapshotPath);
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as SnapshotData;
      return snapshot && snapshot.version === 1 && typeof snapshot.namespace === "string"
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }

  /** Validate every persisted component before any live manager is mutated. */
  private validateSnapshotData(
    snapshot: SnapshotData,
    queues?: QueueManager
  ): void {
    if (!Number.isSafeInteger(snapshot.lastWalSeq) || snapshot.lastWalSeq < 0) {
      throw new Error("snapshot lastWalSeq must be a non-negative safe integer");
    }
    if (!snapshot.entries || typeof snapshot.entries !== "object" || Array.isArray(snapshot.entries)) {
      throw new Error("snapshot entries must be an object");
    }
    for (const entry of Object.values(snapshot.entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("snapshot contains an invalid KV entry");
      }
      if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) ||
          typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt) ||
          (entry.expiresAt !== undefined && !Number.isFinite(entry.expiresAt))) {
        throw new Error("snapshot contains invalid KV entry timestamps");
      }
      // Import computes this value again; preflight catches JSON shapes that
      // would throw before engine state is cleared or partially imported.
      validateSafeData(entry.value);
      estimateValueSize(entry.value);
    }

    if (snapshot.leases !== undefined) {
      if (!snapshot.leases || typeof snapshot.leases !== "object" || Array.isArray(snapshot.leases)) {
        throw new Error("snapshot leases must be an object");
      }
      for (const state of Object.values(snapshot.leases)) {
        if (!state || typeof state !== "object" || Array.isArray(state)) {
          throw new Error("snapshot contains an invalid lease entry");
        }
      }
    }

    if (queues && snapshot.queues !== undefined) {
      queues.validateImportState(snapshot.queues);
    }
  }

  /**
   * Copies a snapshot-confirmed legacy namespace into its injective path only
   * when its legacy WAL is empty. WAL records do not identify their namespace,
   * so a non-empty log may contain interleaved records from a sanitized alias.
   * The colliding legacy directory is intentionally left untouched.
   */
  private ensureLegacySnapshotCopied(
    namespace: string,
    legacySnapshotPath: string,
    walBytes: number
  ): void {
    const snapshot = this.readSnapshotIdentity(legacySnapshotPath);
    if (!snapshot || snapshot.namespace !== namespace || walBytes > 0) {
      throw this.namespaceAliasError(
        namespace,
        "the snapshot must identify this namespace and its legacy WAL must be empty; WAL records have no namespace marker, so back up and resolve this directory before recovery"
      );
    }

    const targetDir = this.getNamespaceDir(namespace);
    const targetSnapshotPath = join(targetDir, "snapshot.json");
    if (existsSync(targetDir)) {
      // Existing state in the new location wins only when it identifies itself.
      const targetSnapshot = existsSync(targetSnapshotPath)
        ? this.readSnapshotIdentity(targetSnapshotPath)
        : null;
      if (targetSnapshot && targetSnapshot.namespace === namespace) return;
      throw this.namespaceAliasError(namespace, "destination already contains unverifiable state");
    }

    const temporaryDir = `${targetDir}.migrate.${randomUUID()}`;
    const temporarySnapshotPath = join(temporaryDir, "snapshot.json");
    try {
      this.ensureDir(temporaryDir);
      copyFileSync(legacySnapshotPath, temporarySnapshotPath);
      if (process.platform === "linux") securePrivateFile(temporarySnapshotPath);
      const snapshotFd = openSync(temporarySnapshotPath, "r+");
      try { fsyncSync(snapshotFd); } finally { closeSync(snapshotFd); }
      renameSync(temporaryDir, targetDir);
    } catch (err) {
      try { unlinkSync(temporarySnapshotPath); } catch {}
      try { rmdirSync(temporaryDir); } catch {}
      throw err;
    }
  }

  private ensureLegacyNamespaceSafe(namespace: string): void {
    const targetDir = this.getNamespaceDir(namespace);
    const legacyDir = this.getLegacyNamespaceDir(namespace);
    if (targetDir === legacyDir || !existsSync(legacyDir)) return;

    if (process.platform === "linux") {
      ensurePrivateDirectory(this.stateDir);
      ensurePrivateDirectory(this.baseDataDir);
      ensurePrivateDirectory(legacyDir);
    }

    const legacySnapshotPath = join(legacyDir, "snapshot.json");
    const legacyWalPath = join(legacyDir, "wal.log");
    if (process.platform === "linux") {
      if (existsSync(legacySnapshotPath)) securePrivateFile(legacySnapshotPath);
      if (existsSync(legacyWalPath)) securePrivateFile(legacyWalPath);
    }
    const walBytes = existsSync(legacyWalPath) ? statSync(legacyWalPath).size : 0;
    if (!existsSync(legacySnapshotPath)) {
      if (walBytes > 0) {
        throw this.namespaceAliasError(namespace, "legacy WAL has no identifying snapshot");
      }
      return;
    }
    const snapshot = this.readSnapshotIdentity(legacySnapshotPath);
    if (!snapshot || snapshot.namespace !== namespace) {
      throw this.namespaceAliasError(namespace, "legacy snapshot belongs to another or unknown namespace");
    }
    this.ensureLegacySnapshotCopied(namespace, legacySnapshotPath, walBytes);
  }

  public getTotalWalRecordsCount(): number {
    let total = 0;
    for (const seq of this.namespaceSeq.values()) {
      total += seq;
    }
    return total;
  }

  private ensureDir(dir: string): void {
    if (process.platform === "linux") {
      ensurePrivateDirectory(this.stateDir);
      ensurePrivateDirectory(this.baseDataDir);
      ensurePrivateDirectory(dir);
    } else if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private getWalFd(namespace: string): number {
    let fd = this.namespaceFd.get(namespace);
    if (fd === undefined) {
      this.ensureLegacyNamespaceSafe(namespace);
      const dir = this.getNamespaceDir(namespace);
      this.ensureDir(dir);
      const walPath = this.getWalPath(namespace);
      fd = openSync(walPath, "a+", 0o600);
      if (process.platform === "linux") fchmodSync(fd, 0o600);
      this.namespaceFd.set(namespace, fd);
    }
    return fd;
  }

  private capacityError(message: string): Error & { code: string } {
    const error = new Error(`[WAL_CAPACITY_EXCEEDED] ${message}`) as Error & { code: string };
    error.code = "WAL_CAPACITY_EXCEEDED";
    return error;
  }

  private ensureNamespaceWritable(namespace: string): void {
    if (this.writeBlockedNamespaces.has(namespace)) {
      throw this.capacityError(
        `WAL for namespace "${namespace}" has an uncertain failed write; restart and recover it before writing again`
      );
    }
  }

  private ensureNamespaceRecovered(namespace: string): void {
    if (this.recoveryBlockedNamespaces.has(namespace)) {
      throw new Error(
        `[RECOVERY_FAILED] Namespace "${namespace}" had a partial recovery failure; restart the Hub after repairing or restoring its persisted state`
      );
    }
  }

  private encodeRecord(record: WalRecord): Buffer {
    const jsonStr = JSON.stringify(record);
    if (typeof jsonStr !== "string") {
      throw new Error("WAL record must be JSON serializable");
    }
    const payloadBuf = Buffer.from(jsonStr, "utf-8");

    if (payloadBuf.length > MAX_FRAME_SIZE) {
      throw new Error(`WAL record exceeds maximum frame size: ${payloadBuf.length} bytes`);
    }

    const frame = Buffer.allocUnsafe(8 + payloadBuf.length);
    frame.writeUInt32BE(payloadBuf.length, 0);
    frame.writeUInt32BE(crc32(payloadBuf), 4);
    payloadBuf.copy(frame, 8);
    return frame;
  }

  private getWalByteLength(namespace: string): number {
    const fd = this.namespaceFd.get(namespace);
    if (fd !== undefined) return fstatSync(fd).size;
    const walPath = this.getWalPath(namespace);
    if (process.platform === "linux" && existsSync(walPath)) securePrivateFile(walPath);
    return existsSync(walPath) ? statSync(walPath).size : 0;
  }

  private appendEncoded(
    namespace: string,
    record: WalRecord,
    frame: Buffer,
    maxBytes = this.maxWalBytes
  ): void {
    this.ensureNamespaceWritable(namespace);
    const fd = this.getWalFd(namespace);
    const startingSize = fstatSync(fd).size;
    if (maxBytes !== undefined && startingSize + frame.length > maxBytes) {
      throw this.capacityError(
        `namespace "${namespace}" WAL would exceed ${maxBytes} bytes; create a snapshot before writing`
      );
    }

    try {
      let offset = 0;
      while (offset < frame.length) {
        const written = writeSync(fd, frame, offset, frame.length - offset, null);
        if (written <= 0) throw new Error("WAL write made no progress");
        offset += written;
      }
      fsyncSync(fd);
    } catch (err) {
      // Queue state is not committed until append returns. Roll back a partial
      // or non-durable record so memory and replay state continue to agree.
      try {
        ftruncateSync(fd, startingSize);
        fsyncSync(fd);
      } catch {
        // If rollback durability is unknown, prohibit further appends and
        // snapshots until restart/recovery resolves which record survived.
        this.writeBlockedNamespaces.add(namespace);
      }
      throw err;
    }

    if (record.seq > (this.namespaceSeq.get(namespace) || 0)) {
      this.namespaceSeq.set(namespace, record.seq);
    }
  }

  /**
   * Appends an operation record to wal.log with length prefix and CRC32.
   * Forces durability with fsync.
   */
  public append(namespace: string, record: WalRecord): void {
    const frame = this.encodeRecord(record);
    this.appendEncoded(namespace, record, frame, this.maxWalBytes);
  }

  /**
   * Compacts the pre-operation state before appending any WAL class when its
   * next frame would exceed the configured per-namespace WAL cap.
   */
  public appendWithSnapshot(
    namespace: string,
    record: WalRecord,
    snapshotSources: QueueWalSnapshotSources
  ): void {
    this.ensureNamespaceWritable(namespace);
    const frame = this.encodeRecord(record);
    if (frame.length > this.maxWalBytes) {
      throw this.capacityError(`WAL record exceeds namespace capacity ${this.maxWalBytes} bytes`);
    }
    if (this.getWalByteLength(namespace) + frame.length > this.maxWalBytes) {
      this.createSnapshot(
        namespace,
        snapshotSources.engine,
        snapshotSources.leases,
        snapshotSources.queues
      );
    }
    this.appendEncoded(namespace, record, frame, this.maxWalBytes);
  }

  /**
   * Appends a queue operation and snapshots the pre-operation state when needed
   * to keep the WAL bounded. The caller applies its queue mutation only after
   * this method returns so the snapshot cannot contain an unlogged operation.
   */
  public appendQueueRecord(
    namespace: string,
    record: WalRecord,
    snapshotSources: QueueWalSnapshotSources
  ): void {
    if (!record.op.startsWith("queue_")) {
      throw new Error("appendQueueRecord only accepts queue WAL operations");
    }
    this.ensureNamespaceWritable(namespace);
    const frame = this.encodeRecord(record);
    if (frame.length > this.maxWalBytes) {
      throw this.capacityError(
        `queue WAL record exceeds namespace capacity ${this.maxWalBytes} bytes`
      );
    }
    this.appendWithSnapshot(namespace, record, snapshotSources);
  }

  /** Writes the entire buffer, tolerating short writes and rejecting no-progress writes. */
  private writeAll(
    fd: number,
    data: Buffer,
    writer: typeof writeSync = writeSync
  ): void {
    let offset = 0;
    while (offset < data.length) {
      const written = writer(fd, data, offset, data.length - offset, offset);
      if (written <= 0) throw new Error("Snapshot write made no progress");
      offset += written;
    }
  }

  private fsyncDirectory(dir: string): void {
    // Windows does not support opening a directory handle this way. File fsync
    // still protects the snapshot contents there; POSIX also persists rename.
    if (process.platform === "win32") return;
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Performs an atomic snapshot for the given namespace:
   * 1. Serializes in-memory entries, leases, and queues.
   * 2. Writes to temporary file.
   * 3. Calls fsync on temporary file.
   * 4. Atomically renames temporary file to snapshot.json.
   * 5. Truncates wal.log to 0 bytes and resets file offset.
   */
  public createSnapshot(
    namespace: string,
    engine: KvEngine,
    leases?: LeaseManager,
    queues?: QueueManager
  ): string {
    this.ensureNamespaceWritable(namespace);
    this.ensureLegacyNamespaceSafe(namespace);
    const dir = this.getNamespaceDir(namespace);
    this.ensureDir(dir);

    const snapshotPath = this.getSnapshotPath(namespace);
    const currentSeq = this.getCurrentSeq(namespace);
    const entries = engine.exportState(namespace);
    const leaseState = leases ? leases.exportState(namespace) : undefined;
    const queueState = queues ? queues.exportState(namespace) : undefined;

    const snapshotData: SnapshotData = {
      version: 1,
      namespace,
      lastWalSeq: currentSeq,
      timestamp: Date.now(),
      entries,
      leases: leaseState,
      queues: queueState,
    };

    const tempPath = join(
      dir,
      `snapshot.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
    );

    const dataBuf = Buffer.from(JSON.stringify(snapshotData, null, 2), "utf-8");
    try {
      const tempFd = openSync(tempPath, "wx", 0o600);
      try {
        this.writeAll(tempFd, dataBuf);
        fsyncSync(tempFd);
      } finally {
        closeSync(tempFd);
      }
    } catch (err) {
      try { unlinkSync(tempPath); } catch {}
      throw err;
    }

    // Atomic replace
    renameSync(tempPath, snapshotPath);
    this.fsyncDirectory(dir);

    // Now safely truncate WAL file since all state up to currentSeq is in snapshot.json
    this.closeNamespaceFd(namespace);
    const walPath = this.getWalPath(namespace);
    if (existsSync(walPath)) {
      if (process.platform === "linux") securePrivateFile(walPath);
      const walFd = openSync(walPath, "r+");
      try {
        ftruncateSync(walFd, 0);
        fsyncSync(walFd);
      } finally {
        closeSync(walFd);
      }
      this.fsyncDirectory(dir);
    }

    return snapshotPath;
  }

  /**
   * Recovers state for a namespace:
   * 1. Loads latest snapshot.json if present.
   * 2. Replays any subsequent valid WAL entries from wal.log.
   * 3. If corrupted/partial trailing bytes exist in wal.log, safely truncates them.
   */
  public recover(
    namespace: string,
    engine: KvEngine,
    leases?: LeaseManager,
    queues?: QueueManager
  ): RecoveryResult {
    this.ensureNamespaceRecovered(namespace);
    this.ensureLegacyNamespaceSafe(namespace);
    const dir = this.getNamespaceDir(namespace);
    this.ensureDir(dir);

    this.closeNamespaceFd(namespace);

    let snapshotLoaded = false;
    let entriesFromSnapshot = 0;
    let lastWalSeq = 0;

    const snapshotPath = this.getSnapshotPath(namespace);
    if (existsSync(snapshotPath)) {
      if (process.platform === "linux") securePrivateFile(snapshotPath);
      let snapshot: SnapshotData;
      try {
        const rawJson = readFileSync(snapshotPath, "utf-8");
        const candidate = JSON.parse(rawJson) as SnapshotData;
        if (!candidate || candidate.version !== 1) {
          throw new Error("unsupported or missing snapshot version");
        }
        if (candidate.namespace !== namespace) {
          throw this.namespaceAliasError(namespace, `snapshot belongs to "${candidate.namespace}"`);
        }
        if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp)) {
          throw new Error("snapshot timestamp must be finite");
        }
        this.validateSnapshotData(candidate, queues);
        snapshot = candidate;
      } catch (err) {
        if ((err as Error & { code?: string }).code === "LEGACY_NAMESPACE_PATH_AMBIGUOUS") {
          throw err;
        }
        throw new Error(
          `[SNAPSHOT_INVALID] Refusing WAL replay for "${namespace}" because present snapshot "${snapshotPath}" is invalid: ${(err as Error).message}`
        );
      }

      try {
        engine.importState(namespace, snapshot.entries);
        entriesFromSnapshot = Object.keys(snapshot.entries).length;
        if (leases && snapshot.leases) {
          leases.importState(namespace, snapshot.leases);
        }
        if (queues && snapshot.queues) {
          queues.importState(namespace, snapshot.queues);
        }
      } catch (err) {
        this.recoveryBlockedNamespaces.add(namespace);
        throw new Error(
          `[SNAPSHOT_IMPORT_FAILED] Refusing WAL replay after partial snapshot import for "${namespace}": ${(err as Error).message}`
        );
      }
      snapshotLoaded = true;
      lastWalSeq = snapshot.lastWalSeq;
      this.namespaceSeq.set(namespace, lastWalSeq);
    }

    const walPath = this.getWalPath(namespace);
    let replayedWalRecords = 0;
    let truncatedBytes = 0;

    if (existsSync(walPath)) {
      if (process.platform === "linux") securePrivateFile(walPath);
      const fd = openSync(walPath, "r+");
      const fileSize = fstatSync(fd).size;
      let offset = 0;
      let validOffset = 0;
      let corrupted = false;

      const readAtMost = (buffer: Buffer, position: number): number => {
        let total = 0;
        while (total < buffer.length) {
          const count = readSync(fd, buffer, total, buffer.length - total, position + total);
          if (count === 0) break;
          total += count;
        }
        return total;
      };

      try {
      while (offset < fileSize) {
        // Need at least 8 bytes for length (4B) and CRC32 (4B)
        if (fileSize - offset < 8) {
          corrupted = true;
          break;
        }

        const header = Buffer.allocUnsafe(8);
        if (readAtMost(header, offset) !== header.length) {
          corrupted = true;
          break;
        }
        const payloadLen = header.readUInt32BE(0);
        const expectedCrc = header.readUInt32BE(4);

        if (payloadLen <= 0 || payloadLen > MAX_FRAME_SIZE) {
          corrupted = true;
          break;
        }

        const recordTotalLen = 8 + payloadLen;
        if (offset + recordTotalLen > fileSize) {
          // Partial trailing payload
          corrupted = true;
          break;
        }

        const payloadSlice = Buffer.allocUnsafe(payloadLen);
        if (readAtMost(payloadSlice, offset + 8) !== payloadLen) {
          corrupted = true;
          break;
        }
        const actualCrc = crc32(payloadSlice);

        if (actualCrc !== expectedCrc) {
          // Checksum mismatch
          corrupted = true;
          break;
        }

        let record: WalRecord;
        try {
          record = JSON.parse(payloadSlice.toString("utf-8")) as WalRecord;
        } catch {
          corrupted = true;
          break;
        }

        try {
          this.validateWalRecord(record);
        } catch (err) {
          this.recoveryBlockedNamespaces.add(namespace);
          throw new Error(
            `[WAL_REPLAY_FAILED] Refusing further recovery for "${namespace}" after invalid record at byte ${offset}: ${(err as Error).message}`
          );
        }

        // Record is completely valid
        validOffset = offset + recordTotalLen;
        offset = validOffset;

        if (record.seq > lastWalSeq) {
          try {
            this.applyRecord(engine, leases, queues, namespace, record);
          } catch (err) {
            this.recoveryBlockedNamespaces.add(namespace);
            throw new Error(
              `[WAL_REPLAY_FAILED] Refusing further recovery for "${namespace}" after record ${record.seq}: ${(err as Error).message}`
            );
          }
          replayedWalRecords++;
        }

        if (record.seq > (this.namespaceSeq.get(namespace) || 0)) {
          this.namespaceSeq.set(namespace, record.seq);
        }
      }

      if (corrupted || validOffset < fileSize) {
        truncatedBytes = fileSize - validOffset;
        ftruncateSync(fd, validOffset);
        fsyncSync(fd);
      }
      } finally {
        closeSync(fd);
      }
    }

    this.writeBlockedNamespaces.delete(namespace);
    return {
      snapshotLoaded,
      entriesFromSnapshot,
      replayedWalRecords,
      truncatedBytes,
    };
  }

  private validateWalRecord(record: WalRecord): void {
    const ops: WalOp[] = [
      "set", "del", "incr", "cas", "lease_acquire", "lease_renew", "lease_release",
      "queue_publish", "queue_ack", "queue_nack",
    ];
    if (!record || typeof record !== "object" || !ops.includes(record.op)) {
      throw new Error("WAL record has an unknown operation");
    }
    if (!Number.isSafeInteger(record.seq) || record.seq <= 0 ||
        typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) {
      throw new Error("WAL record has invalid sequence or timestamp");
    }
    const requireString = (value: unknown, name: string) => {
      if (typeof value !== "string" || value.length === 0) throw new Error(`WAL record has invalid ${name}`);
    };
    switch (record.op) {
      case "set":
      case "del":
      case "incr":
      case "cas":
        requireString(record.key, "key");
        if (record.op === "set") {
          validateSafeData(record.value);
          estimateValueSize(record.value);
        }
        if (record.op === "incr" && (typeof record.delta !== "number" || !Number.isFinite(record.delta))) {
          throw new Error("WAL increment record has invalid delta");
        }
        if (record.op === "cas") {
          validateSafeData(record.expectedValue);
          validateSafeData(record.newValue);
          estimateValueSize(record.expectedValue);
          estimateValueSize(record.newValue);
        }
        break;
      case "lease_acquire":
        requireString(record.leaseName, "lease name");
        requireString(record.ownerId, "lease owner");
        if (!Number.isSafeInteger(record.fencingToken) || !Number.isFinite(record.expiresAt)) {
          throw new Error("WAL acquire record has invalid lease values");
        }
        break;
      case "lease_renew":
      case "lease_release":
        requireString(record.leaseName, "lease name");
        if (!Number.isSafeInteger(record.fencingToken) ||
            (record.op === "lease_renew" && !Number.isFinite(record.expiresAt))) {
          throw new Error("WAL lease record has invalid lease values");
        }
        break;
      case "queue_publish":
        requireString(record.queueName, "queue name");
        requireString(record.messageId, "message id");
        if (!Number.isFinite(record.createdAt)) throw new Error("WAL publish record has invalid creation time");
        validateSafeData(record.payload);
        validateSafeData(record.options);
        break;
      case "queue_ack":
      case "queue_nack":
        requireString(record.queueName, "queue name");
        requireString(record.messageId, "message id");
        break;
    }
  }

  private applyRecord(
    engine: KvEngine,
    leases: LeaseManager | undefined,
    queues: QueueManager | undefined,
    namespace: string,
    record: WalRecord
  ): void {
    switch (record.op) {
      case "set":
        engine.set(namespace, record.key!, record.value, record.ttlMs);
        break;
      case "del":
        engine.delete(namespace, record.key!);
        break;
      case "incr":
        engine.incr(namespace, record.key!, record.delta ?? 1);
        break;
      case "cas":
        engine.cas(
          namespace,
          record.key!,
          record.expectedValue,
          record.newValue,
          record.ttlMs
        );
        break;
      case "lease_acquire":
        if (
          leases &&
          record.leaseName &&
          record.ownerId &&
          record.fencingToken !== undefined &&
          record.expiresAt !== undefined
        ) {
          leases.applyAcquire(
            namespace,
            record.leaseName,
            record.ownerId,
            record.fencingToken,
            record.expiresAt,
            record.timestamp
          );
        }
        break;
      case "lease_renew":
        if (
          leases &&
          record.leaseName &&
          record.fencingToken !== undefined &&
          record.expiresAt !== undefined
        ) {
          leases.applyRenew(
            namespace,
            record.leaseName,
            record.fencingToken,
            record.expiresAt
          );
        }
        break;
      case "lease_release":
        if (leases && record.leaseName && record.fencingToken !== undefined) {
          leases.applyRelease(namespace, record.leaseName, record.fencingToken);
        }
        break;
      case "queue_publish":
        if (queues && record.queueName && record.messageId) {
          queues.applyPublish(
            namespace,
            record.queueName,
            record.messageId,
            record.payload,
            record.createdAt ?? record.timestamp,
            record.options
          );
        }
        break;
      case "queue_ack":
        if (queues && record.queueName && record.messageId) {
          queues.applyAck(namespace, record.queueName, record.messageId);
        }
        break;
      case "queue_nack":
        if (queues && record.queueName && record.messageId) {
          queues.applyNack(namespace, record.queueName, record.messageId);
        }
        break;
    }
  }

  private closeNamespaceFd(namespace: string): void {
    const fd = this.namespaceFd.get(namespace);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
      this.namespaceFd.delete(namespace);
    }
  }

  /**
   * Closes all open file descriptors.
   */
  public close(): void {
    for (const [namespace, fd] of this.namespaceFd.entries()) {
      try {
        closeSync(fd);
      } catch {}
    }
    this.namespaceFd.clear();
  }
}
