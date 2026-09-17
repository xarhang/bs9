/**
 * BS9 - Strict 4-Byte Wire Protocol & Frame Framing
 *
 * Implements:
 * - 4-byte unsigned big-endian integer length prefix + UTF-8 JSON payload.
 * - Max frame guard: 16 MB.
 * - Envelope schema & validation.
 * - Cryptographic nonce / HMAC handshake helpers.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB max frame size
export const MAX_VALUE_SIZE = 1 * 1024 * 1024; // 1 MB max per value
export const MAX_NAMESPACE_MEMORY = 100 * 1024 * 1024; // 100 MB max per namespace

export interface Bs9Envelope<T = unknown> {
  protocolVersion: 1;
  id: string;
  replyTo?: string;
  type: string;
  namespace: string;
  timestamp: number;
  payload: T;
}

export type HubKvMessageType =
  | "KV_GET"
  | "KV_GET_RESPONSE"
  | "KV_SET"
  | "KV_SET_RESPONSE"
  | "KV_DELETE"
  | "KV_DELETE_RESPONSE"
  | "KV_INCR"
  | "KV_INCR_RESPONSE"
  | "KV_CAS"
  | "KV_CAS_RESPONSE"
  | "KV_SNAPSHOT"
  | "KV_SNAPSHOT_RESPONSE"
  | "KV_ERROR";

export type HubLeaseMessageType =
  | "LEASE_ACQUIRE"
  | "LEASE_ACQUIRE_RESPONSE"
  | "LEASE_RENEW"
  | "LEASE_RENEW_RESPONSE"
  | "LEASE_RELEASE"
  | "LEASE_RELEASE_RESPONSE";

export type HubQueueMessageType =
  | "QUEUE_PUBLISH"
  | "QUEUE_PUBLISH_RESPONSE"
  | "QUEUE_RESERVE"
  | "QUEUE_RESERVE_RESPONSE"
  | "QUEUE_ACK"
  | "QUEUE_ACK_RESPONSE"
  | "QUEUE_NACK"
  | "QUEUE_NACK_RESPONSE";

export interface KvGetPayload {
  key: string;
}

export interface KvGetResponsePayload {
  key: string;
  found: boolean;
  value: any;
}

export interface KvSetPayload {
  key: string;
  value: any;
  ttlMs?: number;
}

export interface KvSetResponsePayload {
  key: string;
  success: boolean;
}

export interface KvDeletePayload {
  key: string;
}

export interface KvDeleteResponsePayload {
  key: string;
  deleted: boolean;
}

export interface KvIncrPayload {
  key: string;
  delta?: number;
}

export interface KvIncrResponsePayload {
  key: string;
  value: number;
  success: boolean;
}

export interface KvCasPayload {
  key: string;
  expectedValue: any;
  newValue: any;
  ttlMs?: number;
}

export interface KvCasResponsePayload {
  key: string;
  success: boolean;
  currentValue: any;
}

export interface KvSnapshotPayload {
  namespace?: string;
}

export interface KvSnapshotResponsePayload {
  success: boolean;
  snapshotPath?: string;
  timestamp?: number;
}

export interface KvErrorPayload {
  error: string;
  code?: string;
}

export interface LeaseAcquirePayload {
  leaseName: string;
  ttlMs: number;
  ownerId: string;
}

export interface LeaseAcquireResponsePayload {
  leaseName: string;
  acquired: boolean;
  fencingToken: number;
  expiresAt?: number;
  currentOwner?: string;
}

export interface LeaseRenewPayload {
  leaseName: string;
  fencingToken: number;
  ttlMs: number;
}

export interface LeaseRenewResponsePayload {
  leaseName: string;
  renewed: boolean;
  expiresAt?: number;
  fencingToken?: number;
  error?: string;
}

export interface LeaseReleasePayload {
  leaseName: string;
  fencingToken: number;
}

export interface LeaseReleaseResponsePayload {
  leaseName: string;
  released: boolean;
}

export interface QueuePublishPayload {
  queueName: string;
  payload: any;
  options?: Record<string, any>;
}

export interface QueuePublishResponsePayload {
  queueName: string;
  messageId: string;
  success: boolean;
}

export interface QueueReservePayload {
  queueName: string;
  visibilityTimeoutMs?: number;
  maxMessages?: number;
}

export interface ReservedMessage {
  id: string;
  payload: any;
  deliveryCount: number;
  reservedUntil: number;
}

export interface QueueReserveResponsePayload {
  queueName: string;
  messages: ReservedMessage[];
}

export interface QueueAckPayload {
  queueName: string;
  messageId: string;
}

export interface QueueAckResponsePayload {
  queueName: string;
  messageId: string;
  acked: boolean;
}

export interface QueueNackPayload {
  queueName: string;
  messageId: string;
}

export interface QueueNackResponsePayload {
  queueName: string;
  messageId: string;
  nacked: boolean;
}

export type LifecycleMessageType =
  | "HANDSHAKE_CHALLENGE"
  | "HANDSHAKE_RESPONSE"
  | "HANDSHAKE_ACK"
  | "HANDSHAKE_REJECT"
  | "LIFECYCLE_READY"
  | "LIFECYCLE_HEARTBEAT"
  | "DRAIN_REQUEST"
  | "DRAINED"
  | "LIFECYCLE_STOPPED"
  | "LIFECYCLE_FAILED";

export interface HandshakeChallengePayload {
  nonce: string;
}

export interface HandshakeResponsePayload {
  namespace: string;
  clusterName: string;
  slot: number;
  generation: number;
  pid: number;
  hmac: string;
}

export interface HandshakeAckPayload {
  authenticated: true;
  workerKey?: string;
  isAdmin?: boolean;
}

export type AdminMessageType =
  | "ADMIN_HANDSHAKE_RESPONSE"
  | "ADMIN_REGISTER_CLUSTER"
  | "ADMIN_REGISTER_CLUSTER_RESPONSE"
  | "ADMIN_IS_SLOT_READY"
  | "ADMIN_IS_SLOT_READY_RESPONSE"
  | "ADMIN_DRAIN_WORKER"
  | "ADMIN_DRAIN_WORKER_RESPONSE"
  | "ADMIN_GET_CLUSTER_WORKERS"
  | "ADMIN_GET_CLUSTER_WORKERS_RESPONSE"
  | "ADMIN_SET_MANIFEST"
  | "ADMIN_SET_MANIFEST_RESPONSE"
  | "ADMIN_GET_MANIFEST"
  | "ADMIN_GET_MANIFEST_RESPONSE"
  | "ADMIN_DELETE_MANIFEST"
  | "ADMIN_DELETE_MANIFEST_RESPONSE"
  | "ADMIN_LOCK_CLUSTER"
  | "ADMIN_LOCK_CLUSTER_RESPONSE"
  | "ADMIN_UNLOCK_CLUSTER"
  | "ADMIN_UNLOCK_CLUSTER_RESPONSE"
  | "ADMIN_PING"
  | "ADMIN_PING_RESPONSE"
  | "ADMIN_ERROR";

export interface AdminHandshakeResponsePayload {
  adminHmac: string;
  pid: number;
}

export interface AdminRegisterClusterPayload {
  clusterName: string;
  explicitToken?: string;
}

export interface AdminRegisterClusterResponsePayload {
  clusterName: string;
  token: string;
  tokenFilePath: string;
}

export interface AdminIsSlotReadyPayload {
  clusterName: string;
  slot: number;
  generation?: number;
}

export interface AdminIsSlotReadyResponsePayload {
  clusterName: string;
  slot: number;
  ready: boolean;
  generation?: number;
}

export interface AdminDrainWorkerPayload {
  clusterName: string;
  slot: number;
  generation: number;
  drainTimeoutMs?: number;
}

export interface AdminDrainWorkerResponsePayload {
  clusterName: string;
  slot: number;
  generation: number;
  drained: boolean;
  inFlightRemaining: number;
}

export interface AdminGetClusterWorkersPayload {
  clusterName: string;
}

export interface AdminClusterWorkerInfo {
  slot: number;
  generation: number;
  pid: number;
  status: string;
  port?: number;
  lastHeartbeatAt: number;
}

export interface AdminGetClusterWorkersResponsePayload {
  clusterName: string;
  workers: AdminClusterWorkerInfo[];
}

export interface ClusterManifestData {
  clusterName: string;
  appFile: string;
  instances: number;
  port: number;
  host: string;
  env: Record<string, string>;
  options?: Record<string, any>;
  currentGeneration?: number;
  updatedAt: number;
}

export interface AdminSetManifestPayload {
  manifest: ClusterManifestData;
}

export interface AdminSetManifestResponsePayload {
  clusterName: string;
  success: boolean;
}

export interface AdminGetManifestPayload {
  clusterName: string;
}

export interface AdminGetManifestResponsePayload {
  clusterName: string;
  found: boolean;
  manifest?: ClusterManifestData;
}

export interface AdminDeleteManifestPayload {
  clusterName: string;
}

export interface AdminDeleteManifestResponsePayload {
  clusterName: string;
  deleted: boolean;
}

export interface AdminLockClusterPayload {
  clusterName: string;
  reason: "reload" | "scale" | "stop" | "manual";
  timeoutMs?: number;
  ownerId?: string;
}

export interface AdminLockClusterResponsePayload {
  clusterName: string;
  locked: boolean;
  lockToken: string | null;
  reason?: string;
  currentOwner?: string;
}

export interface AdminRenewClusterLockPayload {
  clusterName: string;
  lockToken: string;
  extendMs?: number;
}

export interface AdminRenewClusterLockResponsePayload {
  clusterName: string;
  renewed: boolean;
  expiresAt?: number;
}

export interface AdminUnlockClusterPayload {
  clusterName: string;
  lockToken: string;
}

export interface AdminUnlockClusterResponsePayload {
  clusterName: string;
  unlocked: boolean;
}

export interface AdminPingResponsePayload {
  status: "ok" | "degraded";
  timestamp: number;
  controller: {
    listening: boolean;
    socketPath: string;
    connectedWorkersCount: number;
  };
  hub: {
    listening: boolean;
    namespacesCount: number;
    walRecovered: boolean;
    walRecordsCount: number;
  };
  reconciler: {
    active: boolean;
    lockedClusters: string[];
    managedClustersCount: number;
  };
}

export interface AdminErrorPayload {
  error: string;
  code?: string;
}

export interface HandshakeRejectPayload {
  reason: string;
}

export interface LifecycleReadyPayload {
  port: number;
  host?: string;
  protocol?: string;
  metadata?: Record<string, unknown>;
}

export interface LifecycleHeartbeatPayload {
  uptime: number;
  memoryUsage?: {
    rss: number;
    heapUsed: number;
  };
}

export interface DrainRequestPayload {
  drainTimeoutMs: number;
  reason?: string;
}

export interface DrainedPayload {
  inFlightRemaining: number;
  drainDurationMs: number;
}

export interface LifecycleStoppedPayload {
  exitCode?: number;
  signal?: string;
}

export interface LifecycleFailedPayload {
  error: string;
  fatal: boolean;
}

/**
 * Encodes a Bs9Envelope into a 4-byte length-prefixed Buffer.
 */
export function encodeFrame(envelope: Bs9Envelope): Buffer {
  const jsonStr = JSON.stringify(envelope);
  const payloadBuf = Buffer.from(jsonStr, "utf-8");

  if (payloadBuf.length > MAX_FRAME_SIZE) {
    throw new Error(
      `Frame payload size ${payloadBuf.length} exceeds maximum allowed ${MAX_FRAME_SIZE} bytes`
    );
  }

  const frame = Buffer.allocUnsafe(4 + payloadBuf.length);
  frame.writeUInt32BE(payloadBuf.length, 0);
  payloadBuf.copy(frame, 4);
  return frame;
}

/**
 * Creates a standard envelope with default metadata.
 */
export function createEnvelope<T = unknown>(
  type: string,
  namespace: string,
  payload: T,
  replyTo?: string
): Bs9Envelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: generateId(),
    replyTo,
    type,
    namespace,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Streaming decoder that consumes incoming TCP / Socket chunks
 * and yields fully assembled Bs9Envelope frames.
 */
export class StreamingFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Pushes a raw chunk of bytes and returns any complete envelopes decoded.
   */
  public push(chunk: Buffer): Bs9Envelope[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const envelopes: Bs9Envelope[] = [];

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32BE(0);

      if (frameLength > MAX_FRAME_SIZE) {
        throw new Error(
          `Security violation: incoming frame length ${frameLength} exceeds maximum limit of ${MAX_FRAME_SIZE} bytes`
        );
      }

      const totalLength = 4 + frameLength;
      if (this.buffer.length < totalLength) {
        // Need more data from stream
        break;
      }

      const payloadSlice = this.buffer.subarray(4, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const jsonStr = payloadSlice.toString("utf-8");
        const parsed = JSON.parse(jsonStr) as Bs9Envelope;

        if (
          !parsed ||
          typeof parsed !== "object" ||
          parsed.protocolVersion !== PROTOCOL_VERSION ||
          typeof parsed.type !== "string"
        ) {
          throw new Error("Invalid envelope format");
        }

        envelopes.push(parsed);
      } catch (err) {
        throw new Error(`Failed to parse frame JSON payload: ${(err as Error).message}`);
      }
    }

    return envelopes;
  }

  /**
   * Current unconsumed buffer length (useful for diagnostics).
   */
  public get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Resets internal decoder buffer.
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Cryptographic helpers for HMAC authentication handshake.
 */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export function computeHmac(nonce: string, token: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}

export function verifyHmac(nonce: string, token: string, candidateHmac: string): boolean {
  if (!candidateHmac || typeof candidateHmac !== "string") return false;
  try {
    const expected = computeHmac(nonce, token);
    const expectedBuf = Buffer.from(expected, "hex");
    const candidateBuf = Buffer.from(candidateHmac, "hex");
    if (expectedBuf.length !== candidateBuf.length) return false;
    return timingSafeEqual(expectedBuf, candidateBuf);
  } catch {
    return false;
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function generateId(): string {
  return randomBytes(12).toString("hex");
}
