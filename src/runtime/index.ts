/**
 * BS9 - Runtime Client & Strict Fallback Policy (`bs9/runtime`)
 *
 * Capabilities:
 * - Typed singletons: state, events, lease, queue.
 * - Classes: State, Events, Lease, Queue, RuntimeBackend.
 * - Configuration: configureRuntime, getRuntimeConfig, resetRuntime.
 * - Strict Fallback Policy:
 *   - Rule 1 (Outside BS9): pure in-memory adapters for state, events, lease, queue.
 *   - Rule 2 (Inside BS9): connects to State Hub via HubClient.
 *     - If unavailable: fails loudly unless allowDegradedLocal=true.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { State } from "./state.js";
import { Events } from "./events.js";
import { Lease, type LeaseAcquireResult } from "./lease.js";
import { Queue } from "./queue.js";
import {
  getDefaultRuntimeBackend,
  resetDefaultRuntimeBackend,
  RuntimeBackend,
  type StateAdapter,
} from "./backend.js";
import { isBs9Environment, type RuntimeConfig } from "./config.js";

// Singletons
export const state = new State();
export const events = new Events();
export const lease = new Lease(state);
export const queue = new Queue(state);

// Configuration functions
export function configureRuntime(config: Partial<RuntimeConfig>): void {
  getDefaultRuntimeBackend().configure(config);
}

export function getRuntimeConfig(): RuntimeConfig {
  return getDefaultRuntimeBackend().getConfig();
}

export async function resetRuntime(): Promise<void> {
  await resetDefaultRuntimeBackend();
}

// Classes
export { State, Events, Lease, Queue, RuntimeBackend };

// Types & Helpers
export type { RuntimeConfig, StateAdapter, LeaseAcquireResult };
export { isBs9Environment };

// Compatibility Adapters
export * from "./adapters/index.js";
