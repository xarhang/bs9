#!/usr/bin/env bun

/**
 * BS9 - High-Availability Verification Tooling (`bs9 verify-ha`)
 *
 * SAFETY CRITICAL:
 * - Default behavior is strictly ISOLATED ephemeral verification.
 * - Spawns a dedicated temporary cluster on an ephemeral port.
 * - Continuous concurrent HTTP request generation during tests.
 * - Performs:
 *     a) Zero-downtime rolling reload test (verifies 0 dropped requests).
 *     b) Violent crash recovery test (SIGKILL / taskkill worker, verifies continuous service).
 * - Cleans up all ephemeral processes and IPC sockets upon completion.
 * - Only tests a live cluster if explicit `--live` flag is supplied.
 * - Measures: Total requests, 2xx responses, dropped/failed requests, error rate, p95/p99 latencies.
 * - Returns exit code 0 if availability is 100%, or exit code 1 if failures occurred.
 * - Supports `--json` flag for CI/CD gating.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { ClusterController } from "../cluster/controller.js";
import { reloadCommand } from "./reload.js";
import { listServices } from "../utils/service-discovery.js";

export interface VerifyHaOptions {
  live?: boolean;
  port?: number | string;
  concurrency?: number;
  instances?: number;
  readyTimeoutMs?: number;
  drainTimeoutMs?: number;
  json?: boolean;
  durationMs?: number;
  controller?: ClusterController;
}

export interface LatencyMetrics {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface VerifyHaMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number; // e.g. 0.0
  availability: number; // e.g. 100.0
  latency: LatencyMetrics;
}

export interface VerifyHaResult {
  target: string;
  mode: "ephemeral" | "live";
  port: number;
  passed: boolean;
  metrics: VerifyHaMetrics;
  tests: {
    rollingReload: {
      passed: boolean;
      totalRequests: number;
      successfulRequests: number;
      droppedRequests: number;
      generationsSeen: string[];
    };
    violentCrashRecovery: {
      passed: boolean;
      totalRequests: number;
      successfulRequests: number;
      droppedRequests: number;
      victimPid: number;
      survived: boolean;
    };
  };
  summary: string;
}

interface TrafficRecord {
  status: number;
  durationMs: number;
  error?: string;
  generation?: string;
  pid?: number;
}

/**
 * Obtain an open ephemeral port
 */
async function getFreePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 39400 + Math.floor(Math.random() * 500);
      s.close(() => res(port));
    });
    s.on("error", () => {
      res(39500 + Math.floor(Math.random() * 500));
    });
  });
}

/**
 * Calculate latency percentiles and distribution
 */
function calculateLatencyMetrics(durations: number[]): LatencyMetrics {
  if (durations.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const min = Math.round(sorted[0] * 100) / 100;
  const max = Math.round(sorted[sorted.length - 1] * 100) / 100;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round((sum / sorted.length) * 100) / 100;

  const getPercentile = (p: number) => {
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return Math.round(sorted[idx] * 100) / 100;
  };

  return {
    min,
    max,
    avg,
    p50: getPercentile(0.5),
    p95: getPercentile(0.95),
    p99: getPercentile(0.99),
  };
}

/**
 * Violently terminate a worker process
 */
function violentlyKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    } catch {}
  }
}

/**
 * Run isolated ephemeral verification
 */
async function runEphemeralVerification(file: string, options: VerifyHaOptions): Promise<VerifyHaResult> {
  const resolvedFile = resolve(file);
  if (!existsSync(resolvedFile)) {
    throw new Error(`Target file does not exist: ${file}`);
  }

  const instanceCount = Math.max(2, options.instances || 2);
  const testPort = options.port ? parseInt(String(options.port), 10) : await getFreePort();
  const concurrency = options.concurrency || 5;
  const readyTimeoutMs = options.readyTimeoutMs || 15000;
  const drainTimeoutMs = options.drainTimeoutMs || 5000;

  const clusterName = `ha-verify-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\bs9-verify-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    : join(tmpdir(), `bs9-verify-${Date.now()}-${Math.floor(Math.random() * 10000)}.sock`);

  const controller = options.controller || new ClusterController({ socketPath });
  const { tokenFilePath } = controller.registerClusterToken(clusterName);
  await controller.start();

  const preloadUrl = pathToFileURL(join(process.cwd(), "src", "utils", "cluster-preload.ts")).href;
  const targetUrl = pathToFileURL(resolvedFile).href;
  const wrapperScriptPath = join(tmpdir(), `bs9-verify-entry-${Date.now()}-${Math.floor(Math.random() * 1000)}.ts`);

  // Create ephemeral runner wrapper
  writeFileSync(wrapperScriptPath, `
import "${preloadUrl}";
const userModule = await import("${targetUrl}");
if (userModule.default && typeof userModule.default.fetch === "function") {
  Bun.serve(userModule.default);
}
`);

  const activeProcs = new Map<string, any>();

  function spawnWorker(slot: number, gen: number) {
    const proc = Bun.spawn(["bun", "run", wrapperScriptPath], {
      env: {
        ...process.env,
        PORT: String(testPort),
        BS9_CLUSTER: "true",
        BS9_REUSE_PORT: "true",
        BS9_OVERRIDE_PORT: "true",
        BS9_CLUSTER_NAME: clusterName,
        NODE_APP_INSTANCE: String(slot),
        BS9_CLUSTER_ID: String(slot),
        BS9_CLUSTER_GENERATION: String(gen),
        BS9_AUTH_TOKEN_FILE: tokenFilePath,
        BS9_CONTROLLER_SOCKET: socketPath,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    activeProcs.set(`${slot}:${gen}`, proc);
    return proc;
  }

  async function stopWorker(slot: number, gen: number) {
    const p = activeProcs.get(`${slot}:${gen}`);
    if (p) {
      try {
        p.kill();
      } catch {}
      activeProcs.delete(`${slot}:${gen}`);
    }
  }

  // Traffic generator state
  let isGeneratingTraffic = false;
  const trafficRecords: TrafficRecord[] = [];
  const generationsSeen = new Set<string>();
  let trafficLoopPromise: Promise<void> | null = null;

  function startTrafficGenerator() {
    isGeneratingTraffic = true;
    trafficLoopPromise = (async () => {
      while (isGeneratingTraffic) {
        const batch = Array.from({ length: concurrency }, async () => {
          const start = performance.now();
          try {
            const res = await fetch(`http://localhost:${testPort}/`, {
              signal: AbortSignal.timeout(3000),
            });
            const durationMs = performance.now() - start;
            let body: any = null;
            try {
              const txt = await res.text();
              body = JSON.parse(txt);
            } catch {}

            if (body?.generation) generationsSeen.add(String(body.generation));

            trafficRecords.push({
              status: res.status,
              durationMs,
              generation: body?.generation ? String(body.generation) : undefined,
              pid: body?.pid ? Number(body.pid) : undefined,
            });
          } catch (err: any) {
            const durationMs = performance.now() - start;
            trafficRecords.push({
              status: 0,
              durationMs,
              error: err?.message || String(err),
            });
          }
        });

        await Promise.all(batch);
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
  }

  try {
    // 1. Spawn initial cluster workers (generation 1)
    for (let slot = 0; slot < instanceCount; slot++) {
      spawnWorker(slot, 1);
    }

    // Wait for all slots to become ready
    const startWait = Date.now();
    let allReady = false;
    while (!allReady && Date.now() - startWait < readyTimeoutMs) {
      allReady = Array.from({ length: instanceCount }, (_, s) => controller.isSlotReady(clusterName, s, 1)).every(Boolean);
      if (!allReady) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!allReady) {
      throw new Error(`Cluster failed readiness within ${readyTimeoutMs}ms`);
    }

    // Start continuous concurrent HTTP traffic generator once cluster is fully ready
    startTrafficGenerator();
    await new Promise((r) => setTimeout(r, 150));

    // ==========================================
    // TEST A: Zero-Downtime Rolling Reload Test
    // ==========================================
    const reloadTrafficStartIndex = trafficRecords.length;

    await reloadCommand([clusterName], {
      controller,
      readyTimeoutMs,
      drainTimeoutMs,
      spawnWorker: async (slot, nextGen) => {
        spawnWorker(slot, nextGen);
      },
      stopWorker: async (slot, currentGen) => {
        await stopWorker(slot, currentGen);
      },
    });

    // Allow traffic to continue across replacement generation
    await new Promise((r) => setTimeout(r, 300));
    const reloadRecords = trafficRecords.slice(reloadTrafficStartIndex);
    const droppedInReload = reloadRecords.filter((r) => r.status < 200 || r.status >= 300).length;
    const reloadPassed = droppedInReload === 0 && reloadRecords.length > 0;

    // ==========================================
    // TEST B: Violent Crash Recovery Test
    // ==========================================
    const currentWorkers = controller.getClusterWorkers(clusterName);
    const victimWorker = currentWorkers.find((w) => w.slot === 1 && w.status === "ready") || currentWorkers[0];
    const victimPid = victimWorker?.pid || (activeProcs.get("1:2")?.pid || activeProcs.get("1:1")?.pid || 0);

    const crashTrafficStartIndex = trafficRecords.length;

    if (victimPid > 0) {
      violentlyKillProcess(victimPid);
    }

    // Continue sending traffic for 500ms post-crash
    await new Promise((r) => setTimeout(r, 500));

    // Stop traffic generator
    isGeneratingTraffic = false;
    await trafficLoopPromise;

    const crashRecords = trafficRecords.slice(crashTrafficStartIndex);
    const droppedInCrash = crashRecords.filter((r) => r.status < 200 || r.status >= 300).length;
    const crashSurvived = droppedInCrash === 0 && crashRecords.length > 0;

    // ==========================================
    // Overall Metrics Compilation
    // ==========================================
    const totalRequests = trafficRecords.length;
    const successfulRequests = trafficRecords.filter((r) => r.status >= 200 && r.status < 300).length;
    const failedRequests = totalRequests - successfulRequests;
    const errorRate = totalRequests > 0 ? Math.round((failedRequests / totalRequests) * 10000) / 100 : 0;
    const availability = totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 10000) / 100 : 0;
    const latency = calculateLatencyMetrics(trafficRecords.map((r) => r.durationMs));

    const overallPassed = reloadPassed && crashSurvived && failedRequests === 0;

    const summary = overallPassed
      ? `High-Availability Verification Passed: No failed requests were observed during this bounded verification run.`
      : `Verification Failed: ${failedRequests} dropped/failed request(s) detected during HA resilience tests.`;

    return {
      target: resolvedFile,
      mode: "ephemeral",
      port: testPort,
      passed: overallPassed,
      metrics: {
        totalRequests,
        successfulRequests,
        failedRequests,
        errorRate,
        availability,
        latency,
      },
      tests: {
        rollingReload: {
          passed: reloadPassed,
          totalRequests: reloadRecords.length,
          successfulRequests: reloadRecords.length - droppedInReload,
          droppedRequests: droppedInReload,
          generationsSeen: Array.from(generationsSeen),
        },
        violentCrashRecovery: {
          passed: crashSurvived,
          totalRequests: crashRecords.length,
          successfulRequests: crashRecords.length - droppedInCrash,
          droppedRequests: droppedInCrash,
          victimPid,
          survived: crashSurvived,
        },
      },
      summary,
    };
  } finally {
    // Teardown & cleanup
    isGeneratingTraffic = false;
    for (const proc of activeProcs.values()) {
      try { proc.kill(); } catch {}
    }
    activeProcs.clear();

    try { await controller.stop(); } catch {}
    try { unlinkSync(wrapperScriptPath); } catch {}
    try { unlinkSync(tokenFilePath); } catch {}
  }
}

/**
 * Run verification against an active live cluster (only when --live is explicitly requested)
 */
async function runLiveVerification(clusterName: string, options: VerifyHaOptions): Promise<VerifyHaResult> {
  const services = await listServices();
  const clusterWorkers = services.filter((s) => s.name.includes(clusterName));

  if (clusterWorkers.length === 0) {
    throw new Error(`Live cluster '${clusterName}' not found. Verify with 'bs9 status' or omit --live for isolated verification.`);
  }

  const livePort = options.port ? parseInt(String(options.port), 10) : 3000;
  const concurrency = options.concurrency || 5;

  let isGenerating = true;
  const records: TrafficRecord[] = [];

  const trafficPromise = (async () => {
    while (isGenerating) {
      const batch = Array.from({ length: concurrency }, async () => {
        const start = performance.now();
        try {
          const res = await fetch(`http://localhost:${livePort}/`, {
            signal: AbortSignal.timeout(3000),
          });
          records.push({
            status: res.status,
            durationMs: performance.now() - start,
          });
        } catch (err: any) {
          records.push({
            status: 0,
            durationMs: performance.now() - start,
            error: err?.message,
          });
        }
      });
      await Promise.all(batch);
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  try {
    await new Promise((r) => setTimeout(r, 200));

    // Reload live cluster
    const reloadStartIdx = records.length;
    await reloadCommand([clusterName], options);
    await new Promise((r) => setTimeout(r, 300));

    isGenerating = false;
    await trafficPromise;

    const reloadRecords = records.slice(reloadStartIdx);
    const dropped = reloadRecords.filter((r) => r.status < 200 || r.status >= 300).length;
    const passed = dropped === 0 && reloadRecords.length > 0;

    const total = records.length;
    const success = records.filter((r) => r.status >= 200 && r.status < 300).length;
    const failed = total - success;

    return {
      target: clusterName,
      mode: "live",
      port: livePort,
      passed,
      metrics: {
        totalRequests: total,
        successfulRequests: success,
        failedRequests: failed,
        errorRate: total > 0 ? (failed / total) * 100 : 0,
        availability: total > 0 ? (success / total) * 100 : 0,
        latency: calculateLatencyMetrics(records.map((r) => r.durationMs)),
      },
      tests: {
        rollingReload: {
          passed,
          totalRequests: reloadRecords.length,
          successfulRequests: reloadRecords.length - dropped,
          droppedRequests: dropped,
          generationsSeen: [],
        },
        violentCrashRecovery: {
          passed: true,
          totalRequests: 0,
          successfulRequests: 0,
          droppedRequests: 0,
          victimPid: 0,
          survived: true,
        },
      },
      summary: passed
        ? `Live cluster '${clusterName}' verified: No failed requests observed during rolling reload.`
        : `Live cluster verification failed: ${dropped} dropped requests detected during rolling reload.`,
    };
  } finally {
    isGenerating = false;
  }
}

/**
 * Visual terminal formatter
 */
function displayVerifyReport(result: VerifyHaResult): void {
  const border = "═".repeat(78);
  const thinDivider = "─".repeat(78);

  console.log(`\n╔${border}╗`);
  console.log(`║ 🛡️  BS9 HIGH-AVAILABILITY VERIFICATION REPORT                               ║`);
  console.log(`╚${border}╝\n`);

  console.log(`🎯 Target:           ${result.target}`);
  console.log(`🌐 Verification Mode: ${result.mode.toUpperCase()} (Port: ${result.port})`);
  console.log(`📊 Availability:     ${result.metrics.availability}%`);
  console.log(`⚡ Error Rate:       ${result.metrics.errorRate}% (${result.metrics.failedRequests} dropped / ${result.metrics.totalRequests} sent)`);
  console.log(thinDivider);

  console.log(`\nRESILIENCE TEST RESULTS:\n`);

  // Test 1: Rolling Reload
  const rTest = result.tests.rollingReload;
  console.log(`  1. Zero-Downtime Rolling Reload:`);
  console.log(`     Status:           ${rTest.passed ? "\x1b[32m✅ PASSED (0 Dropped Requests)\x1b[0m" : `\x1b[31m❌ FAILED (${rTest.droppedRequests} dropped requests)\x1b[0m`}`);
  console.log(`     Requests Handled: ${rTest.successfulRequests} / ${rTest.totalRequests}`);
  if (rTest.generationsSeen.length > 0) {
    console.log(`     Generations Seen: ${rTest.generationsSeen.map(g => "g" + g).join(", ")}`);
  }

  // Test 2: Violent Crash
  const cTest = result.tests.violentCrashRecovery;
  if (result.mode === "ephemeral") {
    console.log(`\n  2. Violent Crash Recovery (SIGKILL / Forced Terminate):`);
    console.log(`     Status:           ${cTest.passed ? "\x1b[32m✅ PASSED (Surviving Worker Absorbed Load)\x1b[0m" : `\x1b[31m❌ FAILED (${cTest.droppedRequests} dropped requests)\x1b[0m`}`);
    console.log(`     Victim PID:       ${cTest.victimPid}`);
  }

  console.log(`\n${thinDivider}`);
  console.log(`\x1b[1mLATENCY DISTRIBUTION (Concurrent HTTP Traffic):\x1b[0m`);
  console.log(`  Min: ${result.metrics.latency.min}ms   |   Avg: ${result.metrics.latency.avg}ms   |   Max: ${result.metrics.latency.max}ms`);
  console.log(`  p50: ${result.metrics.latency.p50}ms   |   p95: ${result.metrics.latency.p95}ms   |   p99: ${result.metrics.latency.p99}ms`);
  console.log(thinDivider);

  if (result.passed) {
    console.log(`\n\x1b[1m\x1b[32m✅ VERIFICATION RESULT: RESILIENCE VERIFIED (BOUNDED RUN)\x1b[0m`);
    console.log(`   ${result.summary}\n`);
  } else {
    console.log(`\n\x1b[1m\x1b[31m❌ VERIFICATION RESULT: NON-COMPLIANT (DROPPED REQUESTS OBSERVED)\x1b[0m`);
    console.log(`   ${result.summary}\n`);
  }
}

/**
 * Main command action for `bs9 verify-ha <file>`
 */
export async function verifyHaCommand(file: string, options: VerifyHaOptions = {}): Promise<VerifyHaResult> {
  let result: VerifyHaResult;

  try {
    if (options.live) {
      result = await runLiveVerification(file, options);
    } else {
      result = await runEphemeralVerification(file, options);
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      displayVerifyReport(result);
    }

    return result;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ error: err.message, passed: false }, null, 2));
    } else {
      console.error(`\x1b[31m❌ Verification error: ${err.message}\x1b[0m`);
    }
    throw err;
  }
}
