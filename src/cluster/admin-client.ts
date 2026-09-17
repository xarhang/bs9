/**
 * BS9 - Controller Admin Client
 *
 * Client used by CLI commands (reload, start, scale, stop, status) to communicate
 * securely with the running BS9 Controller / Hub Daemon using dedicated admin authorization.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createConnection, type Socket } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  computeHmac,
  type Bs9Envelope,
  type HandshakeChallengePayload,
  type HandshakeAckPayload,
  type AdminHandshakeResponsePayload,
  type AdminRegisterClusterPayload,
  type AdminRegisterClusterResponsePayload,
  type AdminIsSlotReadyPayload,
  type AdminIsSlotReadyResponsePayload,
  type AdminDrainWorkerPayload,
  type AdminDrainWorkerResponsePayload,
  type AdminGetClusterWorkersPayload,
  type AdminGetClusterWorkersResponsePayload,
  type AdminClusterWorkerInfo,
  type AdminSetManifestPayload,
  type AdminSetManifestResponsePayload,
  type AdminGetManifestPayload,
  type AdminGetManifestResponsePayload,
  type AdminDeleteManifestPayload,
  type AdminDeleteManifestResponsePayload,
  type AdminLockClusterPayload,
  type AdminLockClusterResponsePayload,
  type AdminRenewClusterLockPayload,
  type AdminRenewClusterLockResponsePayload,
  type AdminUnlockClusterPayload,
  type AdminUnlockClusterResponsePayload,
  type AdminPingResponsePayload,
  type AdminErrorPayload,
  type ClusterManifestData,
} from "../hub/protocol.js";
import { getPlatformInfo } from "../platform/detect.js";

export interface AdminClientOptions {
  socketPath?: string;
  adminToken?: string;
  adminTokenFile?: string;
  timeoutMs?: number;
}

interface PendingRequest<T = any> {
  resolve: (val: T) => void;
  reject: (err: Error) => void;
  timer: any;
}

export class ControllerAdminClient extends EventEmitter {
  private socket: Socket | null = null;
  private decoder: StreamingFrameDecoder = new StreamingFrameDecoder();
  private socketPath: string;
  private adminToken: string = "";
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private isConnected = false;
  private isAuthenticated = false;

  constructor(options: AdminClientOptions = {}) {
    super();
    const platformInfo = getPlatformInfo();
    this.socketPath = options.socketPath || platformInfo.socketPath;

    if (options.adminToken) {
      this.adminToken = options.adminToken;
    } else {
      const tokenFile = options.adminTokenFile || join(platformInfo.runtimeDir, "tokens", "admin.token");
      if (existsSync(tokenFile)) {
        try {
          this.adminToken = readFileSync(tokenFile, "utf-8").trim();
        } catch {}
      }
    }
  }

  public async connect(timeoutMs = 5000): Promise<boolean> {
    if (this.isConnected && this.isAuthenticated) return true;

    return new Promise((resolve, reject) => {
      try {
        const sock = createConnection(this.socketPath);
        this.socket = sock;

        let authTimeout: any = null;

        const onConnectTimeout = setTimeout(() => {
          this.disconnect();
          resolve(false);
        }, timeoutMs);

        sock.on("connect", () => {
          this.isConnected = true;
        });

        sock.on("data", (chunk: Buffer) => {
          try {
            const envelopes = this.decoder.push(chunk);
            for (const env of envelopes) {
              this.handleMessage(env, () => {
                clearTimeout(onConnectTimeout);
                if (authTimeout) clearTimeout(authTimeout);
                resolve(true);
              }, (_err) => {
                clearTimeout(onConnectTimeout);
                if (authTimeout) clearTimeout(authTimeout);
                resolve(false);
              });
            }
          } catch {
            clearTimeout(onConnectTimeout);
            resolve(false);
          }
        });

        sock.on("close", () => {
          clearTimeout(onConnectTimeout);
          if (authTimeout) clearTimeout(authTimeout);
          this.cleanup();
          this.emit("close");
        });

        sock.on("error", () => {
          clearTimeout(onConnectTimeout);
          if (authTimeout) clearTimeout(authTimeout);
          this.cleanup();
          resolve(false);
        });
      } catch {
        this.cleanup();
        resolve(false);
      }
    });
  }

  private handleMessage(
    envelope: Bs9Envelope,
    onAuthSuccess: () => void,
    onAuthFail: (err: Error) => void
  ): void {
    if (envelope.type === "HANDSHAKE_CHALLENGE") {
      const payload = envelope.payload as HandshakeChallengePayload;
      if (!this.adminToken) {
        const platformInfo = getPlatformInfo();
        const tokenFile = join(platformInfo.runtimeDir, "tokens", "admin.token");
        if (existsSync(tokenFile)) {
          try {
            this.adminToken = readFileSync(tokenFile, "utf-8").trim();
          } catch {}
        }
      }

      if (!this.adminToken) {
        onAuthFail(new Error("Admin token not found; cannot authenticate as admin."));
        this.disconnect();
        return;
      }

      const adminHmac = computeHmac(payload.nonce, this.adminToken);
      const responseEnv = createEnvelope<AdminHandshakeResponsePayload>(
        "ADMIN_HANDSHAKE_RESPONSE",
        "system",
        {
          adminHmac,
          pid: process.pid,
        }
      );

      try {
        this.socket?.write(encodeFrame(responseEnv));
      } catch (err) {
        onAuthFail(err as Error);
      }
      return;
    }

    if (envelope.type === "HANDSHAKE_ACK") {
      const payload = envelope.payload as HandshakeAckPayload;
      if (payload.isAdmin) {
        this.isAuthenticated = true;
        this.emit("authenticated");
        onAuthSuccess();
      } else {
        onAuthFail(new Error("Controller refused admin authorization."));
        this.disconnect();
      }
      return;
    }

    if (envelope.type === "HANDSHAKE_REJECT") {
      onAuthFail(new Error("Admin handshake rejected: " + JSON.stringify(envelope.payload)));
      this.disconnect();
      return;
    }

    // Correlation with pending requests
    if (envelope.replyTo && this.pendingRequests.has(envelope.replyTo)) {
      const req = this.pendingRequests.get(envelope.replyTo)!;
      this.pendingRequests.delete(envelope.replyTo);
      clearTimeout(req.timer);

      if (envelope.type === "ADMIN_ERROR") {
        const payload = envelope.payload as AdminErrorPayload;
        req.reject(new Error(payload.error || "Admin request failed"));
      } else {
        req.resolve(envelope.payload);
      }
    }
  }

  private sendRequest<T = any>(type: string, payload: any, timeoutMs = 15000): Promise<T> {
    if (!this.socket || !this.isConnected || !this.isAuthenticated) {
      return Promise.reject(new Error("AdminClient is not connected and authenticated"));
    }

    return new Promise((resolve, reject) => {
      const envelope = createEnvelope(type, "system", payload);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(envelope.id);
        reject(new Error(`Admin request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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

  public async registerCluster(clusterName: string, explicitToken?: string): Promise<{ token: string; tokenFilePath: string }> {
    const res = await this.sendRequest<AdminRegisterClusterResponsePayload>("ADMIN_REGISTER_CLUSTER", {
      clusterName,
      explicitToken,
    });
    return { token: res.token, tokenFilePath: res.tokenFilePath };
  }

  public async isSlotReady(clusterName: string, slot: number, generation?: number): Promise<boolean> {
    const res = await this.sendRequest<AdminIsSlotReadyResponsePayload>("ADMIN_IS_SLOT_READY", {
      clusterName,
      slot,
      generation,
    });
    return res.ready;
  }

  public async drainWorker(
    clusterName: string,
    slot: number,
    generation: number,
    drainTimeoutMs = 10000
  ): Promise<{ drained: boolean; inFlightRemaining: number }> {
    const res = await this.sendRequest<AdminDrainWorkerResponsePayload>(
      "ADMIN_DRAIN_WORKER",
      {
        clusterName,
        slot,
        generation,
        drainTimeoutMs,
      },
      drainTimeoutMs + 5000
    );
    return { drained: res.drained, inFlightRemaining: res.inFlightRemaining };
  }

  public async getClusterWorkers(clusterName: string): Promise<AdminClusterWorkerInfo[]> {
    const res = await this.sendRequest<AdminGetClusterWorkersResponsePayload>("ADMIN_GET_CLUSTER_WORKERS", {
      clusterName,
    });
    return res.workers || [];
  }

  public async setManifest(manifest: ClusterManifestData): Promise<boolean> {
    const res = await this.sendRequest<AdminSetManifestResponsePayload>("ADMIN_SET_MANIFEST", { manifest });
    return res.success;
  }

  public async getManifest(clusterName: string): Promise<ClusterManifestData | null> {
    const res = await this.sendRequest<AdminGetManifestResponsePayload>("ADMIN_GET_MANIFEST", { clusterName });
    return res.found && res.manifest ? res.manifest : null;
  }

  public async deleteManifest(clusterName: string): Promise<boolean> {
    const res = await this.sendRequest<AdminDeleteManifestResponsePayload>("ADMIN_DELETE_MANIFEST", { clusterName });
    return res.deleted;
  }

  public async lockCluster(
    clusterName: string,
    reason: "reload" | "scale" | "stop" | "manual",
    timeoutMs = 60000,
    ownerId?: string
  ): Promise<{ locked: boolean; lockToken: string | null; reason?: string; currentOwner?: string }> {
    const res = await this.sendRequest<AdminLockClusterResponsePayload>("ADMIN_LOCK_CLUSTER", {
      clusterName,
      reason,
      timeoutMs,
      ownerId,
    });
    return {
      locked: res.locked,
      lockToken: res.lockToken,
      reason: res.reason,
      currentOwner: res.currentOwner,
    };
  }

  public async renewClusterLock(
    clusterName: string,
    lockToken: string,
    extendMs = 30000
  ): Promise<boolean> {
    const res = await this.sendRequest<AdminRenewClusterLockResponsePayload>("ADMIN_RENEW_CLUSTER_LOCK", {
      clusterName,
      lockToken,
      extendMs,
    });
    return res.renewed;
  }

  public async unlockCluster(clusterName: string, lockToken: string): Promise<boolean> {
    const res = await this.sendRequest<AdminUnlockClusterResponsePayload>("ADMIN_UNLOCK_CLUSTER", {
      clusterName,
      lockToken,
    });
    return res.unlocked;
  }

  public async acquireLockSession(
    clusterName: string,
    reason: "reload" | "scale" | "stop" | "manual",
    timeoutMs = 60000,
    ownerId?: string,
    options?: LockSessionOptions
  ): Promise<ClusterLockSession | null> {
    const lockRes = await this.lockCluster(clusterName, reason, timeoutMs, ownerId);
    if (!lockRes.locked || !lockRes.lockToken) {
      return null;
    }
    const session = new ClusterLockSession(this, clusterName, lockRes.lockToken, options);
    session.start();
    return session;
  }

  public async ping(): Promise<AdminPingResponsePayload> {
    return await this.sendRequest<AdminPingResponsePayload>("ADMIN_PING", {}, 5000);
  }

  public disconnect(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.isConnected = false;
    this.isAuthenticated = false;
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error("AdminClient disconnected"));
    }
    this.pendingRequests.clear();
  }
}

export interface LockSessionOptions {
  renewIntervalMs?: number;
  extendMs?: number;
  onLost?: (error: Error) => void;
}

export class ClusterLockSession {
  private timer: any = null;
  private aborted = false;
  private error: Error | null = null;
  private readonly abortController = new AbortController();
  private readonly renewIntervalMs: number;
  private readonly extendMs: number;
  private readonly onLostCallback?: (error: Error) => void;

  constructor(
    private readonly adminClient: ControllerAdminClient,
    public readonly clusterName: string,
    public readonly lockToken: string,
    options: LockSessionOptions = {}
  ) {
    this.renewIntervalMs = options.renewIntervalMs || 15000;
    this.extendMs = options.extendMs || 60000;
    this.onLostCallback = options.onLost;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.aborted) return;
      try {
        const renewed = await this.adminClient.renewClusterLock(
          this.clusterName,
          this.lockToken,
          this.extendMs
        );
        if (!renewed) {
          this.handleLost(new Error(`Cluster lock for '${this.clusterName}' was lost or expired`));
        }
      } catch (err: any) {
        this.handleLost(new Error(`Failed to renew cluster lock for '${this.clusterName}': ${err.message}`));
      }
    }, this.renewIntervalMs);

    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  private handleLost(err: Error): void {
    if (this.aborted) return;
    this.aborted = true;
    this.error = err;
    this.abortController.abort(err);
    this.stop();
    if (this.onLostCallback) {
      try {
        this.onLostCallback(err);
      } catch {}
    }
  }

  public isLost(): boolean {
    return this.aborted;
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public checkActive(): void {
    if (this.aborted) {
      throw this.error || new Error(`Operation aborted: cluster lock for '${this.clusterName}' was lost or expired`);
    }
  }

  /** Validate ownership at a side-effect boundary without waiting for the timer. */
  public async assertActive(): Promise<void> {
    this.checkActive();
    try {
      const renewed = await this.adminClient.renewClusterLock(
        this.clusterName,
        this.lockToken,
        this.extendMs
      );
      if (!renewed) {
        this.handleLost(new Error(`Cluster lock for '${this.clusterName}' was lost or expired`));
      }
    } catch (error: any) {
      this.handleLost(new Error(`Failed to validate cluster lock for '${this.clusterName}': ${error.message}`));
    }
    this.checkActive();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async release(): Promise<boolean> {
    this.stop();
    if (this.aborted) return false;
    try {
      return await this.adminClient.unlockCluster(this.clusterName, this.lockToken);
    } catch {
      return false;
    }
  }
}
