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
  missingGraceMs?: number;
  maxResurrectionAttempts?: number;
  onResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;
}

export class ClusterReconciler extends EventEmitter {
  private controller: ClusterController;
  private intervalMs: number;
  private missingGraceMs: number;
  private maxResurrectionAttempts: number;
  private timer: any = null;
  private isRunning = false;
  private isReconciling = false;
  private inFlightResurrections: Map<string, { nextGen: number; timestamp: number }> = new Map();
  private missingSince: Map<string, number> = new Map();
  private failureBackoff: Map<string, { attempts: number; nextRetryAt: number; exhausted?: boolean }> = new Map();
  private onResurrectSlot?: (manifest: ClusterManifestData, slot: number, nextGen: number) => Promise<void>;
  private boundOnWorkerReady: (worker: any) => void;
  private boundOnWorkerConnected: (worker: any) => void;

  constructor(controller: ClusterController, options: ReconcilerOptions = {}) {
    super();
    this.controller = controller;
    this.intervalMs = options.intervalMs || 2000;
    // Native supervisors (launchd/systemd/Windows SCM) may restart the same
    // physical unit after a crash. Give that unit time to reconnect before
    // creating a new generation, otherwise both can become active.
    this.missingGraceMs = options.missingGraceMs ?? Math.max(3000, this.intervalMs * 2);
    this.maxResurrectionAttempts = options.maxResurrectionAttempts ?? 10;
    this.onResurrectSlot = options.onResurrectSlot;

    // Listen to worker ready/connected events to clear in-flight status
    this.boundOnWorkerReady = (worker: any) => {
      if (worker && worker.clusterName !== undefined && worker.slot !== undefined) {
        const slotKey = `${worker.clusterName}:${worker.slot}`;
        this.inFlightResurrections.delete(slotKey);
        this.missingSince.delete(slotKey);
        this.failureBackoff.delete(slotKey);
      }
    };
    this.boundOnWorkerConnected = (worker: any) => {
      if (worker && worker.clusterName !== undefined && worker.slot !== undefined) {
        this.inFlightResurrections.delete(`${worker.clusterName}:${worker.slot}`);
        this.missingSince.delete(`${worker.clusterName}:${worker.slot}`);
      }
    };

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

    this.controller.off("worker:ready", this.boundOnWorkerReady);
    this.controller.off("worker:connected", this.boundOnWorkerConnected);
    this.controller.on("worker:ready", this.boundOnWorkerReady);
    this.controller.on("worker:connected", this.boundOnWorkerConnected);

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
    this.missingSince.clear();
    this.failureBackoff.clear();
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
      const activeSlots = new Set<string>();
      for (const manifest of manifests) {
        const desiredInstances = manifest.instances ?? 1;
        for (let slot = 0; slot < desiredInstances; slot++) {
          activeSlots.add(`${manifest.clusterName}:${slot}`);
        }
      }
      for (const key of this.inFlightResurrections.keys()) {
        if (!activeSlots.has(key)) this.inFlightResurrections.delete(key);
      }
      for (const key of this.missingSince.keys()) {
        if (!activeSlots.has(key)) this.missingSince.delete(key);
      }
      for (const key of this.failureBackoff.keys()) {
        if (!activeSlots.has(key)) this.failureBackoff.delete(key);
      }

      for (const manifest of manifests) {
        const clusterName = manifest.clusterName;

        // Mandatory constraint: Reconciler is strictly inactive during reload/scale/stop transitions!
        if (this.controller.isClusterLocked(clusterName)) {
          continue;
        }

        const workers = this.controller.getClusterWorkers(clusterName);
        const desiredInstances = manifest.instances ?? 1;

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

          if (hasAliveWorker) {
            this.missingSince.delete(slotKey);
            continue;
          }

          const firstMissingAt = this.missingSince.get(slotKey);
          if (firstMissingAt === undefined) {
            this.missingSince.set(slotKey, Date.now());
            continue;
          }

          if (Date.now() - firstMissingAt < this.missingGraceMs) {
            continue;
          }

          const backoff = this.failureBackoff.get(slotKey);
          if (backoff) {
            if (backoff.attempts >= this.maxResurrectionAttempts) {
              if (!backoff.exhausted) {
                backoff.exhausted = true;
                this.emit("slot:exhausted", { clusterName, slot, attempts: backoff.attempts });
              }
              continue;
            }
            if (Date.now() < backoff.nextRetryAt) {
              continue;
            }
          }

          if (!hasAliveWorker) {
            this.missingSince.delete(slotKey);
            const lock = this.controller.lockCluster(clusterName, "manual", 120_000, `reconciler:${slot}`);
            if (!lock.acquired || !lock.lockToken) continue;

            const lockToken = lock.lockToken;
            let lockLost = false;
            const renewalTimer = setInterval(() => {
              if (!this.controller.renewClusterLock(clusterName, lockToken, 120_000).renewed) {
                lockLost = true;
              }
            }, 30_000);
            try {
              // Re-read under the cluster lock. The outer manifest snapshot may
              // predate a concurrent account migration or lifecycle mutation.
              const latestManifest = this.controller.getManifest(clusterName);
              if (!latestManifest) continue;
              const latestSlotWorkers = this.controller.getClusterWorkers(clusterName)
                .filter((worker) => worker.slot === slot);
              if (latestSlotWorkers.some((worker) =>
                worker.status === "ready" || worker.status === "connected" || worker.status === "draining"
              )) {
                continue;
              }

              const latestInFlight = this.inFlightResurrections.get(slotKey);
              if (latestInFlight && Date.now() - latestInFlight.timestamp < 20_000) continue;
              const knownGens = [
                latestManifest.currentGeneration ?? 1,
                ...latestSlotWorkers.map((worker) => worker.generation),
              ];
              if (latestInFlight?.nextGen) knownGens.push(latestInFlight.nextGen);
              if (inFlight?.nextGen) knownGens.push(inFlight.nextGen);
              const nextGen = Math.max(...knownGens) + 1;

              if (lockLost || !this.controller.renewClusterLock(clusterName, lockToken, 120_000).renewed) {
                lockLost = true;
                continue;
              }

              const nextAttempts = (this.failureBackoff.get(slotKey)?.attempts ?? 0) + 1;
              const backoffDelayMs = Math.min(60_000, this.intervalMs * Math.pow(2, nextAttempts - 1));
              this.failureBackoff.set(slotKey, {
                attempts: nextAttempts,
                nextRetryAt: Date.now() + backoffDelayMs,
              });

              const updatedManifest: ClusterManifestData = {
                ...latestManifest,
                currentGeneration: nextGen,
                updatedAt: Date.now(),
              };

              this.emit("slot:missing", { clusterName, slot, nextGen });
              if (this.onResurrectSlot) {
                this.inFlightResurrections.set(slotKey, { nextGen, timestamp: Date.now() });
                try {
                  await this.onResurrectSlot(updatedManifest, slot, nextGen);
                  if (!lockLost && this.controller.renewClusterLock(clusterName, lockToken, 120_000).renewed) {
                    this.controller.setManifest(updatedManifest);
                    manifest.currentGeneration = nextGen;
                    manifest.updatedAt = updatedManifest.updatedAt;
                  }
                  this.emit("slot:resurrected", { clusterName, slot, nextGen });
                } catch (err) {
                  this.inFlightResurrections.delete(slotKey);
                  this.emit("slot:resurrect-failed", { clusterName, slot, nextGen, error: err });
                }
              } else {
                this.controller.setManifest(updatedManifest);
                manifest.currentGeneration = nextGen;
                manifest.updatedAt = updatedManifest.updatedAt;
              }
            } finally {
              clearInterval(renewalTimer);
              this.controller.unlockCluster(clusterName, lockToken);
            }
          }
        }
      }
    } finally {
      this.isReconciling = false;
    }
  }
}
