/**
 * BS9 - Runtime Backend & Fallback Coordinator
 *
 * Implements Strict Fallback Policy:
 * - Rule 1 (Outside BS9): Pure in-memory adapters for state, events, lease, queue.
 *   Never throws connection errors.
 * - Rule 2 (Inside BS9): Connects to State Hub via HubClient.
 *   - If Hub unavailable & allowDegradedLocal === true: fallback to local in-memory with loud warning.
 *   - Otherwise: FAIL LOUDLY with descriptive error:
 *     "BS9 State Hub unavailable at <socketPath>. Set allowDegradedLocal=true in runtime config if local in-memory fallback is acceptable."
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { HubClient } from "../hub/client.js";
import { KvEngine } from "../hub/engine.js";
import { LeaseManager } from "../hub/leases.js";
import { QueueManager } from "../hub/queues.js";
import { getDefaultHubSocketPath } from "../hub/server.js";
import { isBs9Environment, type RuntimeConfig } from "./config.js";

export interface StateAdapter {
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  incr(key: string, delta?: number): Promise<number>;
  cas<T = any>(
    key: string,
    expectedValue: T,
    newValue: T,
    ttlMs?: number
  ): Promise<{ success: boolean; currentValue: T }>;
}

export class InMemoryAdapter implements StateAdapter {
  private engine: KvEngine;
  private namespace: string;

  constructor(engine?: KvEngine, namespace = "default") {
    this.engine = engine || new KvEngine();
    this.namespace = namespace;
  }

  public async get<T = any>(key: string): Promise<T | null> {
    const val = this.engine.get(this.namespace, key);
    return (val !== undefined && val !== null ? val : null) as T | null;
  }

  public async set<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean> {
    return this.engine.set(this.namespace, key, value, ttlMs);
  }

  public async delete(key: string): Promise<boolean> {
    return this.engine.delete(this.namespace, key);
  }

  public async incr(key: string, delta: number = 1): Promise<number> {
    return this.engine.incr(this.namespace, key, delta);
  }

  public async cas<T = any>(
    key: string,
    expectedValue: T,
    newValue: T,
    ttlMs?: number
  ): Promise<{ success: boolean; currentValue: T }> {
    return this.engine.cas(this.namespace, key, expectedValue, newValue, ttlMs);
  }

  public getEngine(): KvEngine {
    return this.engine;
  }
}

export class HubAdapter implements StateAdapter {
  constructor(private client: HubClient) {}

  public async get<T = any>(key: string): Promise<T | null> {
    return this.client.get<T>(key);
  }

  public async set<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean> {
    return this.client.set(key, value, ttlMs);
  }

  public async delete(key: string): Promise<boolean> {
    return this.client.delete(key);
  }

  public async incr(key: string, delta: number = 1): Promise<number> {
    return this.client.incr(key, delta);
  }

  public async cas<T = any>(
    key: string,
    expectedValue: T,
    newValue: T,
    ttlMs?: number
  ): Promise<{ success: boolean; currentValue: T }> {
    return this.client.cas(key, expectedValue, newValue, ttlMs);
  }

  public getClient(): HubClient {
    return this.client;
  }
}

export class RuntimeBackend {
  private config: RuntimeConfig = {};
  private activeAdapter: StateAdapter | null = null;
  private hubClient: HubClient | null = null;
  private inMemoryEngine: KvEngine | null = null;
  private inMemoryLeases: LeaseManager | null = null;
  private inMemoryQueues: QueueManager | null = null;
  private initPromise: Promise<StateAdapter> | null = null;

  constructor(initialConfig: RuntimeConfig = {}) {
    this.config = { ...initialConfig };
  }

  public configure(config: Partial<RuntimeConfig>): void {
    this.config = { ...this.config, ...config };
    this.resetSync();
  }

  public getConfig(): RuntimeConfig {
    return { ...this.config };
  }

  public getHubClient(): HubClient | null {
    return this.hubClient;
  }

  public getInMemoryLeases(): LeaseManager {
    if (!this.inMemoryLeases) {
      this.inMemoryLeases = new LeaseManager();
    }
    return this.inMemoryLeases;
  }

  public getInMemoryQueues(): QueueManager {
    if (!this.inMemoryQueues) {
      this.inMemoryQueues = new QueueManager();
    }
    return this.inMemoryQueues;
  }

  public getInMemoryEngine(): KvEngine {
    if (!this.inMemoryEngine) {
      this.inMemoryEngine = new KvEngine();
    }
    return this.inMemoryEngine;
  }

  private resetSync(): void {
    this.initPromise = null;
    this.activeAdapter = null;
    if (this.hubClient) {
      try {
        this.hubClient.disconnect().catch(() => {});
      } catch {}
      this.hubClient = null;
    }
    if (this.inMemoryEngine) {
      try {
        this.inMemoryEngine.close();
      } catch {}
      this.inMemoryEngine = null;
    }
    if (this.inMemoryLeases) {
      try {
        this.inMemoryLeases.close();
      } catch {}
      this.inMemoryLeases = null;
    }
    if (this.inMemoryQueues) {
      try {
        this.inMemoryQueues.close();
      } catch {}
      this.inMemoryQueues = null;
    }
  }

  public async reset(): Promise<void> {
    this.initPromise = null;
    this.activeAdapter = null;
    if (this.hubClient) {
      try {
        await this.hubClient.disconnect();
      } catch {}
      this.hubClient = null;
    }
    if (this.inMemoryEngine) {
      try {
        this.inMemoryEngine.close();
      } catch {}
      this.inMemoryEngine = null;
    }
    if (this.inMemoryLeases) {
      try {
        this.inMemoryLeases.close();
      } catch {}
      this.inMemoryLeases = null;
    }
    if (this.inMemoryQueues) {
      try {
        this.inMemoryQueues.close();
      } catch {}
      this.inMemoryQueues = null;
    }
    this.config = {};
  }

  public async getAdapter(): Promise<StateAdapter> {
    if (this.activeAdapter) {
      return this.activeAdapter;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.initialize();
    try {
      this.activeAdapter = await this.initPromise;
      return this.activeAdapter;
    } finally {
      this.initPromise = null;
    }
  }

  public async ensureConnected(): Promise<void> {
    await this.getAdapter();
  }

  private async initialize(): Promise<StateAdapter> {
    const isBs9 = isBs9Environment(this.config);

    if (!isBs9) {
      // Rule 1: Outside BS9 -> pure in-memory adapter
      this.inMemoryEngine = new KvEngine();
      return new InMemoryAdapter(this.inMemoryEngine, this.config.namespace || "default");
    }

    // Rule 2: Inside BS9 -> connect to State Hub
    const socketPath =
      this.config.socketPath ||
      process.env.BS9_HUB_SOCKET ||
      getDefaultHubSocketPath();

    const namespace =
      this.config.namespace ||
      process.env.BS9_CLUSTER_NAME ||
      process.env.SERVICE_NAME ||
      "default";

    let authToken = this.config.authToken || process.env.BS9_AUTH_TOKEN || "";
    if (!authToken) {
      const tokenFile =
        this.config.authTokenFile || process.env.BS9_AUTH_TOKEN_FILE;
      if (tokenFile && existsSync(tokenFile)) {
        try {
          authToken = readFileSync(tokenFile, "utf-8").trim();
        } catch {}
      }
    }

    const client = new HubClient({
      socketPath,
      namespace,
      authToken,
      requestTimeoutMs: this.config.requestTimeoutMs ?? 15000,
      connectTimeoutMs: this.config.connectTimeoutMs ?? 1000,
    });

    // Suppress unhandled EventEmitter error on failed socket connection
    client.on("error", () => {});

    let connected = false;
    try {
      connected = await client.connect();
    } catch {
      connected = false;
    }

    if (connected) {
      this.hubClient = client;
      return new HubAdapter(client);
    }

    // Hub is unavailable or handshake rejected
    const allowDegradedLocal =
      this.config.allowDegradedLocal ??
      (process.env.BS9_ALLOW_DEGRADED_LOCAL === "true");

    if (allowDegradedLocal) {
      console.warn(
        `[BS9 RUNTIME WARNING] BS9 State Hub unavailable at ${socketPath}. Falling back to degraded local in-memory adapter because allowDegradedLocal=true.`
      );
      this.inMemoryEngine = new KvEngine();
      return new InMemoryAdapter(this.inMemoryEngine, namespace);
    }

    throw new Error(
      `BS9 State Hub unavailable at ${socketPath}. Set allowDegradedLocal=true in runtime config if local in-memory fallback is acceptable.`
    );
  }
}

const defaultBackend = new RuntimeBackend();

export function getDefaultRuntimeBackend(): RuntimeBackend {
  return defaultBackend;
}

export async function resetDefaultRuntimeBackend(): Promise<void> {
  await defaultBackend.reset();
}

