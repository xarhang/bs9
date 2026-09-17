/**
 * BS9 - Runtime Queue Client (Atomic FIFO Queue)
 *
 * Implements:
 * - push(queueName: string, item: unknown, options?: Record<string, any>): Promise<string>
 * - pop(queueName: string, options?: { timeoutMs?: number }): Promise<any>
 *
 * Backed by BS9 State Hub in cluster mode or in-memory queue manager in standalone mode.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { State } from "./state.js";
import { getDefaultRuntimeBackend, RuntimeBackend } from "./backend.js";

export class Queue {
  private customBackend?: RuntimeBackend;
  private state: State;

  constructor(stateOrBackend?: State | RuntimeBackend) {
    if (stateOrBackend instanceof RuntimeBackend) {
      this.customBackend = stateOrBackend;
      this.state = new State(stateOrBackend);
    } else if (stateOrBackend instanceof State) {
      this.state = stateOrBackend;
    } else {
      this.state = new State();
    }
  }

  private get backend(): RuntimeBackend {
    return this.customBackend || getDefaultRuntimeBackend();
  }

  public async push(queueName: string, item: unknown, options?: Record<string, any>): Promise<string> {
    await this.backend.ensureConnected();
    const client = this.backend.getHubClient();
    if (client) {
      const res = await client.queuePublish(queueName, item, options);
      return res.messageId;
    }

    const memQueue = this.backend.getInMemoryQueues();
    const ns = this.backend.getConfig().namespace || "default";
    const res = memQueue.publish(ns, queueName, item, options);
    return res.messageId;
  }

  public async pop(queueName: string, options?: { timeoutMs?: number }): Promise<any> {
    await this.backend.ensureConnected();
    const client = this.backend.getHubClient();
    const ns = this.backend.getConfig().namespace || "default";
    const timeoutMs = options?.timeoutMs ?? 0;
    const startTime = Date.now();

    while (true) {
      if (client) {
        const res = await client.queueReserve(queueName, 30000, 1);
        if (res.messages.length > 0) {
          const msg = res.messages[0];
          await client.queueAck(queueName, msg.id);
          return msg.payload;
        }
      } else {
        const memQueue = this.backend.getInMemoryQueues();
        const reserved = memQueue.reserve(ns, queueName, 30000, 1);
        if (reserved.length > 0) {
          const msg = reserved[0];
          memQueue.ack(ns, queueName, msg.id);
          return msg.payload;
        }
      }

      if (timeoutMs <= 0 || Date.now() - startTime >= timeoutMs) {
        return null;
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, remaining))));
    }
  }
}
