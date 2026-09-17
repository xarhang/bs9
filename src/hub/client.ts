/**
 * BS9 - State Hub Client
 *
 * Lightweight, high-performance client for interacting with the BS9 State Hub:
 * - Connects over Unix Domain Socket or Named Pipe.
 * - Handles Nonce / HMAC challenge-response authentication.
 * - Strict 4-byte framing protocol with request-response correlation.
 * - Exposes get, set, delete, incr, cas, and snapshot methods.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  computeHmac,
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
} from "./protocol.js";
import { getDefaultHubSocketPath } from "./server.js";

export interface HubClientOptions {
  socketPath?: string;
  namespace?: string;
  authToken?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: any;
}

export class HubClient extends EventEmitter {
  private socket: Socket | null = null;
  private decoder: StreamingFrameDecoder = new StreamingFrameDecoder();
  private socketPath: string;
  private namespace: string;
  private authToken: string;
  private requestTimeoutMs: number;
  private connectTimeoutMs: number;
  private isConnected = false;
  private isAuthenticated = false;
  private pendingRequests: Map<string, PendingRequest> = new Map();

  constructor(options: HubClientOptions = {}) {
    super();
    this.socketPath = options.socketPath || process.env.BS9_HUB_SOCKET || getDefaultHubSocketPath();
    this.namespace = options.namespace || "default";
    this.authToken = options.authToken || process.env.BS9_AUTH_TOKEN || "";
    this.requestTimeoutMs = options.requestTimeoutMs || 5000;
    this.connectTimeoutMs = options.connectTimeoutMs || 5000;
  }

  public get connected(): boolean {
    return this.isConnected && this.isAuthenticated;
  }

  /**
   * Connects to the State Hub and performs HMAC authentication.
   */
  public async connect(): Promise<boolean> {
    if (this.socket) {
      return this.isConnected && this.isAuthenticated;
    }

    return new Promise((resolve) => {
      let settled = false;

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.disconnect();
          resolve(false);
        }
      }, this.connectTimeoutMs);

      try {
        this.socket = createConnection(this.socketPath);
      } catch {
        clearTimeout(timeoutTimer);
        return resolve(false);
      }

      this.socket.on("connect", () => {
        this.isConnected = true;
      });

      this.socket.on("data", (chunk: Buffer) => {
        try {
          const envelopes = this.decoder.push(chunk);
          for (const envelope of envelopes) {
            this.handleEnvelope(envelope, (authSuccess) => {
              if (!settled) {
                settled = true;
                clearTimeout(timeoutTimer);
                resolve(authSuccess);
              }
            });
          }
        } catch (err) {
          this.emit("error", err);
        }
      });

      this.socket.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          resolve(false);
        }
        this.emit("error", err);
      });

      this.socket.on("close", () => {
        this.isConnected = false;
        this.isAuthenticated = false;
        this.rejectAllPending(new Error("Connection closed"));
        this.emit("close");
      });
    });
  }

  private handleEnvelope(
    envelope: Bs9Envelope,
    onHandshakeResult: (success: boolean) => void
  ): void {
    if (envelope.type === "HANDSHAKE_CHALLENGE") {
      const payload = envelope.payload as HandshakeChallengePayload;
      const hmac = computeHmac(payload.nonce, this.authToken);
      const responseEnv = createEnvelope<HandshakeResponsePayload>(
        "HANDSHAKE_RESPONSE",
        this.namespace,
        {
          namespace: this.namespace,
          clusterName: this.namespace,
          slot: 0,
          generation: 1,
          pid: process.pid,
          hmac,
        }
      );
      try {
        this.socket?.write(encodeFrame(responseEnv));
      } catch {
        onHandshakeResult(false);
      }
      return;
    }

    if (envelope.type === "HANDSHAKE_ACK") {
      this.isAuthenticated = true;
      onHandshakeResult(true);
      return;
    }

    if (envelope.type === "HANDSHAKE_REJECT") {
      this.isAuthenticated = false;
      onHandshakeResult(false);
      this.disconnect();
      return;
    }

    // Correlate reply with pending request
    if (envelope.replyTo && this.pendingRequests.has(envelope.replyTo)) {
      const req = this.pendingRequests.get(envelope.replyTo)!;
      this.pendingRequests.delete(envelope.replyTo);
      clearTimeout(req.timer);

      if (envelope.type === "KV_ERROR") {
        const errPayload = envelope.payload as KvErrorPayload;
        req.reject(new Error(errPayload.error || "Hub request failed"));
      } else {
        req.resolve(envelope.payload);
      }
    }
  }

  private sendRequest<T = any>(type: string, payload: any): Promise<T> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error("Hub client is not connected or authenticated"));
    }

    return new Promise((resolve, reject) => {
      const envelope = createEnvelope(type, this.namespace, payload);

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(envelope.id)) {
          this.pendingRequests.delete(envelope.id);
          reject(new Error(`Hub request timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);

      this.pendingRequests.set(envelope.id, { resolve, reject, timer });

      try {
        this.socket!.write(encodeFrame(envelope));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(envelope.id);
        reject(err);
      }
    });
  }

  public async get<T = any>(key: string): Promise<T | null> {
    const res = await this.sendRequest<KvGetResponsePayload>("KV_GET", { key });
    return res.found ? (res.value as T) : null;
  }

  public async set(key: string, value: any, ttlMs?: number): Promise<boolean> {
    const res = await this.sendRequest<KvSetResponsePayload>("KV_SET", { key, value, ttlMs });
    return res.success;
  }

  public async delete(key: string): Promise<boolean> {
    const res = await this.sendRequest<KvDeleteResponsePayload>("KV_DELETE", { key });
    return res.deleted;
  }

  public async incr(key: string, delta: number = 1): Promise<number> {
    const res = await this.sendRequest<KvIncrResponsePayload>("KV_INCR", { key, delta });
    return res.value;
  }

  public async cas(
    key: string,
    expectedValue: any,
    newValue: any,
    ttlMs?: number
  ): Promise<{ success: boolean; currentValue: any }> {
    const res = await this.sendRequest<KvCasResponsePayload>("KV_CAS", {
      key,
      expectedValue,
      newValue,
      ttlMs,
    });
    return {
      success: res.success,
      currentValue: res.currentValue,
    };
  }

  public async snapshot(): Promise<boolean> {
    const res = await this.sendRequest<KvSnapshotResponsePayload>("KV_SNAPSHOT", {});
    return res.success;
  }

  // --- Distributed Lease Methods ---

  public async leaseAcquire(
    leaseName: string,
    ttlMs: number,
    ownerId: string
  ): Promise<LeaseAcquireResponsePayload> {
    return this.sendRequest<LeaseAcquireResponsePayload>("LEASE_ACQUIRE", {
      leaseName,
      ttlMs,
      ownerId,
    });
  }

  public async leaseRenew(
    leaseName: string,
    fencingToken: number,
    ttlMs: number
  ): Promise<LeaseRenewResponsePayload> {
    return this.sendRequest<LeaseRenewResponsePayload>("LEASE_RENEW", {
      leaseName,
      fencingToken,
      ttlMs,
    });
  }

  public async leaseRelease(
    leaseName: string,
    fencingToken: number
  ): Promise<LeaseReleaseResponsePayload> {
    return this.sendRequest<LeaseReleaseResponsePayload>("LEASE_RELEASE", {
      leaseName,
      fencingToken,
    });
  }

  // --- Durable Queue Methods ---

  public async queuePublish(
    queueName: string,
    payload: any,
    options?: Record<string, any>
  ): Promise<QueuePublishResponsePayload> {
    return this.sendRequest<QueuePublishResponsePayload>("QUEUE_PUBLISH", {
      queueName,
      payload,
      options,
    });
  }

  public async queueReserve(
    queueName: string,
    visibilityTimeoutMs: number = 30000,
    maxMessages: number = 1
  ): Promise<QueueReserveResponsePayload> {
    const res = await this.sendRequest<QueueReserveResponsePayload>("QUEUE_RESERVE", {
      queueName,
      visibilityTimeoutMs,
      maxMessages,
    });
    return res;
  }

  public async queueAck(queueName: string, messageId: string): Promise<QueueAckResponsePayload> {
    const res = await this.sendRequest<QueueAckResponsePayload>("QUEUE_ACK", {
      queueName,
      messageId,
    });
    return res;
  }

  public async queueNack(queueName: string, messageId: string): Promise<QueueNackResponsePayload> {
    const res = await this.sendRequest<QueueNackResponsePayload>("QUEUE_NACK", {
      queueName,
      messageId,
    });
    return res;
  }

  private rejectAllPending(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  public async disconnect(): Promise<void> {
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      this.isConnected = false;
      this.isAuthenticated = false;
      this.rejectAllPending(new Error("Client disconnected"));
      try {
        sock.destroy();
      } catch {}
    }
  }
}
