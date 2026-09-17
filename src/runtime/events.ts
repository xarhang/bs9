/**
 * BS9 - Runtime Events Client
 *
 * Implements:
 * - emit(event: string, payload: unknown): Promise<void>
 * - on(event: string, handler: (payload: any) => void): () => void (unsubscribe)
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";
import { getDefaultRuntimeBackend, RuntimeBackend } from "./backend.js";

export class Events {
  private emitter = new EventEmitter();
  private customBackend?: RuntimeBackend;

  constructor(backend?: RuntimeBackend) {
    this.customBackend = backend;
    this.emitter.setMaxListeners(100);
  }

  private get backend(): RuntimeBackend {
    return this.customBackend || getDefaultRuntimeBackend();
  }

  public async emit(event: string, payload: unknown): Promise<void> {
    await this.backend.ensureConnected();
    this.emitter.emit(event, payload);
  }

  public on(event: string, handler: (payload: any) => void): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }
}
