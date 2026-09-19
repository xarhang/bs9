/**
 * BS9 - Cluster Lifecycle Controller
 *
 * Persistent IPC server hosting worker lifecycle management:
 * - Listens on Unix Domain Socket (Linux/macOS) or Named Pipe (Windows).
 * - Nonce / HMAC challenge-response worker & admin authentication with strict authorization separation.
 * - Manages worker lifecycle transitions: STARTING -> READY -> HEARTBEAT -> DRAINING -> DRAINED -> STOPPED.
 * - Non-destructive two-phase IPC drain coordination.
 * - Admin IPC interface for cluster registration, readiness queries, drain triggering, manifest state, and status ping.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, chmodSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
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
  type LifecycleReadyPayload,
  type LifecycleHeartbeatPayload,
  type DrainRequestPayload,
  type DrainedPayload,
  type LifecycleStoppedPayload,
  type LifecycleFailedPayload,
  type AdminHandshakeResponsePayload,
  type AdminRegisterClusterPayload,
  type AdminRegisterClusterResponsePayload,
  type AdminIsSlotReadyPayload,
  type AdminIsSlotReadyResponsePayload,
  type AdminDrainWorkerPayload,
  type AdminDrainWorkerResponsePayload,
  type AdminGetClusterWorkersPayload,
  type AdminGetClusterWorkersResponsePayload,
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

export interface ClusterLockInfo {
  reason: "reload" | "scale" | "stop" | "manual";
  ownerId: string;
  lockToken: string;
  lockedAt: number;
  expiresAt: number;
}

export interface ConnectedWorker {
  id: string;
  socket: Socket;
  namespace: string;
  clusterName: string;
  slot: number;
  generation: number;
  pid: number;
  status: "connected" | "ready" | "draining" | "drained" | "stopped" | "failed";
  port?: number;
  readyAt?: number;
  lastHeartbeatAt: number;
  metadata?: Record<string, unknown>;
}

export interface ControllerOptions {
  socketPath?: string;
  handshakeTimeoutMs?: number;
  adminToken?: string;
}

export function isValidClusterName(clusterName: string): boolean {
  return typeof clusterName === "string" &&
    /^[a-zA-Z0-9._-]+$/.test(clusterName) &&
    clusterName.length <= 128 &&
    !clusterName.includes("..") &&
    !clusterName.includes("/") &&
    !clusterName.includes("\\");
}

export class ClusterController extends EventEmitter {
  private server: Server | null = null;
  private socketPath: string;
  private handshakeTimeoutMs: number;
  private adminToken: string = "";
  private workers: Map<string, ConnectedWorker> = new Map();
  private clusterTokens: Map<string, string> = new Map();
  private manifests: Map<string, ClusterManifestData> = new Map();
  private lockedClusters: Map<string, ClusterLockInfo> = new Map();
  private drainResolvers: Map<string, (result: { drained: boolean; inFlightRemaining: number }) => void> = new Map();

  private hubProvider?: () => { listening: boolean; namespacesCount: number; walRecovered: boolean; walRecordsCount: number };
  private reconcilerProvider?: () => { active: boolean; lockedClusters: string[]; managedClustersCount: number };

  constructor(options: ControllerOptions = {}) {
    super();
    const platformInfo = getPlatformInfo();
    this.socketPath = options.socketPath || platformInfo.socketPath;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || 5000;
    if (options.adminToken) {
      this.adminToken = options.adminToken;
    }
  }

  /**
   * Helper to format a worker key: clusterName:slot:generation
   */
  public static workerKey(clusterName: string, slot: number, generation: number): string {
    return `${clusterName}:${slot}:${generation}`;
  }

  /**
   * Returns current admin token, loading from disk if needed.
   */
  public getAdminToken(): string {
    if (this.adminToken) return this.adminToken;
    const platformInfo = getPlatformInfo();
    const tokenFilePath = join(platformInfo.runtimeDir, "tokens", "admin.token");
    if (existsSync(tokenFilePath)) {
      try {
        this.adminToken = readFileSync(tokenFilePath, "utf-8").trim();
        return this.adminToken;
      } catch {}
    }
    return "";
  }

  /**
   * Generates or ensures persistent admin token exists with 0600 permissions.
   */
  public getOrCreateAdminToken(explicitToken?: string): { token: string; tokenFilePath: string } {
    const platformInfo = getPlatformInfo();
    const tokensDir = join(platformInfo.runtimeDir, "tokens");
    if (!existsSync(tokensDir)) {
      mkdirSync(tokensDir, { recursive: true });
    }

    const tokenFilePath = join(tokensDir, "admin.token");
    if (explicitToken) {
      this.adminToken = explicitToken;
      writeFileSync(tokenFilePath, explicitToken, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(tokenFilePath, 0o600); } catch {}
      return { token: explicitToken, tokenFilePath };
    }

    if (this.adminToken) {
      if (!existsSync(tokenFilePath)) {
        try {
          writeFileSync(tokenFilePath, this.adminToken, { encoding: "utf-8", mode: 0o600 });
          chmodSync(tokenFilePath, 0o600);
        } catch {}
      }
      return { token: this.adminToken, tokenFilePath };
    }

    if (existsSync(tokenFilePath)) {
      try {
        const existing = readFileSync(tokenFilePath, "utf-8").trim();
        if (existing) {
          this.adminToken = existing;
          return { token: existing, tokenFilePath };
        }
      } catch {}
    }

    const token = generateToken();
    this.adminToken = token;
    writeFileSync(tokenFilePath, token, { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(tokenFilePath, 0o600); } catch {}
    return { token, tokenFilePath };
  }

  /**
   * Registers or generates an auth token for a cluster and persists it to disk.
   */
  public registerClusterToken(clusterName: string, explicitToken?: string): { token: string; tokenFilePath: string } {
    if (!isValidClusterName(clusterName)) {
      throw new Error(`Security: Invalid cluster name identifier: ${clusterName}`);
    }

    const platformInfo = getPlatformInfo();
    const tokensDir = join(platformInfo.runtimeDir, "tokens");
    if (!existsSync(tokensDir)) {
      mkdirSync(tokensDir, { recursive: true });
    }
    const tokenFilePath = join(tokensDir, `${clusterName}.token`);

    if (explicitToken) {
      this.clusterTokens.set(clusterName, explicitToken);
      writeFileSync(tokenFilePath, explicitToken, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(tokenFilePath, 0o600); } catch {}
      return { token: explicitToken, tokenFilePath };
    }

    if (this.clusterTokens.has(clusterName)) {
      return { token: this.clusterTokens.get(clusterName)!, tokenFilePath };
    }

    if (existsSync(tokenFilePath)) {
      try {
        const existing = readFileSync(tokenFilePath, "utf-8").trim();
        if (existing) {
          this.clusterTokens.set(clusterName, existing);
          return { token: existing, tokenFilePath };
        }
      } catch {}
    }

    const token = generateToken();
    this.clusterTokens.set(clusterName, token);
    writeFileSync(tokenFilePath, token, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(tokenFilePath, 0o600);
    } catch {}

    return { token, tokenFilePath };
  }

  /**
   * Reads or retrieves the token for a cluster.
   */
  public getClusterToken(clusterName: string): string | null {
    if (!isValidClusterName(clusterName)) {
      return null;
    }

    if (this.clusterTokens.has(clusterName)) {
      return this.clusterTokens.get(clusterName)!;
    }
    const platformInfo = getPlatformInfo();
    const tokenFilePath = join(platformInfo.runtimeDir, "tokens", `${clusterName}.token`);
    if (existsSync(tokenFilePath)) {
      try {
        const token = readFileSync(tokenFilePath, "utf-8").trim();
        this.clusterTokens.set(clusterName, token);
        return token;
      } catch {}
    }
    return null;
  }

  public setHubProvider(provider: () => { listening: boolean; namespacesCount: number; walRecovered: boolean; walRecordsCount: number }): void {
    this.hubProvider = provider;
  }

  public setReconcilerProvider(provider: () => { active: boolean; lockedClusters: string[]; managedClustersCount: number }): void {
    this.reconcilerProvider = provider;
  }

  public lockCluster(
    clusterName: string,
    reason: "reload" | "scale" | "stop" | "manual",
    timeoutMs = 60000,
    ownerId = "admin"
  ): { acquired: boolean; lockToken: string | null; reason?: string; currentOwner?: string } {
    const now = Date.now();
    const existing = this.lockedClusters.get(clusterName);

    // If active and not expired, refuse lock (mutual exclusion)
    if (existing && now < existing.expiresAt) {
      return {
        acquired: false,
        lockToken: null,
        reason: existing.reason,
        currentOwner: existing.ownerId,
      };
    }

    const lockToken = generateToken();
    const lockInfo: ClusterLockInfo = {
      reason,
      ownerId,
      lockToken,
      lockedAt: now,
      expiresAt: now + timeoutMs,
    };
    this.lockedClusters.set(clusterName, lockInfo);
    this.emit("cluster:locked", { clusterName, reason, timeoutMs, ownerId, lockToken });
    return { acquired: true, lockToken, reason };
  }

  public renewClusterLock(
    clusterName: string,
    lockToken: string,
    extendMs = 30000
  ): { renewed: boolean; expiresAt?: number } {
    const existing = this.lockedClusters.get(clusterName);
    if (!existing || !lockToken || existing.lockToken !== lockToken) {
      return { renewed: false };
    }
    const now = Date.now();
    if (existing.expiresAt <= now) {
      this.lockedClusters.delete(clusterName);
      return { renewed: false };
    }
    existing.expiresAt = now + extendMs;
    return { renewed: true, expiresAt: existing.expiresAt };
  }

  public unlockCluster(clusterName: string, lockToken: string): boolean {
    const existing = this.lockedClusters.get(clusterName);
    if (!existing || !lockToken || existing.lockToken !== lockToken) {
      return false;
    }

    this.lockedClusters.delete(clusterName);
    this.emit("cluster:unlocked", { clusterName, ownerId: existing.ownerId });
    return true;
  }

  public getClusterLock(clusterName: string): ClusterLockInfo | null {
    const lock = this.lockedClusters.get(clusterName);
    if (!lock) return null;
    if (Date.now() > lock.expiresAt) {
      this.lockedClusters.delete(clusterName);
      return null;
    }
    return { ...lock };
  }

  public isClusterLocked(clusterName: string): boolean {
    const lock = this.lockedClusters.get(clusterName);
    if (!lock) return false;
    if (Date.now() > lock.expiresAt) {
      this.lockedClusters.delete(clusterName);
      return false;
    }
    return true;
  }

  public getLockedClusters(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [name, lock] of this.lockedClusters.entries()) {
      if (now <= lock.expiresAt) {
        result.push(name);
      } else {
        this.lockedClusters.delete(name);
      }
    }
    return result;
  }

  public setManifest(manifest: ClusterManifestData): void {
    this.manifests.set(manifest.clusterName, manifest);
    const platformInfo = getPlatformInfo();
    if (!existsSync(platformInfo.clusterDir)) {
      mkdirSync(platformInfo.clusterDir, { recursive: true });
    }
    const manifestPath = join(platformInfo.clusterDir, `${manifest.clusterName}.manifest.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
  }

  public getManifest(clusterName: string): ClusterManifestData | undefined {
    if (this.manifests.has(clusterName)) {
      return this.manifests.get(clusterName);
    }
    const platformInfo = getPlatformInfo();
    const manifestPath = join(platformInfo.clusterDir, `${clusterName}.manifest.json`);
    if (existsSync(manifestPath)) {
      try {
        const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as ClusterManifestData;
        this.manifests.set(clusterName, data);
        return data;
      } catch {}
    }
    return undefined;
  }

  public deleteManifest(clusterName: string): boolean {
    this.manifests.delete(clusterName);
    const platformInfo = getPlatformInfo();
    const manifestPath = join(platformInfo.clusterDir, `${clusterName}.manifest.json`);
    if (existsSync(manifestPath)) {
      try {
        unlinkSync(manifestPath);
        return true;
      } catch {}
    }
    return false;
  }

  public getAllManifests(): ClusterManifestData[] {
    const platformInfo = getPlatformInfo();
    if (existsSync(platformInfo.clusterDir)) {
      try {
        const files = readdirSync(platformInfo.clusterDir);
        for (const file of files) {
          if (file.endsWith(".manifest.json")) {
            const clusterName = file.replace(/\.manifest\.json$/, "");
            this.getManifest(clusterName);
          }
        }
      } catch {}
    }
    return Array.from(this.manifests.values());
  }

  /**
   * Starts the IPC lifecycle server.
   */
  public async start(): Promise<void> {
    const platformInfo = getPlatformInfo();

    // Ensure admin token exists
    this.getOrCreateAdminToken();

    // Clean up stale Unix domain socket if it exists
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
   * Stops the IPC server and gracefully disconnects clients.
   */
  public async stop(): Promise<void> {
    const platformInfo = getPlatformInfo();

    for (const worker of this.workers.values()) {
      try {
        worker.socket.destroy();
      } catch {}
    }
    this.workers.clear();

    if (!this.server) {
      return;
    }

    const srv = this.server;
    this.server = null;

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          if (!platformInfo.isWindows && existsSync(this.socketPath)) {
            try {
              unlinkSync(this.socketPath);
            } catch {}
          }
          this.emit("stopped");
          resolve();
        }
      };

      const fallbackTimer = setTimeout(done, 1000);

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
   * Handles incoming connection: challenge -> auth (worker or admin) -> routing.
   */
  private handleClientConnection(socket: Socket): void {
    const decoder = new StreamingFrameDecoder();
    const nonce = generateNonce();
    let authenticated = false;
    let isAdmin = false;
    let authenticatedWorkerKey: string | null = null;

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

    // Set handshake timeout
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.destroy();
      }
    }, this.handshakeTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      try {
        const envelopes = decoder.push(chunk);
        for (const envelope of envelopes) {
          if (!authenticated) {
            // Check for Admin Handshake
            if (envelope.type === "ADMIN_HANDSHAKE_RESPONSE") {
              const payload = envelope.payload as AdminHandshakeResponsePayload;
              const adminToken = this.getAdminToken();
              if (!adminToken || !verifyHmac(nonce, adminToken, payload.adminHmac)) {
                try {
                  const rejectEnv = createEnvelope("HANDSHAKE_REJECT", "system", { reason: "Invalid admin HMAC" });
                  socket.write(encodeFrame(rejectEnv));
                } catch {}
                socket.destroy();
                return;
              }

              clearTimeout(authTimer);
              authenticated = true;
              isAdmin = true;

              const ackEnv = createEnvelope("HANDSHAKE_ACK", "system", {
                authenticated: true,
                isAdmin: true,
              });
              try {
                socket.write(encodeFrame(ackEnv));
              } catch {
                socket.destroy();
                return;
              }

              this.emit("admin:connected", { socket, pid: payload.pid });
              continue;
            }

            // Check for Worker Handshake
            if (envelope.type === "HANDSHAKE_RESPONSE") {
              const payload = envelope.payload as HandshakeResponsePayload;
              const token = this.getClusterToken(payload.clusterName);
              if (!token || !verifyHmac(nonce, token, payload.hmac)) {
                try {
                  const rejectEnv = createEnvelope("HANDSHAKE_REJECT", "system", { reason: "Invalid HMAC or unknown cluster" });
                  socket.write(encodeFrame(rejectEnv));
                } catch {}
                socket.destroy();
                return;
              }

              clearTimeout(authTimer);
              authenticated = true;
              isAdmin = false;
              authenticatedWorkerKey = ClusterController.workerKey(
                payload.clusterName,
                payload.slot,
                payload.generation
              );

              const worker: ConnectedWorker = {
                id: authenticatedWorkerKey,
                socket,
                namespace: payload.namespace,
                clusterName: payload.clusterName,
                slot: payload.slot,
                generation: payload.generation,
                pid: payload.pid,
                status: "connected",
                lastHeartbeatAt: Date.now(),
              };

              this.workers.set(authenticatedWorkerKey, worker);

              // Send ACK back to worker
              const ackEnv = createEnvelope("HANDSHAKE_ACK", "system", {
                authenticated: true,
                workerKey: authenticatedWorkerKey,
                isAdmin: false,
              });
              try {
                socket.write(encodeFrame(ackEnv));
              } catch {
                socket.destroy();
                return;
              }

              this.emit("worker:connected", worker);
              continue;
            }

            // Non-handshake first message -> reject
            socket.destroy();
            return;
          }

          // Handle Admin Requests
          if (envelope.type.startsWith("ADMIN_")) {
            if (!isAdmin) {
              // SECURITY: Cluster worker tokens must NEVER access admin operations!
              const errEnv = createEnvelope<AdminErrorPayload>(
                "ADMIN_ERROR",
                "system",
                { error: "Unauthorized: Admin authorization required", code: "ERR_UNAUTHORIZED" },
                envelope.id
              );
              try { socket.write(encodeFrame(errEnv)); } catch {}
              socket.destroy();
              return;
            }
            this.handleAdminMessage(socket, envelope);
            continue;
          }

          // Handle Worker Lifecycle Messages
          if (authenticatedWorkerKey) {
            const worker = this.workers.get(authenticatedWorkerKey);
            if (!worker) continue;
            this.handleWorkerMessage(worker, envelope);
          }
        }
      } catch {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (authenticatedWorkerKey) {
        const worker = this.workers.get(authenticatedWorkerKey);
        if (worker && worker.socket === socket) {
          worker.status = "stopped";
          this.emit("worker:disconnected", worker);
          this.workers.delete(authenticatedWorkerKey);
        }
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  /**
   * Handles admin operations from authorized admin connections.
   */
  private handleAdminMessage(socket: Socket, envelope: Bs9Envelope): void {
    switch (envelope.type) {
      case "ADMIN_REGISTER_CLUSTER": {
        const payload = envelope.payload as AdminRegisterClusterPayload;
        const result = this.registerClusterToken(payload.clusterName, payload.explicitToken);
        const resEnv = createEnvelope<AdminRegisterClusterResponsePayload>(
          "ADMIN_REGISTER_CLUSTER_RESPONSE",
          "system",
          {
            clusterName: payload.clusterName,
            token: result.token,
            tokenFilePath: result.tokenFilePath,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_IS_SLOT_READY": {
        const payload = envelope.payload as AdminIsSlotReadyPayload;
        const ready = this.isSlotReady(payload.clusterName, payload.slot, payload.generation);
        const resEnv = createEnvelope<AdminIsSlotReadyResponsePayload>(
          "ADMIN_IS_SLOT_READY_RESPONSE",
          "system",
          {
            clusterName: payload.clusterName,
            slot: payload.slot,
            ready,
            generation: payload.generation,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_DRAIN_WORKER": {
        const payload = envelope.payload as AdminDrainWorkerPayload;
        this.drainWorker(payload.clusterName, payload.slot, payload.generation, payload.drainTimeoutMs)
          .then((result) => {
            const resEnv = createEnvelope<AdminDrainWorkerResponsePayload>(
              "ADMIN_DRAIN_WORKER_RESPONSE",
              "system",
              {
                clusterName: payload.clusterName,
                slot: payload.slot,
                generation: payload.generation,
                drained: result.drained,
                inFlightRemaining: result.inFlightRemaining,
              },
              envelope.id
            );
            socket.write(encodeFrame(resEnv));
          })
          .catch((err) => {
            const errEnv = createEnvelope<AdminErrorPayload>(
              "ADMIN_ERROR",
              "system",
              { error: (err as Error).message },
              envelope.id
            );
            socket.write(encodeFrame(errEnv));
          });
        break;
      }

      case "ADMIN_GET_CLUSTER_WORKERS": {
        const payload = envelope.payload as AdminGetClusterWorkersPayload;
        const workers = this.getClusterWorkers(payload.clusterName).map((w) => ({
          slot: w.slot,
          generation: w.generation,
          pid: w.pid,
          status: w.status,
          port: w.port,
          lastHeartbeatAt: w.lastHeartbeatAt,
        }));
        const resEnv = createEnvelope<AdminGetClusterWorkersResponsePayload>(
          "ADMIN_GET_CLUSTER_WORKERS_RESPONSE",
          "system",
          {
            clusterName: payload.clusterName,
            workers,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_SET_MANIFEST": {
        const payload = envelope.payload as AdminSetManifestPayload;
        this.setManifest(payload.manifest);
        const resEnv = createEnvelope<AdminSetManifestResponsePayload>(
          "ADMIN_SET_MANIFEST_RESPONSE",
          "system",
          { clusterName: payload.manifest.clusterName, success: true },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_GET_MANIFEST": {
        const payload = envelope.payload as AdminGetManifestPayload;
        const manifest = this.getManifest(payload.clusterName);
        const resEnv = createEnvelope<AdminGetManifestResponsePayload>(
          "ADMIN_GET_MANIFEST_RESPONSE",
          "system",
          { clusterName: payload.clusterName, found: !!manifest, manifest },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_DELETE_MANIFEST": {
        const payload = envelope.payload as AdminDeleteManifestPayload;
        const deleted = this.deleteManifest(payload.clusterName);
        const resEnv = createEnvelope<AdminDeleteManifestResponsePayload>(
          "ADMIN_DELETE_MANIFEST_RESPONSE",
          "system",
          { clusterName: payload.clusterName, deleted },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_LOCK_CLUSTER": {
        const payload = envelope.payload as AdminLockClusterPayload;
        const result = this.lockCluster(
          payload.clusterName,
          payload.reason,
          payload.timeoutMs,
          payload.ownerId
        );
        const resEnv = createEnvelope<AdminLockClusterResponsePayload>(
          "ADMIN_LOCK_CLUSTER_RESPONSE",
          "system",
          {
            clusterName: payload.clusterName,
            locked: result.acquired,
            lockToken: result.lockToken,
            reason: result.reason || payload.reason,
            currentOwner: result.currentOwner,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_RENEW_CLUSTER_LOCK": {
        const payload = envelope.payload as AdminRenewClusterLockPayload;
        const result = this.renewClusterLock(
          payload.clusterName,
          payload.lockToken,
          payload.extendMs
        );
        const resEnv = createEnvelope<AdminRenewClusterLockResponsePayload>(
          "ADMIN_RENEW_CLUSTER_LOCK_RESPONSE",
          "system",
          {
            clusterName: payload.clusterName,
            renewed: result.renewed,
            expiresAt: result.expiresAt,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_UNLOCK_CLUSTER": {
        const payload = envelope.payload as AdminUnlockClusterPayload;
        const unlocked = this.unlockCluster(payload.clusterName, payload.lockToken);
        const resEnv = createEnvelope<AdminUnlockClusterResponsePayload>(
          "ADMIN_UNLOCK_CLUSTER_RESPONSE",
          "system",
          { clusterName: payload.clusterName, unlocked },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      case "ADMIN_PING": {
        const hubStatus = this.hubProvider
          ? this.hubProvider()
          : { listening: false, namespacesCount: 0, walRecovered: true, walRecordsCount: 0 };
        const reconcilerStatus = this.reconcilerProvider
          ? this.reconcilerProvider()
          : { active: false, lockedClusters: this.getLockedClusters(), managedClustersCount: this.manifests.size };

        const controllerListening = this.server !== null;
        const overallStatus: "ok" | "degraded" =
          controllerListening && (!this.hubProvider || hubStatus.listening) ? "ok" : "degraded";

        const resEnv = createEnvelope<AdminPingResponsePayload>(
          "ADMIN_PING_RESPONSE",
          "system",
          {
            status: overallStatus,
            timestamp: Date.now(),
            controller: {
              listening: controllerListening,
              socketPath: this.socketPath,
              connectedWorkersCount: this.workers.size,
            },
            hub: hubStatus,
            reconciler: reconcilerStatus,
          },
          envelope.id
        );
        socket.write(encodeFrame(resEnv));
        break;
      }

      default: {
        const errEnv = createEnvelope<AdminErrorPayload>(
          "ADMIN_ERROR",
          "system",
          { error: `Unknown admin message type: ${envelope.type}` },
          envelope.id
        );
        socket.write(encodeFrame(errEnv));
        break;
      }
    }
  }

  /**
   * Dispatches messages from an authenticated worker.
   */
  private handleWorkerMessage(worker: ConnectedWorker, envelope: Bs9Envelope): void {
    switch (envelope.type) {
      case "LIFECYCLE_READY": {
        const payload = envelope.payload as LifecycleReadyPayload;
        worker.status = "ready";
        worker.port = payload.port;
        worker.readyAt = Date.now();
        worker.metadata = payload.metadata;
        this.emit("worker:ready", worker, payload);
        break;
      }

      case "LIFECYCLE_HEARTBEAT": {
        const payload = envelope.payload as LifecycleHeartbeatPayload;
        worker.lastHeartbeatAt = Date.now();
        this.emit("worker:heartbeat", worker, payload);
        break;
      }

      case "DRAINED": {
        const payload = envelope.payload as DrainedPayload;
        worker.status = "drained";
        const resolver = this.drainResolvers.get(worker.id);
        if (resolver) {
          resolver({ drained: true, inFlightRemaining: payload.inFlightRemaining });
          this.drainResolvers.delete(worker.id);
        }
        this.emit("worker:drained", worker, payload);
        break;
      }

      case "LIFECYCLE_STOPPED": {
        const payload = envelope.payload as LifecycleStoppedPayload;
        worker.status = "stopped";
        this.emit("worker:stopped", worker, payload);
        break;
      }

      case "LIFECYCLE_FAILED": {
        const payload = envelope.payload as LifecycleFailedPayload;
        worker.status = "failed";
        this.emit("worker:failed", worker, payload);
        break;
      }
    }
  }

  /**
   * Requests a worker to gracefully drain active requests over IPC.
   */
  public async drainWorker(
    clusterName: string,
    slot: number,
    generation: number,
    timeoutMs = 10000
  ): Promise<{ drained: boolean; inFlightRemaining: number }> {
    const key = ClusterController.workerKey(clusterName, slot, generation);
    const worker = this.workers.get(key);

    if (!worker || worker.status === "stopped" || worker.status === "failed") {
      return { drained: true, inFlightRemaining: 0 };
    }

    worker.status = "draining";

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.drainResolvers.delete(key);
        resolve({ drained: false, inFlightRemaining: -1 });
      }, timeoutMs);

      this.drainResolvers.set(key, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      const drainEnvelope = createEnvelope<DrainRequestPayload>(
        "DRAIN_REQUEST",
        worker.namespace,
        { drainTimeoutMs: timeoutMs }
      );

      try {
        worker.socket.write(encodeFrame(drainEnvelope));
      } catch {
        clearTimeout(timer);
        this.drainResolvers.delete(key);
        resolve({ drained: false, inFlightRemaining: -1 });
      }
    });
  }

  /**
   * Queries worker status.
   */
  public getWorker(clusterName: string, slot: number, generation: number): ConnectedWorker | undefined {
    const key = ClusterController.workerKey(clusterName, slot, generation);
    return this.workers.get(key);
  }

  public getClusterWorkers(clusterName: string): ConnectedWorker[] {
    const result: ConnectedWorker[] = [];
    for (const worker of this.workers.values()) {
      if (worker.clusterName === clusterName) {
        result.push(worker);
      }
    }
    return result;
  }

  public isSlotReady(clusterName: string, slot: number, generation?: number): boolean {
    for (const worker of this.workers.values()) {
      if (
        worker.clusterName === clusterName &&
        worker.slot === slot &&
        worker.status === "ready" &&
        (generation === undefined || worker.generation === generation)
      ) {
        return true;
      }
    }
    return false;
  }

  public getSocketPath(): string {
    return this.socketPath;
  }
}

let defaultClusterController: ClusterController | null = null;

export function getDefaultClusterController(): ClusterController | null {
  return defaultClusterController;
}

export function setDefaultClusterController(controller: ClusterController | null): void {
  defaultClusterController = controller;
}

export async function getOrStartClusterController(options: ControllerOptions = {}): Promise<ClusterController> {
  if (defaultClusterController) {
    return defaultClusterController;
  }
  const controller = new ClusterController(options);
  try {
    await controller.start();
    defaultClusterController = controller;
    return controller;
  } catch (err: any) {
    if (err && err.code === "EADDRINUSE") {
      return defaultClusterController || controller;
    }
    throw err;
  }
}
