/**
 * BS9 - Worker Lifecycle Client
 *
 * Runs inside the worker process (spawned or preloaded):
 * - Connects to bs9-controller over UDS / Named Pipe.
 * - Handles Nonce / HMAC challenge-response authentication.
 * - Dispatches LIFECYCLE_READY once server successfully binds.
 * - Sends periodic HEARTBEAT.
 * - Receives DRAIN_REQUEST, stops accepting requests, coordinates application cleanup, and reports DRAINED.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createConnection, type Socket } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  encodeFrame,
  StreamingFrameDecoder,
  createEnvelope,
  computeHmac,
  type Bs9Envelope,
  type HandshakeChallengePayload,
  type HandshakeResponsePayload,
  type LifecycleReadyPayload,
  type LifecycleHeartbeatPayload,
  type DrainRequestPayload,
  type DrainedPayload,
  type LifecycleStoppedPayload,
  type LifecycleFailedPayload,
} from "../hub/protocol.js";
import { getPlatformInfo } from "../platform/detect.js";

export interface LifecycleClientOptions {
  socketPath?: string;
  authToken?: string;
  authTokenFile?: string;
  clusterName?: string;
  slot?: number;
  generation?: number;
  namespace?: string;
  autoConnect?: boolean;
}

export type DrainHandler = (timeoutMs: number) => Promise<{ inFlightRemaining: number }>;

export class LifecycleClient extends EventEmitter {
  private socket: Socket | null = null;
  private decoder: StreamingFrameDecoder = new StreamingFrameDecoder();
  private socketPath: string;
  private authToken: string = "";
  private clusterName: string;
  private slot: number;
  private generation: number;
  private namespace: string;
  private heartbeatTimer: any = null;
  private drainHandler: DrainHandler | null = null;
  private isConnected = false;
  private isAuthenticated = false;
  private isExplicitlyStopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: any = null;
  private lastReadyData: { port: number; metadata?: Record<string, unknown> } | null = null;
  private heartbeatIntervalMs = 5000;
  private wasHeartbeatActive = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;

  constructor(options: LifecycleClientOptions = {}) {
    super();
    const platformInfo = getPlatformInfo();

    this.socketPath =
      options.socketPath ||
      process.env.BS9_CONTROLLER_SOCKET ||
      platformInfo.socketPath;

    this.clusterName =
      options.clusterName ||
      process.env.BS9_CLUSTER_NAME ||
      process.env.SERVICE_NAME ||
      "default";

    const rawSlot =
      options.slot !== undefined
        ? options.slot
        : process.env.NODE_APP_INSTANCE || process.env.BS9_CLUSTER_ID || "0";
    this.slot = parseInt(String(rawSlot), 10) || 0;

    const rawGen =
      options.generation !== undefined
        ? options.generation
        : process.env.BS9_CLUSTER_GENERATION || "1";
    this.generation = parseInt(String(rawGen), 10) || 1;

    this.namespace = options.namespace || this.clusterName;

    // Resolve auth token
    if (options.authToken) {
      this.authToken = options.authToken;
    } else {
      const tokenFile =
        options.authTokenFile || process.env.BS9_AUTH_TOKEN_FILE;
      if (tokenFile && existsSync(tokenFile)) {
        try {
          this.authToken = readFileSync(tokenFile, "utf-8").trim();
        } catch {}
      } else if (process.env.BS9_AUTH_TOKEN) {
        this.authToken = process.env.BS9_AUTH_TOKEN;
      }
    }

    if (options.autoConnect) {
      this.connect().catch(() => {});
    }
  }

  /**
   * Connects to the lifecycle controller.
   */
  public async connect(): Promise<boolean> {
    if (this.isConnected) return true;
    if (this.isExplicitlyStopped) return false;

    return new Promise((resolve) => {
      try {
        this.decoder = new StreamingFrameDecoder();
        this.socket = createConnection(this.socketPath);

        this.readyPromise = new Promise((res) => {
          this.readyResolver = res;
        });

        this.socket.on("connect", () => {
          this.isConnected = true;
        });

        this.socket.on("data", (chunk: Buffer) => {
          try {
            const envelopes = this.decoder.push(chunk);
            for (const envelope of envelopes) {
              this.handleServerMessage(envelope);
            }
          } catch (err) {

            if (this.listenerCount("error") > 0) {
              this.emit("error", err);
            }
          }
        });

        let settled = false;
        let timeoutTimer: any = null;

        const onAuth = () => {
          if (settled) return;
          settled = true;
          cleanupListeners();
          resolve(true);
        };

        const onReject = () => {
          if (settled) return;
          settled = true;
          cleanupListeners();
          resolve(false);
        };

        const cleanupListeners = () => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          this.removeListener("authenticated", onAuth);
          this.removeListener("rejected", onReject);
          if (this.readyResolver) {
            this.readyResolver();
            this.readyResolver = null;
          }
        };

        this.socket.on("close", () => {
          cleanupListeners();
          this.cleanup();
          this.emit("disconnected");
          if (!this.isExplicitlyStopped) {
            this.scheduleReconnect();
          }
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });

        this.socket.on("error", (err: Error) => {
          cleanupListeners();
          this.cleanup();
          if (this.listenerCount("error") > 0) {
            this.emit("error", err);
          }
          if (!this.isExplicitlyStopped) {
            this.scheduleReconnect();
          }
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });

        // Resolve true when authenticated
        this.once("authenticated", onAuth);
        this.once("rejected", onReject);

        // Set connect timeout
        timeoutTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanupListeners();
            resolve(false);
          }
        }, 5000);
      } catch (err) {
        this.cleanup();
        this.emit("error", err);
        if (!this.isExplicitlyStopped) {
          this.scheduleReconnect();
        }
        resolve(false);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isExplicitlyStopped) return;
    const delay = Math.min(3000, 100 * Math.pow(1.5, this.reconnectAttempt)) + Math.floor(Math.random() * 50);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isExplicitlyStopped && !this.isConnected) {
        try {
          await this.connect();
        } catch {}
      }
    }, delay);

    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  private handleServerMessage(envelope: Bs9Envelope): void {
    switch (envelope.type) {
      case "HANDSHAKE_CHALLENGE": {
        const payload = envelope.payload as HandshakeChallengePayload;
        const hmac = computeHmac(payload.nonce, this.authToken);
        const responseEnvelope = createEnvelope<HandshakeResponsePayload>(
          "HANDSHAKE_RESPONSE",
          this.namespace,
          {
            namespace: this.namespace,
            clusterName: this.clusterName,
            slot: this.slot,
            generation: this.generation,
            pid: process.pid,
            hmac,
          }
        );
        this.send(responseEnvelope);
        break;
      }

      case "HANDSHAKE_ACK": {
        this.isAuthenticated = true;
        const wasReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;

        if (this.readyResolver) {
          this.readyResolver();
          this.readyResolver = null;
        }

        // Automatic re-registration of READY state after reconnect
        if (this.lastReadyData) {
          const envelope = createEnvelope<LifecycleReadyPayload>(
            "LIFECYCLE_READY",
            this.namespace,
            {
              port: this.lastReadyData.port,
              host: process.env.HOST || "localhost",
              protocol: process.env.PROTOCOL || "http",
              metadata: this.lastReadyData.metadata,
            }
          );
          this.send(envelope);
        }

        // Resume heartbeats if previously active
        if (this.wasHeartbeatActive) {
          this.startHeartbeat(this.heartbeatIntervalMs);
        }

        this.emit("authenticated");
        if (wasReconnect) {
          this.emit("reconnected");
        }
        break;
      }

      case "HANDSHAKE_REJECT": {
        this.isAuthenticated = false;
        this.emit("rejected", envelope.payload);
        this.cleanup();
        break;
      }

      case "DRAIN_REQUEST": {
        const payload = envelope.payload as DrainRequestPayload;
        this.handleDrainRequest(payload);
        break;
      }
    }
  }

  private async handleDrainRequest(payload: DrainRequestPayload): Promise<void> {
    this.emit("draining", payload);
    const startTime = Date.now();
    let inFlightRemaining = 0;

    if (this.drainHandler) {
      try {
        const result = await this.drainHandler(payload.drainTimeoutMs);
        inFlightRemaining = result.inFlightRemaining;
      } catch {
        inFlightRemaining = -1;
      }
    }

    const drainDurationMs = Date.now() - startTime;
    const drainedEnvelope = createEnvelope<DrainedPayload>(
      "DRAINED",
      this.namespace,
      { inFlightRemaining, drainDurationMs }
    );
    this.send(drainedEnvelope);
    this.emit("drained", { inFlightRemaining, drainDurationMs });
  }

  /**
   * Reports READY status to the lifecycle controller.
   */
  public async reportReady(
    port: number,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.lastReadyData = { port, metadata };

    if (!this.isAuthenticated) {
      await new Promise<void>((resolve) => {
        let timer: any = null;
        const onAuth = () => {
          if (timer) clearTimeout(timer);
          this.removeListener("authenticated", onAuth);
          resolve();
        };
        timer = setTimeout(() => {
          this.removeListener("authenticated", onAuth);
          resolve();
        }, 5000);
        this.once("authenticated", onAuth);
      });
    }

    const envelope = createEnvelope<LifecycleReadyPayload>(
      "LIFECYCLE_READY",
      this.namespace,
      {
        port,
        host: process.env.HOST || "localhost",
        protocol: process.env.PROTOCOL || "http",
        metadata,
      }
    );

    this.send(envelope);
    this.emit("ready", { port, metadata });
  }

  /**
   * Starts periodic heartbeat transmission.
   */
  public startHeartbeat(intervalMs = 5000): void {
    this.wasHeartbeatActive = true;
    this.heartbeatIntervalMs = intervalMs;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    const startTime = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAuthenticated) return;

      const mem = process.memoryUsage();
      const envelope = createEnvelope<LifecycleHeartbeatPayload>(
        "LIFECYCLE_HEARTBEAT",
        this.namespace,
        {
          uptime: (Date.now() - startTime) / 1000,
          memoryUsage: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
          },
        }
      );
      this.send(envelope);
    }, intervalMs);

    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Registers a drain handler callback.
   */
  public onDrain(handler: DrainHandler): void {
    this.drainHandler = handler;
  }

  /**
   * Reports process failure.
   */
  public reportFailed(error: string | Error, fatal = false): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const envelope = createEnvelope<LifecycleFailedPayload>(
      "LIFECYCLE_FAILED",
      this.namespace,
      { error: errorMsg, fatal }
    );
    this.send(envelope);
  }

  /**
   * Reports process stopping.
   */
  public reportStopped(exitCode = 0, signal?: string): void {
    const envelope = createEnvelope<LifecycleStoppedPayload>(
      "LIFECYCLE_STOPPED",
      this.namespace,
      { exitCode, signal }
    );
    this.send(envelope);
  }

  private send(envelope: Bs9Envelope): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      return this.socket.write(encodeFrame(envelope));
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    this.isConnected = false;
    this.isAuthenticated = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
      } catch {}
      this.socket = null;
    }
  }

  public disconnect(): void {
    this.isExplicitlyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
  }
}
