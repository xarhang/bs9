/**
 * BS9 - Raft-lite Cluster Membership, Leader Election & Replication Coordinator
 *
 * Implements:
 * - Roles: follower, candidate, leader.
 * - Persistent Raft state: currentTerm, votedFor in <stateDir>/hub-peer/<nodeId>/raft.json.
 * - Randomized election timeout (default 180-320ms) & periodic leader heartbeats.
 * - Quorum replication (proposeRecord -> REPL_APPEND -> majority REPL_ACK -> commit).
 * - Automatic follower catch-up via REPL_APPEND or full snapshot install (REPL_SNAPSHOT_CHUNK).
 * - Transparent write forwarding from follower to current leader (FORWARD_WRITE -> FORWARD_RESULT).
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  createEnvelope,
  type Bs9Envelope,
  type PeerHeartbeatPayload,
  type PeerHeartbeatAckPayload,
  type ReplAppendPayload,
  type ReplAckPayload,
  type ReplSnapshotReqPayload,
  type ReplSnapshotChunkPayload,
  type VoteRequestPayload,
  type VoteResponsePayload,
  type ForwardWritePayload,
  type ForwardResultPayload,
  type ReplLogEntry,
} from "./protocol.js";
import {
  PeerTransport,
  PEER_NAMESPACE,
  type PeerEndpoint,
  type PeerTlsOptions,
  type ConnectedPeerInfo,
} from "./peer-transport.js";
import { ReplicationLog } from "./replication.js";
import type { WalRecord, SnapshotData } from "./wal.js";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";

export type ClusterRole = "follower" | "candidate" | "leader";

export interface HubClusterOptions {
  nodeId: string;
  listen: string;
  clusterSecret: string;
  peers: (string | PeerEndpoint)[];
  stateDir?: string;
  tls?: PeerTlsOptions;
  /** Total expected voting nodes in the cluster (defaults to 1 + peers.length). */
  clusterSize?: number;
  electionTimeoutMinMs?: number;
  electionTimeoutMaxMs?: number;
  heartbeatIntervalMs?: number;
  replicationTimeoutMs?: number;
  maxReplEntriesInMemory?: number;
}

export interface ClusterCallbacks {
  /** Apply a committed log entry on a follower (or during catch-up). */
  onApplyCommittedEntry: (entry: ReplLogEntry) => void;
  /** Export full state of all namespaces for snapshot transfer to lagging follower. */
  onExportAllSnapshots: () => Record<string, SnapshotData>;
  /** Install full state snapshots received from leader. */
  onInstallAllSnapshots: (namespaces: Record<string, SnapshotData>) => void;
  /** Execute a forwarded client envelope on the leader and return the response envelope. */
  onExecuteForwardedWrite: (envelope: Bs9Envelope<any>) => Promise<Bs9Envelope<any>>;
}

export interface PeerStatusInfo extends ConnectedPeerInfo {
  matchIndex: number;
  nextIndex: number;
  lag: number;
}

export interface ClusterStatusInfo {
  nodeId: string;
  listenAddress: string;
  role: ClusterRole;
  term: number;
  leaderId: string | null;
  votedFor: string | null;
  commitIndex: number;
  lastApplied: number;
  lastLogIndex: number;
  lastLogTerm: number;
  quorumSize: number;
  clusterSize: number;
  peers: PeerStatusInfo[];
}

interface PendingCommitWaiter {
  index: number;
  term: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ClusterCoordinator extends EventEmitter {
  public readonly nodeId: string;
  public readonly transport: PeerTransport;
  public readonly log: ReplicationLog;

  private readonly stateDir: string;
  private readonly peerDir: string;
  private readonly raftStatePath: string;
  private readonly callbacks: ClusterCallbacks;
  private readonly electionMinMs: number;
  private readonly electionMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly replicationTimeoutMs: number;
  private clusterSize: number;

  private role: ClusterRole = "follower";
  private currentTerm: number = 0;
  private votedFor: string | null = null;
  private leaderId: string | null = null;
  private lastLeaderContactAt: number = 0;
  private votesGranted = new Set<string>();

  // Leader volatile state per follower
  private readonly nextIndex = new Map<string, number>();
  private readonly matchIndex = new Map<string, number>();
  private readonly commitWaiters = new Map<number, PendingCommitWaiter[]>();

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private replScheduled = false;
  private running = false;

  constructor(options: HubClusterOptions, callbacks: ClusterCallbacks) {
    super();
    this.nodeId = options.nodeId;
    this.stateDir = options.stateDir || getPlatformInfo().stateDir;
    this.peerDir = join(this.stateDir, "hub-peer", this.nodeId);
    ensurePrivateDirectory(this.peerDir);
    this.raftStatePath = join(this.peerDir, "raft.json");
    this.callbacks = callbacks;

    this.electionMinMs = options.electionTimeoutMinMs ?? 180;
    this.electionMaxMs = options.electionTimeoutMaxMs ?? 340;
    this.heartbeatMs = options.heartbeatIntervalMs ?? 55;
    this.replicationTimeoutMs = options.replicationTimeoutMs ?? 3000;

    // Deduplicate configured peers (excluding self)
    const uniquePeers = new Map<string, string | PeerEndpoint>();
    for (const p of options.peers ?? []) {
      const addr = typeof p === "string" ? p : p.address;
      const nid = typeof p === "string" ? undefined : p.nodeId;
      if (nid === this.nodeId || addr === options.listen) continue;
      uniquePeers.set(addr, p);
    }
    this.clusterSize = options.clusterSize ?? 1 + uniquePeers.size;

    this.loadRaftState();
    this.log = new ReplicationLog(this.peerDir, {
      maxEntriesInMemory: options.maxReplEntriesInMemory,
    });

    this.transport = new PeerTransport({
      nodeId: this.nodeId,
      listen: options.listen,
      clusterSecret: options.clusterSecret,
      peers: Array.from(uniquePeers.values()),
      stateDir: this.stateDir,
      tls: options.tls,
    });

    this.transport.on("message", (fromNodeId: string, env: Bs9Envelope<any>) => {
      this.handlePeerMessage(fromNodeId, env);
    });

    this.transport.on("peerConnected", (remoteNodeId: string) => {
      if (this.role === "leader") {
        if (!this.nextIndex.has(remoteNodeId)) {
          this.nextIndex.set(remoteNodeId, this.log.getLastIndex() + 1);
          this.matchIndex.set(remoteNodeId, 0);
        }
        this.replicateToPeer(remoteNodeId);
      }
    });
  }

  private loadRaftState(): void {
    if (!existsSync(this.raftStatePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.raftStatePath, "utf-8"));
      if (raw && typeof raw === "object") {
        this.currentTerm = Number(raw.currentTerm) || 0;
        this.votedFor = typeof raw.votedFor === "string" ? raw.votedFor : null;
      }
    } catch {}
  }

  private persistRaftState(): void {
    const tmp = `${this.raftStatePath}.tmp.${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify({ currentTerm: this.currentTerm, votedFor: this.votedFor }),
      { mode: 0o600 }
    );
    securePrivateFile(tmp);
    renameSync(tmp, this.raftStatePath);
  }

  public getQuorumSize(): number {
    return Math.floor(this.clusterSize / 2) + 1;
  }

  public getRole(): ClusterRole {
    return this.role;
  }

  public getTerm(): number {
    return this.currentTerm;
  }

  public getLeaderId(): string | null {
    return this.leaderId;
  }

  public isLeader(): boolean {
    return this.role === "leader";
  }

  /**
   * Computes a globally unique, monotonically increasing fencing token across leader elections:
   * high 20 bits = term, low 31 bits = local counter (fits safely within JS 53-bit integer).
   */
  public computeFencingToken(localCounter: number): number {
    const termPart = Math.max(1, this.currentTerm) * 0x80000000; // 2^31
    return termPart + (localCounter & 0x7fffffff);
  }

  public getStatus(): ClusterStatusInfo {
    const connected = this.transport.getConnectedPeers();
    const lastIdx = this.log.getLastIndex();
    const peers: PeerStatusInfo[] = connected.map((p) => {
      const match = this.matchIndex.get(p.nodeId) ?? 0;
      const next = this.nextIndex.get(p.nodeId) ?? lastIdx + 1;
      return {
        ...p,
        matchIndex: match,
        nextIndex: next,
        lag: Math.max(0, lastIdx - match),
      };
    });

    return {
      nodeId: this.nodeId,
      listenAddress: this.transport.getListenAddress(),
      role: this.role,
      term: this.currentTerm,
      leaderId: this.leaderId,
      votedFor: this.votedFor,
      commitIndex: this.log.getCommitIndex(),
      lastApplied: this.log.getLastApplied(),
      lastLogIndex: lastIdx,
      lastLogTerm: this.log.getLastTerm(),
      quorumSize: this.getQuorumSize(),
      clusterSize: this.clusterSize,
      peers,
    };
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.transport.start();

    // Single-node cluster immediately becomes leader
    if (this.clusterSize <= 1) {
      this.currentTerm = Math.max(1, this.currentTerm);
      this.persistRaftState();
      this.becomeLeader();
      return;
    }

    this.resetElectionTimer();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.rejectAllWaiters(new Error("ClusterCoordinator stopped"));
    await this.transport.stop();
  }

  /**
   * Leader appends a WAL record to the replication log and waits for majority quorum commit.
   */
  public async proposeRecord(namespace: string, record: WalRecord): Promise<ReplLogEntry> {
    if (this.role !== "leader") {
      throw new Error(`[NOT_LEADER] Node "${this.nodeId}" is not leader (current leader: ${this.leaderId ?? "unknown"})`);
    }

    const term = this.currentTerm;
    const entry = this.log.appendLocal(term, namespace, record);

    if (this.getQuorumSize() <= 1) {
      this.log.setCommitIndex(entry.index);
      this.log.setLastApplied(entry.index);
      return entry;
    }

    const commitPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(entry.index, waiter);
        reject(new Error(`[QUORUM_TIMEOUT] Timed out waiting for majority commit at index ${entry.index}`));
      }, this.replicationTimeoutMs);

      const waiter: PendingCommitWaiter = {
        index: entry.index,
        term,
        resolve,
        reject,
        timer,
      };
      const list = this.commitWaiters.get(entry.index) ?? [];
      list.push(waiter);
      this.commitWaiters.set(entry.index, list);
    });

    // Trigger immediate replication to all connected followers
    this.replicateToAllPeers();

    await commitPromise;
    this.log.setLastApplied(entry.index);
    return entry;
  }

  /**
   * Forwards a write envelope from a follower to the current leader and returns the leader's response envelope.
   */
  public async forwardWriteToLeader(envelope: Bs9Envelope<any>): Promise<Bs9Envelope<any>> {
    const deadline = Date.now() + this.replicationTimeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      while (
        (!this.leaderId || (!this.isLeader() && !this.transport.isPeerConnected(this.leaderId))) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }

      if (this.isLeader()) {
        return this.callbacks.onExecuteForwardedWrite(envelope);
      }

      const targetLeader = this.leaderId;
      if (!targetLeader || !this.transport.isPeerConnected(targetLeader)) {
        lastError = new Error(`[NO_LEADER] No reachable cluster leader to forward ${envelope.type}`);
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }

      const attemptTimeoutMs = Math.min(400, Math.max(100, deadline - Date.now()));
      try {
        const res = await this.transport.request<ForwardWritePayload, ForwardResultPayload>(
          targetLeader,
          "FORWARD_WRITE",
          {
            fromNodeId: this.nodeId,
            originalEnvelope: envelope,
          },
          attemptTimeoutMs
        );

        if (res.type === "NOT_LEADER") {
          lastError = new Error(`[NOT_LEADER] Target peer "${targetLeader}" stepped down`);
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        return res.payload.responseEnvelope;
      } catch (err) {
        lastError = err as Error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    throw lastError || new Error(`[NO_LEADER] Timed out forwarding ${envelope.type}`);
  }

  private resetElectionTimer(): void {
    if (!this.running) return;
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
    }
    const timeout =
      this.electionMinMs +
      Math.floor(Math.random() * Math.max(20, this.electionMaxMs - this.electionMinMs));
    this.electionTimer = setTimeout(() => {
      if (this.running && this.role !== "leader") {
        this.startElection();
      }
    }, timeout);
  }

  private stepDown(newTerm: number, newLeaderId: string | null = null): void {
    const wasLeader = this.role === "leader";
    if (newTerm > this.currentTerm) {
      this.currentTerm = newTerm;
      this.votedFor = null;
      this.persistRaftState();
    }
    this.role = "follower";
    this.leaderId = newLeaderId;
    this.votesGranted.clear();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (wasLeader) {
      this.rejectAllWaiters(new Error(`[STEPPED_DOWN] Leader "${this.nodeId}" stepped down at term ${newTerm}`));
      this.emit("roleChanged", "follower", this.currentTerm);
    }
    this.resetElectionTimer();
  }

  private startElection(): void {
    if (!this.running) return;
    this.role = "candidate";
    this.currentTerm += 1;
    this.votedFor = this.nodeId;
    this.leaderId = null;
    this.votesGranted.clear();
    this.votesGranted.add(this.nodeId);
    this.persistRaftState();
    this.emit("roleChanged", "candidate", this.currentTerm);

    this.resetElectionTimer();

    if (this.votesGranted.size >= this.getQuorumSize()) {
      this.becomeLeader();
      return;
    }

    const voteReq = createEnvelope<VoteRequestPayload>("VOTE_REQUEST", PEER_NAMESPACE, {
      term: this.currentTerm,
      candidateId: this.nodeId,
      lastLogIndex: this.log.getLastIndex(),
      lastLogTerm: this.log.getLastTerm(),
    });
    this.transport.broadcast(voteReq);
  }

  private becomeLeader(): void {
    if (!this.running) return;
    this.role = "leader";
    this.leaderId = this.nodeId;
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    // Any entry present in the elected leader's log is guaranteed by Raft's election restriction
    // to be committed on a majority; ensure our local state machine has applied up to lastLogIndex.
    if (this.log.getLastIndex() > this.log.getCommitIndex()) {
      this.log.setCommitIndex(this.log.getLastIndex());
    }
    this.applyCommittedEntriesOnFollower();

    const nextIdx = this.log.getLastIndex() + 1;
    this.nextIndex.clear();
    this.matchIndex.clear();
    for (const peer of this.transport.getConnectedPeers()) {
      this.nextIndex.set(peer.nodeId, nextIdx);
      this.matchIndex.set(peer.nodeId, 0);
    }

    this.emit("roleChanged", "leader", this.currentTerm);

    // Send immediate heartbeat / AppendEntries
    this.sendHeartbeats();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.running && this.role === "leader") {
        this.sendHeartbeats();
      }
    }, this.heartbeatMs);
  }

  private sendHeartbeats(): void {
    if (this.role !== "leader") return;
    for (const peer of this.transport.getConnectedPeers()) {
      this.replicateToPeer(peer.nodeId);
    }
  }

  private replicateToAllPeers(): void {
    if (this.role !== "leader" || this.replScheduled) return;
    this.replScheduled = true;
    queueMicrotask(() => {
      this.replScheduled = false;
      if (!this.running || this.role !== "leader") return;
      for (const peer of this.transport.getConnectedPeers()) {
        this.replicateToPeer(peer.nodeId);
      }
    });
  }

  private replicateToPeer(peerId: string): void {
    if (this.role !== "leader" || !this.transport.isPeerConnected(peerId)) return;

    const lastIdx = this.log.getLastIndex();
    const nextIdx = this.nextIndex.get(peerId) ?? lastIdx + 1;

    // If follower needs entries that have already been compacted into a snapshot, send full snapshot
    if (nextIdx <= this.log.getLastIncludedIndex()) {
      this.sendSnapshotToPeer(peerId);
      return;
    }

    const prevLogIndex = nextIdx - 1;
    const prevLogTerm = this.log.getTermAt(prevLogIndex) ?? 0;
    const entries = this.log.getEntriesFrom(nextIdx, 128);

    const env = createEnvelope<ReplAppendPayload>("REPL_APPEND", PEER_NAMESPACE, {
      term: this.currentTerm,
      leaderId: this.nodeId,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.log.getCommitIndex(),
    });
    this.transport.send(peerId, env);
  }

  private sendSnapshotToPeer(peerId: string): void {
    if (this.role !== "leader") return;
    const namespaces = this.callbacks.onExportAllSnapshots();
    const lastIncludedIndex = this.log.getLastIndex();
    const lastIncludedTerm = this.log.getLastTerm();

    const env = createEnvelope<ReplSnapshotChunkPayload>("REPL_SNAPSHOT_CHUNK", PEER_NAMESPACE, {
      term: this.currentTerm,
      leaderId: this.nodeId,
      lastIncludedIndex,
      lastIncludedTerm,
      namespaces,
    });
    this.transport.send(peerId, env);
  }

  private handlePeerMessage(fromNodeId: string, env: Bs9Envelope<any>): void {
    if (!this.running) return;

    switch (env.type) {
      case "VOTE_REQUEST": {
        const payload = env.payload as VoteRequestPayload;
        // Leader lease guard: if we recently heard from a valid leader within electionMinMs, ignore disruptive vote requests
        const hasActiveLeader =
          this.leaderId !== null &&
          this.lastLeaderContactAt > 0 &&
          Date.now() - this.lastLeaderContactAt < this.electionMinMs;

        if (payload.term > this.currentTerm && !hasActiveLeader) {
          this.stepDown(payload.term, null);
        }

        let voteGranted = false;
        if (!hasActiveLeader && payload.term === this.currentTerm) {
          const canVote = this.votedFor === null || this.votedFor === payload.candidateId;
          const myLastTerm = this.log.getLastTerm();
          const myLastIndex = this.log.getLastIndex();
          const logUpToDate =
            payload.lastLogTerm > myLastTerm ||
            (payload.lastLogTerm === myLastTerm && payload.lastLogIndex >= myLastIndex);

          if (canVote && logUpToDate) {
            voteGranted = true;
            this.votedFor = payload.candidateId;
            this.persistRaftState();
            this.resetElectionTimer();
          }
        }

        const reply = createEnvelope<VoteResponsePayload>(
          "VOTE_RESPONSE",
          PEER_NAMESPACE,
          {
            nodeId: this.nodeId,
            term: this.currentTerm,
            voteGranted,
          },
          env.id
        );
        this.transport.send(fromNodeId, reply);
        break;
      }

      case "VOTE_RESPONSE": {
        const payload = env.payload as VoteResponsePayload;
        if (payload.term > this.currentTerm) {
          this.stepDown(payload.term, null);
          return;
        }
        if (this.role === "candidate" && payload.term === this.currentTerm && payload.voteGranted) {
          this.votesGranted.add(fromNodeId);
          if (this.votesGranted.size >= this.getQuorumSize()) {
            this.becomeLeader();
          }
        }
        break;
      }

      case "REPL_APPEND": {
        const payload = env.payload as ReplAppendPayload;
        if (payload.term < this.currentTerm) {
          const rejectAck = createEnvelope<ReplAckPayload>("REPL_ACK", PEER_NAMESPACE, {
            nodeId: this.nodeId,
            term: this.currentTerm,
            success: false,
            matchIndex: this.log.getCommitIndex(),
          });
          this.transport.send(fromNodeId, rejectAck);
          return;
        }

        if (payload.term > this.currentTerm || this.role !== "follower") {
          this.stepDown(payload.term, payload.leaderId);
        } else {
          this.leaderId = payload.leaderId;
          this.resetElectionTimer();
        }
        this.lastLeaderContactAt = Date.now();

        const res = this.log.appendFromLeader(
          payload.prevLogIndex,
          payload.prevLogTerm,
          payload.entries
        );

        if (res.success) {
          if (payload.leaderCommit > this.log.getCommitIndex()) {
            this.log.setCommitIndex(Math.min(payload.leaderCommit, this.log.getLastIndex()));
          }
          this.applyCommittedEntriesOnFollower();
        }

        const ack = createEnvelope<ReplAckPayload>("REPL_ACK", PEER_NAMESPACE, {
          nodeId: this.nodeId,
          term: this.currentTerm,
          success: res.success,
          matchIndex: res.matchIndex,
          conflictIndex: res.conflictIndex,
        });
        this.transport.send(fromNodeId, ack);
        break;
      }

      case "REPL_ACK": {
        const payload = env.payload as ReplAckPayload;
        if (payload.term > this.currentTerm) {
          this.stepDown(payload.term, null);
          return;
        }
        if (this.role !== "leader" || payload.term !== this.currentTerm) return;

        if (payload.success) {
          const prevMatch = this.matchIndex.get(fromNodeId) ?? 0;
          if (payload.matchIndex > prevMatch) {
            this.matchIndex.set(fromNodeId, payload.matchIndex);
          }
          this.nextIndex.set(fromNodeId, payload.matchIndex + 1);
          this.advanceLeaderCommitIndex();

          // If leader has more entries beyond matchIndex, continue streaming
          if (this.log.getLastIndex() > payload.matchIndex) {
            this.replicateToPeer(fromNodeId);
          }
        } else {
          // Backtrack nextIndex
          const currentNext = this.nextIndex.get(fromNodeId) ?? this.log.getLastIndex() + 1;
          const next = payload.conflictIndex
            ? Math.min(currentNext - 1, payload.conflictIndex)
            : Math.max(1, currentNext - 1);
          this.nextIndex.set(fromNodeId, Math.max(1, next));
          this.replicateToPeer(fromNodeId);
        }
        break;
      }

      case "REPL_SNAPSHOT_REQ": {
        const _payload = env.payload as ReplSnapshotReqPayload;
        if (this.role === "leader") {
          this.sendSnapshotToPeer(fromNodeId);
        }
        break;
      }

      case "REPL_SNAPSHOT_CHUNK": {
        const payload = env.payload as ReplSnapshotChunkPayload;
        if (payload.term < this.currentTerm) return;
        if (payload.term > this.currentTerm || this.role !== "follower") {
          this.stepDown(payload.term, payload.leaderId);
        } else {
          this.leaderId = payload.leaderId;
          this.resetElectionTimer();
        }

        this.callbacks.onInstallAllSnapshots(payload.namespaces);
        this.log.installSnapshotMeta(payload.lastIncludedIndex, payload.lastIncludedTerm);

        const ack = createEnvelope<ReplAckPayload>("REPL_ACK", PEER_NAMESPACE, {
          nodeId: this.nodeId,
          term: this.currentTerm,
          success: true,
          matchIndex: payload.lastIncludedIndex,
        });
        this.transport.send(fromNodeId, ack);
        break;
      }

      case "PEER_HEARTBEAT": {
        const payload = env.payload as PeerHeartbeatPayload;
        if (payload.term > this.currentTerm) {
          this.stepDown(payload.term, payload.leaderId);
        }
        const ack = createEnvelope<PeerHeartbeatAckPayload>(
          "PEER_HEARTBEAT_ACK",
          PEER_NAMESPACE,
          {
            nodeId: this.nodeId,
            term: this.currentTerm,
            matchIndex: this.log.getLastIndex(),
            sentAt: payload.sentAt,
          },
          env.id
        );
        this.transport.send(fromNodeId, ack);
        break;
      }

      case "PEER_HEARTBEAT_ACK": {
        const payload = env.payload as PeerHeartbeatAckPayload;
        if (payload.sentAt) {
          this.transport.updatePeerRtt(fromNodeId, Date.now() - payload.sentAt);
        }
        break;
      }

      case "FORWARD_WRITE": {
        const payload = env.payload as ForwardWritePayload;
        if (this.role !== "leader") {
          const notLeader = createEnvelope(
            "NOT_LEADER",
            PEER_NAMESPACE,
            {
              leaderId: this.leaderId,
              term: this.currentTerm,
            },
            env.id
          );
          this.transport.send(fromNodeId, notLeader);
          return;
        }
        this.callbacks
          .onExecuteForwardedWrite(payload.originalEnvelope)
          .then((responseEnvelope) => {
            const reply = createEnvelope<ForwardResultPayload>(
              "FORWARD_RESULT",
              PEER_NAMESPACE,
              { responseEnvelope },
              env.id
            );
            this.transport.send(fromNodeId, reply);
          })
          .catch((err: Error) => {
            const errEnv = createEnvelope(
              "KV_ERROR",
              payload.originalEnvelope.namespace,
              { error: err.message, code: "FORWARD_FAILED" },
              payload.originalEnvelope.id
            );
            const reply = createEnvelope<ForwardResultPayload>(
              "FORWARD_RESULT",
              PEER_NAMESPACE,
              { responseEnvelope: errEnv },
              env.id
            );
            this.transport.send(fromNodeId, reply);
          });
        break;
      }
    }
  }

  private applyCommittedEntriesOnFollower(): void {
    const commitIdx = this.log.getCommitIndex();
    let applied = this.log.getLastApplied();
    while (applied < commitIdx) {
      const next = applied + 1;
      const entry = this.log.getEntry(next);
      if (!entry) break;
      this.callbacks.onApplyCommittedEntry(entry);
      applied = next;
      this.log.setLastApplied(applied);
    }
  }

  private advanceLeaderCommitIndex(): void {
    if (this.role !== "leader") return;
    const lastIdx = this.log.getLastIndex();
    const currentCommit = this.log.getCommitIndex();
    const quorum = this.getQuorumSize();

    for (let n = lastIdx; n > currentCommit; n--) {
      if (this.log.getTermAt(n) !== this.currentTerm) continue;
      let count = 1; // self
      for (const peer of this.transport.getConnectedPeers()) {
        if ((this.matchIndex.get(peer.nodeId) ?? 0) >= n) {
          count++;
        }
      }
      if (count >= quorum) {
        this.log.setCommitIndex(n);
        this.resolveWaitersUpTo(n);
        break;
      }
    }
  }

  private resolveWaitersUpTo(committedIndex: number): void {
    for (const [idx, waiters] of this.commitWaiters.entries()) {
      if (idx <= committedIndex) {
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.resolve();
        }
        this.commitWaiters.delete(idx);
      }
    }
  }

  private removeWaiter(index: number, waiter: PendingCommitWaiter): void {
    const list = this.commitWaiters.get(index);
    if (!list) return;
    const filtered = list.filter((w) => w !== waiter);
    if (filtered.length === 0) {
      this.commitWaiters.delete(index);
    } else {
      this.commitWaiters.set(index, filtered);
    }
  }

  private rejectAllWaiters(err: Error): void {
    for (const [, waiters] of this.commitWaiters.entries()) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    }
    this.commitWaiters.clear();
  }
}
