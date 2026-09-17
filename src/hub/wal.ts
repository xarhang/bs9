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

import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, truncateSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { getPlatformInfo } from "../platform/detect.js";
import { MAX_FRAME_SIZE } from "./protocol.js";
import type { KvEngine, KvEntry } from "./engine.js";
import type { LeaseManager, LeaseSnapshotState } from "./leases.js";
import type { QueueManager, QueueMessage } from "./queues.js";

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
}

export class WalManager {
  private baseDataDir: string;
  private namespaceFd: Map<string, number> = new Map();
  private namespaceSeq: Map<string, number> = new Map();

  constructor(options: WalManagerOptions = {}) {
    const stateDir = options.stateDir || getPlatformInfo().stateDir;
    this.baseDataDir = join(stateDir, "hub-data");
  }

  public getNamespaceDir(namespace: string): string {
    const safeNamespace = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.baseDataDir, safeNamespace);
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

  public getCurrentSeq(namespace: string): number {
    return this.namespaceSeq.get(namespace) || 0;
  }

  public listNamespacesOnDisk(): string[] {
    if (!existsSync(this.baseDataDir)) return [];
    try {
      return readdirSync(this.baseDataDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  public getTotalWalRecordsCount(): number {
    let total = 0;
    for (const seq of this.namespaceSeq.values()) {
      total += seq;
    }
    return total;
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private getWalFd(namespace: string): number {
    let fd = this.namespaceFd.get(namespace);
    if (fd === undefined) {
      const dir = this.getNamespaceDir(namespace);
      this.ensureDir(dir);
      const walPath = this.getWalPath(namespace);
      fd = openSync(walPath, "a+");
      this.namespaceFd.set(namespace, fd);
    }
    return fd;
  }

  /**
   * Appends an operation record to wal.log with length prefix and CRC32.
   * Forces durability with fsync.
   */
  public append(namespace: string, record: WalRecord): void {
    const fd = this.getWalFd(namespace);
    const jsonStr = JSON.stringify(record);
    const payloadBuf = Buffer.from(jsonStr, "utf-8");

    if (payloadBuf.length > MAX_FRAME_SIZE) {
      throw new Error(`WAL record exceeds maximum frame size: ${payloadBuf.length} bytes`);
    }

    const checksum = crc32(payloadBuf);
    const frame = Buffer.allocUnsafe(8 + payloadBuf.length);

    frame.writeUInt32BE(payloadBuf.length, 0);
    frame.writeUInt32BE(checksum, 4);
    payloadBuf.copy(frame, 8);

    writeSync(fd, frame);
    fsyncSync(fd);

    if (record.seq > (this.namespaceSeq.get(namespace) || 0)) {
      this.namespaceSeq.set(namespace, record.seq);
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
    const tempFd = openSync(tempPath, "w");
    try {
      writeSync(tempFd, dataBuf);
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }

    // Atomic replace
    renameSync(tempPath, snapshotPath);

    // Now safely truncate WAL file since all state up to currentSeq is in snapshot.json
    this.closeNamespaceFd(namespace);
    const walPath = this.getWalPath(namespace);
    if (existsSync(walPath)) {
      truncateSync(walPath, 0);
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
    const dir = this.getNamespaceDir(namespace);
    this.ensureDir(dir);

    this.closeNamespaceFd(namespace);

    let snapshotLoaded = false;
    let entriesFromSnapshot = 0;
    let lastWalSeq = 0;

    const snapshotPath = this.getSnapshotPath(namespace);
    if (existsSync(snapshotPath)) {
      try {
        const rawJson = readFileSync(snapshotPath, "utf-8");
        const snapshot = JSON.parse(rawJson) as SnapshotData;
        if (snapshot && snapshot.version === 1) {
          if (snapshot.entries) {
            engine.importState(namespace, snapshot.entries);
            entriesFromSnapshot = Object.keys(snapshot.entries).length;
          }
          if (leases && snapshot.leases) {
            leases.importState(namespace, snapshot.leases);
          }
          if (queues && snapshot.queues) {
            queues.importState(namespace, snapshot.queues);
          }
          snapshotLoaded = true;
          lastWalSeq = snapshot.lastWalSeq || 0;
          this.namespaceSeq.set(namespace, lastWalSeq);
        }
      } catch (err) {
        console.warn(`[WalManager] Failed to load snapshot at ${snapshotPath}: ${(err as Error).message}`);
      }
    }

    const walPath = this.getWalPath(namespace);
    let replayedWalRecords = 0;
    let truncatedBytes = 0;

    if (existsSync(walPath)) {
      const buf = readFileSync(walPath);
      let offset = 0;
      let validOffset = 0;
      let corrupted = false;

      while (offset < buf.length) {
        // Need at least 8 bytes for length (4B) and CRC32 (4B)
        if (buf.length - offset < 8) {
          corrupted = true;
          break;
        }

        const payloadLen = buf.readUInt32BE(offset);
        const expectedCrc = buf.readUInt32BE(offset + 4);

        if (payloadLen <= 0 || payloadLen > MAX_FRAME_SIZE) {
          corrupted = true;
          break;
        }

        const recordTotalLen = 8 + payloadLen;
        if (offset + recordTotalLen > buf.length) {
          // Partial trailing payload
          corrupted = true;
          break;
        }

        const payloadSlice = buf.subarray(offset + 8, offset + recordTotalLen);
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

        // Record is completely valid
        validOffset = offset + recordTotalLen;
        offset = validOffset;

        if (record.seq > lastWalSeq) {
          this.applyRecord(engine, leases, queues, namespace, record);
          replayedWalRecords++;
        }

        if (record.seq > (this.namespaceSeq.get(namespace) || 0)) {
          this.namespaceSeq.set(namespace, record.seq);
        }
      }

      if (corrupted || validOffset < buf.length) {
        truncatedBytes = buf.length - validOffset;
        truncateSync(walPath, validOffset);
      }
    }

    return {
      snapshotLoaded,
      entriesFromSnapshot,
      replayedWalRecords,
      truncatedBytes,
    };
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
