/**
 * BS9 - Durable Queues with Visibility Timeout & Redelivery
 *
 * Implements:
 * - Per-namespace named FIFO queues.
 * - At-least-once delivery semantics.
 * - Visibility timeouts: unacknowledged messages are automatically redelivered.
 * - Operations: publish, reserve, ack, nack.
 * - Background visibility timeout sweeper.
 * - State export and import for Snapshot and WAL replay.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { validateSafeData } from "./engine.js";
import { type ReservedMessage } from "./protocol.js";

export interface QueueMessage {
  id: string;
  payload: any;
  deliveryCount: number;
  reservedUntil: number;
  createdAt: number;
  options?: Record<string, any>;
}

export class QueueManager {
  private queues: Map<string, QueueMessage[]> = new Map();
  private sweeperTimer: any = null;

  constructor(sweeperIntervalMs = 1000) {
    if (sweeperIntervalMs > 0) {
      this.sweeperTimer = setInterval(() => {
        this.sweep();
      }, sweeperIntervalMs);
      if (typeof this.sweeperTimer.unref === "function") {
        this.sweeperTimer.unref();
      }
    }
  }

  private getKey(namespace: string, queueName: string): string {
    return `${namespace}:${queueName}`;
  }

  public getMessages(namespace: string, queueName: string): QueueMessage[] {
    const key = this.getKey(namespace, queueName);
    return this.queues.get(key) || [];
  }

  private getOrCreateQueue(namespace: string, queueName: string): QueueMessage[] {
    const key = this.getKey(namespace, queueName);
    let list = this.queues.get(key);
    if (!list) {
      list = [];
      this.queues.set(key, list);
    }
    return list;
  }

  /**
   * Appends a new message to the named queue.
   */
  public publish(
    namespace: string,
    queueName: string,
    payload: any,
    options?: Record<string, any>
  ): { messageId: string } {
    validateSafeData(payload);

    const messageId = randomUUID();
    const msg: QueueMessage = {
      id: messageId,
      payload,
      deliveryCount: 0,
      reservedUntil: 0,
      createdAt: Date.now(),
      options,
    };

    const list = this.getOrCreateQueue(namespace, queueName);
    list.push(msg);

    return { messageId };
  }

  /**
   * Reserves up to maxMessages available in FIFO order.
   * A message is available if reservedUntil <= Date.now().
   * Increments deliveryCount and extends reservedUntil = Date.now() + visibilityTimeoutMs.
   */
  public reserve(
    namespace: string,
    queueName: string,
    visibilityTimeoutMs: number = 30000,
    maxMessages: number = 1
  ): ReservedMessage[] {
    const key = this.getKey(namespace, queueName);
    const list = this.queues.get(key);
    if (!list || list.length === 0) {
      return [];
    }

    const now = Date.now();
    const result: ReservedMessage[] = [];

    for (const msg of list) {
      if (msg.reservedUntil <= now) {
        msg.deliveryCount += 1;
        msg.reservedUntil = now + visibilityTimeoutMs;
        result.push({
          id: msg.id,
          payload: msg.payload,
          deliveryCount: msg.deliveryCount,
          reservedUntil: msg.reservedUntil,
        });

        if (result.length >= maxMessages) {
          break;
        }
      }
    }

    return result;
  }

  /**
   * Acknowledges and permanently removes a message from the queue.
   */
  public ack(namespace: string, queueName: string, messageId: string): boolean {
    const key = this.getKey(namespace, queueName);
    const list = this.queues.get(key);
    if (!list) return false;

    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;

    list.splice(idx, 1);
    return true;
  }

  /**
   * Negative acknowledgment: clears reservation immediately, making it eligible
   * for instant redelivery.
   */
  public nack(namespace: string, queueName: string, messageId: string): boolean {
    const key = this.getKey(namespace, queueName);
    const list = this.queues.get(key);
    if (!list) return false;

    const msg = list.find((m) => m.id === messageId);
    if (!msg) return false;

    msg.reservedUntil = 0;
    return true;
  }

  /**
   * Scans all queues and resets any reservations that have passed reservedUntil.
   */
  public sweep(): number {
    const now = Date.now();
    let expiredCount = 0;

    for (const list of this.queues.values()) {
      for (const msg of list) {
        if (msg.reservedUntil > 0 && now >= msg.reservedUntil) {
          msg.reservedUntil = 0;
          expiredCount++;
        }
      }
    }

    return expiredCount;
  }

  // --- WAL Replay Methods ---

  public applyPublish(
    namespace: string,
    queueName: string,
    messageId: string,
    payload: any,
    createdAt?: number,
    options?: Record<string, any>
  ): void {
    const list = this.getOrCreateQueue(namespace, queueName);
    if (!list.some((m) => m.id === messageId)) {
      list.push({
        id: messageId,
        payload,
        deliveryCount: 0,
        reservedUntil: 0,
        createdAt: createdAt ?? Date.now(),
        options,
      });
    }
  }

  public applyAck(namespace: string, queueName: string, messageId: string): void {
    this.ack(namespace, queueName, messageId);
  }

  public applyNack(namespace: string, queueName: string, messageId: string): void {
    this.nack(namespace, queueName, messageId);
  }

  // --- Snapshot Export / Import ---

  public exportState(namespace: string): Record<string, QueueMessage[]> {
    const prefix = `${namespace}:`;
    const result: Record<string, QueueMessage[]> = {};

    for (const [key, list] of this.queues.entries()) {
      if (key.startsWith(prefix)) {
        const queueName = key.slice(prefix.length);
        result[queueName] = list.map((m) => ({ ...m }));
      }
    }

    return result;
  }

  public importState(
    namespace: string,
    data: Record<string, QueueMessage[]>
  ): void {
    for (const [queueName, messages] of Object.entries(data)) {
      const key = this.getKey(namespace, queueName);
      const now = Date.now();
      const list = messages.map((m) => ({
        ...m,
        reservedUntil: m.reservedUntil > now ? m.reservedUntil : 0,
      }));
      this.queues.set(key, list);
    }
  }

  public close(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    this.queues.clear();
  }
}
