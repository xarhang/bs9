/**
 * BS9 - Desired-State Cluster Reconciler
 *
 * Background supervisor loop that continuously matches actual running cluster slots
 * against desired-state manifests:
 * - Generation-aware: tracks physical worker generations (<app>-<slot>-g<gen>).
 * - Operation-locked: completely inactive on clusters undergoing reload, scale, or stop.
 * - Non-interfering: honors graceful shutdown and drain transitions.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";
import { type ClusterController } from "../cluster/controller.js";
import { type ClusterManifestData } from "../hub/protocol.js";

export interface ReconcilerOptions {
  intervalMs?: number;
  onResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;
}

export class ClusterReconciler extends EventEmitter {
  private controller: ClusterController;
  private intervalMs: number;
  private timer: any = null;
  private isRunning = false;
  private isReconciling = false;
  private inFlightResurrections: Map<string, { nextGen: number; timestamp: number }> = new Map();
  private onResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;
  private boundOnWorkerReady: (worker: any) => void;
  private boundOnWorkerConnected: (worker: any) => void;

  constructor(controller: ClusterController, options: ReconcilerOptions = {}) {
    super();
    this.controller = controller;
    this.intervalMs = options.intervalMs || 2000;
    this.onResurrectSlot = options.onResurrectSlot;

    // Listen to worker ready/connected events to clear in-flight status
    this.boundOnWorkerReady = (worker: any) => {
      if (worker && worker.clusterName !== undefined && worker.slot !== undefined) {
        this.inFlightResurrections.delete(`${worker.clusterName}:${worker.slot}`);
      }
    };
    this.boundOnWorkerConnected = (worker: any) => {
      if (worker && worker.clusterName !== undefined && worker.slot !== undefined) {
        this.inFlightResurrections.delete(`${worker.clusterName}:${worker.slot}`);
      }
    };

    this.controller.on("worker:ready", this.boundOnWorkerReady);
    this.controller.on("worker:connected", this.boundOnWorkerConnected);

    // Register status provider with controller for ADMIN_PING
    this.controller.setReconcilerProvider(() => ({
      active: this.isRunning,
      lockedClusters: this.controller.getLockedClusters(),
      managedClustersCount: this.controller.getAllManifests().length,
    }));
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(() => {
      this.reconcile().catch((err) => {
        this.emit("error", err);
      });
    }, this.intervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    this.emit("started");
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.controller.off("worker:ready", this.boundOnWorkerReady);
    this.controller.off("worker:connected", this.boundOnWorkerConnected);
    this.inFlightResurrections.clear();
    this.emit("stopped");
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Evaluates all cluster manifests and triggers resurrection for missing slots if unlocked.
   */
  public async reconcile(): Promise<void> {
    if (!this.isRunning || this.isReconciling) return;
    this.isReconciling = true;

    try {
      const manifests = this.controller.getAllManifests();
      for (const manifest of manifests) {
        const clusterName = manifest.clusterName;

        // Mandatory constraint: Reconciler is strictly inactive during reload/scale/stop transitions!
        if (this.controller.isClusterLocked(clusterName)) {
          continue;
        }

        const workers = this.controller.getClusterWorkers(clusterName);
        const desiredInstances = manifest.instances || 1;

        // Group existing connected workers by slot
        const slotMap = new Map<number, typeof workers>();
        for (const w of workers) {
          const list = slotMap.get(w.slot) || [];
          list.push(w);
          slotMap.set(w.slot, list);
        }

        for (let slot = 0; slot < desiredInstances; slot++) {
          // Re-check lock in case an operation was initiated concurrently
          if (this.controller.isClusterLocked(clusterName)) {
            break;
          }

          const slotKey = `${clusterName}:${slot}`;
          const inFlight = this.inFlightResurrections.get(slotKey);
          if (inFlight) {
            // If already being resurrected within grace period (20s), do not duplicate-resurrect!
            if (Date.now() - inFlight.timestamp < 20000) {
              continue;
            } else {
              this.inFlightResurrections.delete(slotKey);
            }
          }

          const slotWorkers = slotMap.get(slot) || [];
          const hasAliveWorker = slotWorkers.some(
            (w) => w.status === "ready" || w.status === "connected" || w.status === "draining"
          );

          if (!hasAliveWorker) {
            // Identify highest seen generation across manifest, slot workers, and in-flight tracking
            const knownGens = [
              manifest.currentGeneration ?? 1,
              ...slotWorkers.map((w) => w.generation),
            ];
            if (inFlight?.nextGen) {
              knownGens.push(inFlight.nextGen);
            }
            const highestGen = Math.max(...knownGens);
            const nextGen = highestGen + 1;

            // Atomically update and persist manifest currentGeneration
            manifest.currentGeneration = nextGen;
            manifest.updatedAt = Date.now();
            this.controller.setManifest(manifest);

            this.emit("slot:missing", { clusterName, slot, nextGen });

            if (this.onResurrectSlot) {
              this.inFlightResurrections.set(slotKey, { nextGen, timestamp: Date.now() });
              try {
                await this.onResurrectSlot(manifest, slot, nextGen);
                this.emit("slot:resurrected", { clusterName, slot, nextGen });
              } catch (err) {
                this.inFlightResurrections.delete(slotKey);
                this.emit("slot:resurrect-failed", { clusterName, slot, nextGen, error: err });
              }
            }
          }
        }
      }
    } finally {
      this.isReconciling = false;
    }
  }
}
