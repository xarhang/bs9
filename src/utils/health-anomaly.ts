/**
 * BS9 - Memory Leak Trend & Event-Loop Lag Detector
 *
 * Lightweight, bounded-memory anomaly detector for early warning before OOM
 * or event-loop starvation.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { formatAlertPayload, type AlertProvider, type Bs9AlertEvent } from "./alert-presets.js";

export interface MemoryLeakResult {
  service: string;
  leakSuspected: boolean;
  consecutiveIncreases: number;
  growthRatio: number;
  latestBytes: number;
}

export interface HealthAnomalyOptions {
  minConsecutiveIncreases?: number;
  minGrowthRatio?: number;
  maxSamplesPerService?: number;
  maxTrackedServices?: number;
}

export class HealthAnomalyDetector {
  private samples = new Map<string, number[]>();
  private readonly minConsecutiveIncreases: number;
  private readonly minGrowthRatio: number;
  private readonly maxSamplesPerService: number;
  private readonly maxTrackedServices: number;

  constructor(options: HealthAnomalyOptions = {}) {
    const minInc = Number.isFinite(options.minConsecutiveIncreases) ? options.minConsecutiveIncreases! : 5;
    const minGrowth = Number.isFinite(options.minGrowthRatio) ? options.minGrowthRatio! : 0.25;
    const maxSamples = Number.isFinite(options.maxSamplesPerService) ? options.maxSamplesPerService! : 20;
    const maxTracked = Number.isFinite(options.maxTrackedServices) ? options.maxTrackedServices! : 1000;
    this.minConsecutiveIncreases = Math.max(3, minInc);
    this.minGrowthRatio = Math.max(0.05, minGrowth);
    this.maxSamplesPerService = Math.max(this.minConsecutiveIncreases + 1, maxSamples);
    this.maxTrackedServices = Math.max(10, maxTracked);
  }

  recordMemorySample(service: string, rssBytes: number): MemoryLeakResult {
    if (!Number.isFinite(rssBytes) || rssBytes <= 0) {
      return {
        service,
        leakSuspected: false,
        consecutiveIncreases: 0,
        growthRatio: 0,
        latestBytes: 0,
      };
    }

    if (!this.samples.has(service) && this.samples.size >= this.maxTrackedServices) {
      const oldestKey = this.samples.keys().next().value;
      if (oldestKey !== undefined) this.samples.delete(oldestKey);
    }

    let history = this.samples.get(service);
    if (!history) {
      history = [];
      this.samples.set(service, history);
    }

    history.push(rssBytes);
    if (history.length > this.maxSamplesPerService) {
      history.shift();
    }

    let consecutiveIncreases = 0;
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i] > history[i - 1]) {
        consecutiveIncreases++;
      } else {
        break;
      }
    }

    const windowStartIdx = Math.max(0, history.length - 1 - consecutiveIncreases);
    const baselineBytes = history[windowStartIdx] || rssBytes;
    const growthRatio = baselineBytes > 0 ? (rssBytes - baselineBytes) / baselineBytes : 0;
    const leakSuspected =
      consecutiveIncreases >= this.minConsecutiveIncreases && growthRatio >= this.minGrowthRatio;

    return {
      service,
      leakSuspected,
      consecutiveIncreases,
      growthRatio,
      latestBytes: rssBytes,
    };
  }

  async measureEventLoopLag(): Promise<number> {
    const start = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return Math.max(0, performance.now() - start);
  }

  buildMemoryLeakAlert(
    provider: AlertProvider,
    result: MemoryLeakResult,
    host?: string
  ): Record<string, unknown> {
    const mb = (result.latestBytes / (1024 * 1024)).toFixed(1);
    const pct = (result.growthRatio * 100).toFixed(1);
    const event: Bs9AlertEvent = {
      service: result.service,
      severity: "warning",
      title: "Potential Memory Leak Detected",
      message: `RSS grew monotonically across ${result.consecutiveIncreases} samples (+${pct}%, now ${mb} MB)`,
      host,
    };
    return formatAlertPayload(provider, event);
  }

  clearService(service: string): void {
    this.samples.delete(service);
  }
}
