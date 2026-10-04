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
import { MAX_FRAME_SIZE, MAX_NAMESPACE_MEMORY, MAX_VALUE_SIZE } from "./protocol.js";

// Queue state has no existing separate limits. Reuse the Hub's documented
// per-namespace memory budget and reserve space for JS object/array/map
// bookkeeping so a flood of empty messages cannot bypass the byte budget.
export const QUEUE_MESSAGE_OVERHEAD_BYTES = 256;
export const MAX_NAMESPACE_QUEUE_MESSAGES = Math.floor(
  MAX_NAMESPACE_MEMORY / QUEUE_MESSAGE_OVERHEAD_BYTES
);

export interface PreparedQueueMessage {
  namespace: string;
  queueName: string;
  message: QueueMessage;
  accountedBytes: number;
}

export interface QueueManagerOptions {
  sweeperIntervalMs?: number;
  /** Separate in-memory queue budget, defaulting to the Hub's documented per-namespace limit. */
  maxNamespaceMemory?: number;
}

interface QueueUsage {
  messages: number;
  bytes: number;
}

/** Conservative estimate of the retained JS object graph, not just its JSON wire size. */
function estimateRetainedMemory(value: any, depth = 0): number {
  if (depth > 100) throw new Error("Value nesting depth exceeds maximum limit of 100");
  if (typeof value === "string") return value.length * 2 + 24;
  if (typeof value === "number") return 16;
  if (typeof value === "boolean" || value === null || value === undefined) return 8;
  if (Array.isArray(value)) {
    let bytes = 64 + value.length * 8;
    for (const item of value) bytes += estimateRetainedMemory(item, depth + 1);
    return bytes;
  }
  if (typeof value === "object") {
    let bytes = 96;
    for (const [key, child] of Object.entries(value)) {
      bytes += 24 + key.length * 2 + estimateRetainedMemory(child, depth + 1);
    }
    return bytes;
  }
  return 16;
}

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
  private messageIds: Map<string, Set<string>> = new Map();
  private queueUsage: Map<string, QueueUsage> = new Map();
  private messageCosts = new WeakMap<QueueMessage, number>();
  private preparedMessages = new WeakMap<PreparedQueueMessage, number>();
  private sweeperTimer: any = null;
  private maxNamespaceMemory: number;
  private maxNamespaceMessages: number;

  constructor(
    sweeperIntervalOrOptions: number | QueueManagerOptions = 1000,
    maxNamespaceMemory = MAX_NAMESPACE_MEMORY
  ) {
    const sweeperIntervalMs =
      typeof sweeperIntervalOrOptions === "number"
        ? sweeperIntervalOrOptions
        : sweeperIntervalOrOptions.sweeperIntervalMs ?? 1000;
    this.maxNamespaceMemory =
      typeof sweeperIntervalOrOptions === "number"
        ? maxNamespaceMemory
        : sweeperIntervalOrOptions.maxNamespaceMemory ?? MAX_NAMESPACE_MEMORY;
    if (!Number.isFinite(this.maxNamespaceMemory) || this.maxNamespaceMemory < 0) {
      throw new RangeError("Queue maxNamespaceMemory must be a finite non-negative number");
    }
    this.maxNamespaceMemory = Math.floor(this.maxNamespaceMemory);
    this.maxNamespaceMessages = Math.floor(
      this.maxNamespaceMemory / QUEUE_MESSAGE_OVERHEAD_BYTES
    );
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
    // A tuple encoding is unambiguous even when either name contains colons.
    return JSON.stringify([namespace, queueName]);
  }

  public getMessages(namespace: string, queueName: string): QueueMessage[] {
    const key = this.getKey(namespace, queueName);
    return (this.queues.get(key) || []).map((message) => this.cloneMessage(message));
  }

  public hasMessage(namespace: string, queueName: string, messageId: string): boolean {
    return this.messageIds.get(this.getKey(namespace, queueName))?.has(messageId) || false;
  }

  public getQueueProjection(
    namespace: string,
    queueName: string
  ): Array<{ id: string; item: any }> | null {
    const list = this.queues.get(this.getKey(namespace, queueName)) || [];
    const projected: Array<{ id: string; item: any }> = [];
    let bytes = 2; // []
    for (const message of list) {
      const row = { id: message.id, item: message.payload };
      const serialized = JSON.stringify(row);
      if (typeof serialized !== "string") return null;
      bytes += Buffer.byteLength(serialized, "utf-8") + (projected.length > 0 ? 1 : 0);
      if (bytes > MAX_VALUE_SIZE) return null;
      projected.push(row);
    }
    return projected;
  }

  private cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value;
    return structuredClone(value);
  }

  private freezeJsonValue<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) {
      this.freezeJsonValue(child);
    }
    return Object.freeze(value);
  }

  private cloneMessage(message: QueueMessage): QueueMessage {
    return {
      ...message,
      payload: this.cloneJsonValue(message.payload),
      options: this.cloneJsonValue(message.options),
    };
  }

  private getUsage(namespace: string): QueueUsage {
    return this.queueUsage.get(namespace) || { messages: 0, bytes: 0 };
  }

  private assertCapacity(namespace: string, accountedBytes: number): void {
    const usage = this.getUsage(namespace);
    const nextMessages = usage.messages + 1;
    const nextBytes = usage.bytes + accountedBytes;
    if (
      nextMessages > this.maxNamespaceMessages ||
      nextBytes > this.maxNamespaceMemory
    ) {
      const error = new Error(
        `[QUEUE_CAPACITY_EXCEEDED] Namespace queue capacity exceeded: requested ${nextBytes} bytes and ${nextMessages} messages; limits are ${this.maxNamespaceMemory} bytes and ${this.maxNamespaceMessages} messages`
      ) as Error & { code: string };
      error.code = "QUEUE_CAPACITY_EXCEEDED";
      throw error;
    }
  }

  private adjustUsage(namespace: string, messageDelta: number, byteDelta: number): void {
    const usage = this.getUsage(namespace);
    const messages = usage.messages + messageDelta;
    const bytes = usage.bytes + byteDelta;
    if (messages <= 0 && bytes <= 0) {
      this.queueUsage.delete(namespace);
      return;
    }
    this.queueUsage.set(namespace, { messages, bytes });
  }

  private prepareMessage(
    namespace: string,
    queueName: string,
    messageId: string,
    payload: any,
    createdAt: number,
    options?: Record<string, any>
  ): PreparedQueueMessage {
    if (typeof queueName !== "string") {
      throw new Error("Queue name must be a string");
    }

    validateSafeData(payload);
    validateSafeData(options);

    // Store the JSON representation used by the wire and WAL so values such as
    // undefined or NaN cannot differ between live state and recovered state.
    let serialized: string;
    try {
      serialized = JSON.stringify({ queueName, messageId, payload, options });
    } catch (err) {
      throw new Error(`Queue message must be JSON serializable: ${(err as Error).message}`);
    }
    if (typeof serialized !== "string") {
      throw new Error("Queue message must be JSON serializable");
    }
    const messageBytes = Buffer.byteLength(serialized, "utf-8");
    if (messageBytes > MAX_FRAME_SIZE) {
      throw new Error(
        `Queue message size ${messageBytes} exceeds maximum protocol frame size ${MAX_FRAME_SIZE} bytes`
      );
    }

    const canonical = JSON.parse(serialized) as {
      queueName: string;
      messageId: string;
      payload?: any;
      options?: Record<string, any>;
    };
    const message: QueueMessage = {
      id: messageId,
      payload: canonical.payload,
      deliveryCount: 0,
      reservedUntil: 0,
      createdAt,
      options: canonical.options,
    };
    // JSON bytes undercount the retained graph: arrays reserve element slots,
    // objects retain property tables and keys, and JS strings use UTF-16. Use
    // the larger structural estimate so sparse/container-heavy payloads cannot
    // exceed the namespace queue budget while appearing small on the wire.
    const retainedBytes = estimateRetainedMemory({
      queueName: canonical.queueName,
      messageId: canonical.messageId,
      payload: canonical.payload,
      options: canonical.options,
    });
    const accountedBytes = Math.max(messageBytes, retainedBytes) + QUEUE_MESSAGE_OVERHEAD_BYTES;
    return { namespace, queueName, message, accountedBytes };
  }

  public preparePublish(
    namespace: string,
    queueName: string,
    payload: any,
    options?: Record<string, any>
  ): PreparedQueueMessage {
    const prepared = this.prepareMessage(
      namespace,
      queueName,
      randomUUID(),
      payload,
      Date.now(),
      options
    );
    this.assertCapacity(namespace, prepared.accountedBytes);
    this.freezeJsonValue(prepared.message.payload);
    this.freezeJsonValue(prepared.message.options);
    Object.freeze(prepared.message);
    Object.freeze(prepared);
    this.preparedMessages.set(prepared, prepared.accountedBytes);
    return prepared;
  }

  public publishPrepared(
    namespace: string,
    queueName: string,
    prepared: PreparedQueueMessage
  ): { messageId: string } {
    if (
      this.preparedMessages.get(prepared) !== prepared.accountedBytes ||
      prepared.namespace !== namespace ||
      prepared.queueName !== queueName
    ) {
      throw new Error("Invalid or already committed prepared queue message");
    }
    this.assertCapacity(namespace, prepared.accountedBytes);
    this.preparedMessages.delete(prepared);
    const key = this.getKey(namespace, queueName);
    const storedMessage = { ...prepared.message };
    this.getOrCreateQueue(namespace, queueName).push(storedMessage);
    this.messageIds.get(key)!.add(storedMessage.id);
    this.messageCosts.set(storedMessage, prepared.accountedBytes);
    this.adjustUsage(namespace, 1, prepared.accountedBytes);
    return { messageId: storedMessage.id };
  }

  private getOrCreateQueue(namespace: string, queueName: string): QueueMessage[] {
    const key = this.getKey(namespace, queueName);
    let list = this.queues.get(key);
    if (!list) {
      list = [];
      this.queues.set(key, list);
      this.messageIds.set(key, new Set());
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
    const prepared = this.preparePublish(namespace, queueName, payload, options);
    return this.publishPrepared(namespace, queueName, prepared);
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
          payload: this.cloneJsonValue(msg.payload),
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

    const [removed] = list.splice(idx, 1);
    this.messageIds.get(key)?.delete(removed.id);
    const accountedBytes = this.messageCosts.get(removed) || 0;
    this.messageCosts.delete(removed);
    this.adjustUsage(namespace, -1, -accountedBytes);
    if (list.length === 0) {
      this.queues.delete(key);
      this.messageIds.delete(key);
    }
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
    const key = this.getKey(namespace, queueName);
    if (this.messageIds.get(key)?.has(messageId)) return;

    // Replay/import may contain a legacy namespace above the new budget. Keep
    // that state recoverable and drainable; new publishes remain blocked until
    // it falls below the configured capacity.
    const prepared = this.prepareMessage(
      namespace,
      queueName,
      messageId,
      payload,
      createdAt ?? Date.now(),
      options
    );
    this.getOrCreateQueue(namespace, queueName).push(prepared.message);
    this.messageIds.get(key)!.add(messageId);
    this.freezeJsonValue(prepared.message.payload);
    this.freezeJsonValue(prepared.message.options);
    this.messageCosts.set(prepared.message, prepared.accountedBytes);
    this.adjustUsage(namespace, 1, prepared.accountedBytes);
  }

  public applyAck(namespace: string, queueName: string, messageId: string): void {
    this.ack(namespace, queueName, messageId);
  }

  public applyNack(namespace: string, queueName: string, messageId: string): void {
    this.nack(namespace, queueName, messageId);
  }

  // --- Snapshot Export / Import ---

  /** Validate a complete queue snapshot without mutating live queue state. */
  public validateImportState(data: Record<string, QueueMessage[]>): void {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid queue snapshot: expected an object of queue arrays");
    }

    for (const [queueName, messages] of Object.entries(data)) {
      if (!Array.isArray(messages)) {
        throw new Error(`Invalid queue snapshot for "${queueName}": expected an array`);
      }
      const messageIds = new Set<string>();
      for (const source of messages) {
        if (
          !source ||
          typeof source.id !== "string" ||
          typeof source.createdAt !== "number" ||
          typeof source.deliveryCount !== "number" ||
          typeof source.reservedUntil !== "number"
        ) {
          throw new Error(`Invalid queue message in snapshot for "${queueName}"`);
        }
        if (messageIds.has(source.id)) {
          throw new Error(`Duplicate queue message id in snapshot for "${queueName}"`);
        }
        messageIds.add(source.id);

        const options = source.options;
        validateSafeData(source.payload);
        validateSafeData(options);
        let serialized: string;
        try {
          serialized = JSON.stringify({
            queueName,
            messageId: source.id,
            payload: source.payload,
            options,
          });
        } catch (error) {
          throw new Error(`Invalid queue message in snapshot for "${queueName}": ${(error as Error).message}`);
        }
        if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf-8") > MAX_FRAME_SIZE) {
          throw new Error(`Queue message in snapshot for "${queueName}" exceeds the maximum frame size`);
        }
        estimateRetainedMemory({ queueName, messageId: source.id, payload: source.payload, options });
      }
    }
  }

  public exportState(namespace: string): Record<string, QueueMessage[]> {
    const result: Record<string, QueueMessage[]> = Object.create(null);

    for (const [key, list] of this.queues.entries()) {
      const tuple = JSON.parse(key) as unknown;
      if (
        Array.isArray(tuple) &&
        tuple.length === 2 &&
        tuple[0] === namespace &&
        typeof tuple[1] === "string"
      ) {
        const queueName = tuple[1];
        if (list.length > 0) {
          result[queueName] = list.map((m) => this.cloneMessage(m));
        }
      }
    }

    return result;
  }

  public importState(
    namespace: string,
    data: Record<string, QueueMessage[]>
  ): void {
    this.validateImportState(data);
    const staged = new Map<string, QueueMessage[]>();
    const stagedIds = new Map<string, Set<string>>();
    const stagedCosts = new Map<QueueMessage, number>();
    const replacedKeys = new Set<string>();
    let importedMessages = 0;
    let importedBytes = 0;

    for (const [queueName, messages] of Object.entries(data)) {
      const key = this.getKey(namespace, queueName);
      if (!Array.isArray(messages)) {
        throw new Error(`Invalid queue snapshot for "${queueName}": expected an array`);
      }
      replacedKeys.add(key);
      if (messages.length === 0) {
        staged.set(key, []);
        stagedIds.set(key, new Set());
        continue;
      }
      const now = Date.now();
      const list: QueueMessage[] = [];
      const messageIds = new Set<string>();
      for (const source of messages) {
        if (
          !source ||
          typeof source.id !== "string" ||
          typeof source.createdAt !== "number" ||
          typeof source.deliveryCount !== "number" ||
          typeof source.reservedUntil !== "number"
        ) {
          throw new Error(`Invalid queue message in snapshot for "${queueName}"`);
        }
        if (messageIds.has(source.id)) {
          throw new Error(`Duplicate queue message id in snapshot for "${queueName}"`);
        }
        messageIds.add(source.id);
        const prepared = this.prepareMessage(
          namespace,
          queueName,
          source.id,
          source.payload,
          source.createdAt,
          source.options
        );
        const message: QueueMessage = {
          ...prepared.message,
          deliveryCount: source.deliveryCount,
          reservedUntil: source.reservedUntil > now ? source.reservedUntil : 0,
        };
        this.freezeJsonValue(message.payload);
        this.freezeJsonValue(message.options);
        list.push(message);
        stagedCosts.set(message, prepared.accountedBytes);
        importedMessages++;
        importedBytes += prepared.accountedBytes;
      }
      staged.set(key, list);
      stagedIds.set(key, messageIds);
    }

    // Replace the target namespace's current queues transactionally. Oversized
    // legacy state remains available for recovery/draining, but capacity checks
    // reject any additional messages until it is back within budget.
    const current = this.getUsage(namespace);
    let replacedMessages = 0;
    let replacedBytes = 0;
    for (const key of replacedKeys) {
      for (const message of this.queues.get(key) || []) {
        replacedMessages++;
        replacedBytes += this.messageCosts.get(message) || 0;
      }
    }

    for (const [key, list] of staged) {
      if (list.length === 0) {
        this.queues.delete(key);
        this.messageIds.delete(key);
        continue;
      }
      this.queues.set(key, list);
      this.messageIds.set(key, stagedIds.get(key)!);
      for (const message of list) {
        this.messageCosts.set(message, stagedCosts.get(message)!);
      }
    }

    const nextMessages = current.messages - replacedMessages + importedMessages;
    const nextBytes = current.bytes - replacedBytes + importedBytes;
    if (nextMessages <= 0 && nextBytes <= 0) this.queueUsage.delete(namespace);
    else this.queueUsage.set(namespace, { messages: nextMessages, bytes: nextBytes });
  }

  public close(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    this.queues.clear();
    this.messageIds.clear();
    this.queueUsage.clear();
    this.messageCosts = new WeakMap();
  }
}
