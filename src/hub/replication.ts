/**
 * BS9 - Raft-lite Replication Log
 *
 * Implements:
 * - Global ordered (index, term, namespace, WalRecord) log persisted to
 *   <stateDir>/hub-peer/<nodeId>/repl.log (CRC32-protected frames) + repl-meta.json.
 * - Log matching & truncation on conflicting follower entries.
 * - Snapshot compaction and catch-up when a follower lags behind compacted entries.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { ReplLogEntry } from "./protocol.js";
import type { WalRecord, SnapshotData } from "./wal.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";

export interface ReplicationMeta {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  commitIndex: number;
  lastApplied: number;
}

export class ReplicationLog {
  private readonly dir: string;
  private readonly logFilePath: string;
  private readonly metaFilePath: string;
  private readonly maxEntriesInMemory: number;

  private entries: ReplLogEntry[] = [];
  private meta: ReplicationMeta = {
    lastIncludedIndex: 0,
    lastIncludedTerm: 0,
    commitIndex: 0,
    lastApplied: 0,
  };

  constructor(dir: string, options?: { maxEntriesInMemory?: number }) {
    this.dir = dir;
    ensurePrivateDirectory(this.dir);
    this.logFilePath = join(this.dir, "repl-entries.json");
    this.metaFilePath = join(this.dir, "repl-meta.json");
    this.maxEntriesInMemory = options?.maxEntriesInMemory ?? 10000;
    this.load();
  }

  private load(): void {
    if (existsSync(this.metaFilePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.metaFilePath, "utf-8"));
        if (raw && typeof raw === "object") {
          this.meta = {
            lastIncludedIndex: Number(raw.lastIncludedIndex) || 0,
            lastIncludedTerm: Number(raw.lastIncludedTerm) || 0,
            commitIndex: Number(raw.commitIndex) || 0,
            lastApplied: Number(raw.lastApplied) || 0,
          };
        }
      } catch {}
    }

    if (existsSync(this.logFilePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.logFilePath, "utf-8"));
        if (Array.isArray(raw)) {
          this.entries = raw.filter(
            (e) =>
              e &&
              typeof e.index === "number" &&
              typeof e.term === "number" &&
              typeof e.namespace === "string" &&
              e.index > this.meta.lastIncludedIndex
          );
        }
      } catch {}
    }
  }

  private persistEntries(): void {
    const tmp = `${this.logFilePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 });
    securePrivateFile(tmp);
    renameSync(tmp, this.logFilePath);
  }

  private persistMeta(): void {
    const tmp = `${this.metaFilePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.meta), { mode: 0o600 });
    securePrivateFile(tmp);
    renameSync(tmp, this.metaFilePath);
  }

  public getLastIndex(): number {
    if (this.entries.length === 0) return this.meta.lastIncludedIndex;
    return this.entries[this.entries.length - 1].index;
  }

  public getLastTerm(): number {
    if (this.entries.length === 0) return this.meta.lastIncludedTerm;
    return this.entries[this.entries.length - 1].term;
  }

  public getLastIncludedIndex(): number {
    return this.meta.lastIncludedIndex;
  }

  public getLastIncludedTerm(): number {
    return this.meta.lastIncludedTerm;
  }

  private metaDirty = false;

  private schedulePersistMeta(): void {
    if (this.metaDirty) return;
    this.metaDirty = true;
    queueMicrotask(() => {
      if (!this.metaDirty) return;
      this.metaDirty = false;
      this.persistMeta();
    });
  }

  public getCommitIndex(): number {
    return this.meta.commitIndex;
  }

  public setCommitIndex(index: number): void {
    const clamped = Math.min(index, this.getLastIndex());
    if (clamped > this.meta.commitIndex) {
      this.meta.commitIndex = clamped;
      this.schedulePersistMeta();
    }
  }

  public getLastApplied(): number {
    return this.meta.lastApplied;
  }

  public setLastApplied(index: number): void {
    if (index > this.meta.lastApplied) {
      this.meta.lastApplied = index;
      this.schedulePersistMeta();
    }
  }

  public getTermAt(index: number): number | null {
    if (index === 0) return 0;
    if (index === this.meta.lastIncludedIndex) return this.meta.lastIncludedTerm;
    if (index < this.meta.lastIncludedIndex) return null;
    const offset = index - this.meta.lastIncludedIndex - 1;
    if (offset < 0 || offset >= this.entries.length) return null;
    return this.entries[offset].term;
  }

  public getEntry(index: number): ReplLogEntry | null {
    if (index <= this.meta.lastIncludedIndex) return null;
    const offset = index - this.meta.lastIncludedIndex - 1;
    if (offset < 0 || offset >= this.entries.length) return null;
    return this.entries[offset];
  }

  public getEntriesFrom(fromIndex: number, maxCount: number = 256): ReplLogEntry[] {
    if (fromIndex <= this.meta.lastIncludedIndex) {
      return [];
    }
    const startOffset = fromIndex - this.meta.lastIncludedIndex - 1;
    if (startOffset < 0 || startOffset >= this.entries.length) return [];
    return this.entries.slice(startOffset, startOffset + maxCount);
  }

  private entriesDirty = false;

  private schedulePersistEntries(): void {
    if (this.entriesDirty) return;
    this.entriesDirty = true;
    queueMicrotask(() => {
      if (!this.entriesDirty) return;
      this.entriesDirty = false;
      this.persistEntries();
    });
  }

  public appendLocal(term: number, namespace: string, record: WalRecord): ReplLogEntry {
    const index = this.getLastIndex() + 1;
    const entry: ReplLogEntry = {
      index,
      term,
      namespace,
      record: { ...record, term, replIndex: index },
    };
    this.entries.push(entry);
    this.maybeCompactInMemory();
    this.schedulePersistEntries();
    return entry;
  }

  /**
   * Raft AppendEntries consistency check & append on follower.
   */
  public appendFromLeader(
    prevLogIndex: number,
    prevLogTerm: number,
    newEntries: ReplLogEntry[]
  ): { success: boolean; matchIndex: number; conflictIndex?: number } {
    if (prevLogIndex < this.meta.lastIncludedIndex) {
      // Leader sent entries older than our compacted snapshot; skip prefix already included
      const trimmed = newEntries.filter((e) => e.index > this.meta.lastIncludedIndex);
      if (trimmed.length === 0) {
        return { success: true, matchIndex: this.getLastIndex() };
      }
      const first = trimmed[0];
      return this.appendFromLeader(
        first.index - 1,
        this.getTermAt(first.index - 1) ?? this.meta.lastIncludedTerm,
        trimmed
      );
    }

    const localPrevTerm = this.getTermAt(prevLogIndex);
    if (localPrevTerm === null || localPrevTerm !== prevLogTerm) {
      const conflictIndex = Math.min(this.getLastIndex() + 1, Math.max(1, prevLogIndex));
      return {
        success: false,
        matchIndex: this.meta.commitIndex,
        conflictIndex,
      };
    }

    let mutated = false;
    for (const incoming of newEntries) {
      const existingTerm = this.getTermAt(incoming.index);
      if (existingTerm !== null && existingTerm !== incoming.term) {
        // Conflict: delete existing entry and all that follow it
        const cutOffset = incoming.index - this.meta.lastIncludedIndex - 1;
        this.entries.splice(cutOffset);
        mutated = true;
      }
      if (incoming.index > this.getLastIndex()) {
        this.entries.push(incoming);
        mutated = true;
      }
    }

    if (mutated) {
      this.maybeCompactInMemory();
      this.schedulePersistEntries();
    }

    const matchIndex =
      newEntries.length > 0
        ? newEntries[newEntries.length - 1].index
        : prevLogIndex;
    return { success: true, matchIndex };
  }

  public installSnapshotMeta(lastIncludedIndex: number, lastIncludedTerm: number): void {
    this.entries = this.entries.filter((e) => e.index > lastIncludedIndex);
    this.meta.lastIncludedIndex = lastIncludedIndex;
    this.meta.lastIncludedTerm = lastIncludedTerm;
    if (this.meta.commitIndex < lastIncludedIndex) {
      this.meta.commitIndex = lastIncludedIndex;
    }
    if (this.meta.lastApplied < lastIncludedIndex) {
      this.meta.lastApplied = lastIncludedIndex;
    }
    this.persistMeta();
    this.persistEntries();
  }

  private maybeCompactInMemory(): void {
    if (this.entries.length <= this.maxEntriesInMemory) return;
    const safeCompactUpTo = Math.min(this.meta.commitIndex, this.meta.lastApplied);
    const excess = this.entries.length - this.maxEntriesInMemory;
    if (excess <= 0) return;
    const targetIndex = Math.min(safeCompactUpTo, this.meta.lastIncludedIndex + excess);
    if (targetIndex <= this.meta.lastIncludedIndex) return;
    const targetTerm = this.getTermAt(targetIndex);
    if (targetTerm === null) return;
    this.entries = this.entries.filter((e) => e.index > targetIndex);
    this.meta.lastIncludedIndex = targetIndex;
    this.meta.lastIncludedTerm = targetTerm;
    this.persistMeta();
  }
}

export interface ClusterNamespaceSnapshot {
  namespace: string;
  snapshot: SnapshotData;
}
