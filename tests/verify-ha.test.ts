import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { verifyHaCommand } from "../src/commands/verify-ha.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";

describe("Milestone 7: bs9 verify-ha Zero-Downtime & Violent Crash Verification", () => {
  const tempFiles: string[] = [];
  let testAppPath: string;

  beforeAll(() => {
    testAppPath = join(tmpdir(), `bs9-test-verify-app-${Date.now()}.ts`);
    writeFileSync(
      testAppPath,
      `
      const port = parseInt(process.env.PORT || "3000", 10);
      Bun.serve({
        port,
        reusePort: true,
        async fetch(req) {
          // Micro-delay to simulate async endpoint I/O
          await new Promise((r) => setTimeout(r, 2));
          return new Response(JSON.stringify({
            status: "ok",
            pid: process.pid,
            slot: process.env.NODE_APP_INSTANCE,
            generation: process.env.BS9_CLUSTER_GENERATION,
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      });
    `,
      "utf-8"
    );
    tempFiles.push(testAppPath);
  });

  afterAll(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
    tempFiles.length = 0;
  });

  test("should perform isolated ephemeral verification achieving 100% availability across reload & crash", async () => {
    const result = await verifyHaCommand(testAppPath, {
      instances: 2,
      concurrency: 5,
      readyTimeoutMs: 15000,
      drainTimeoutMs: 5000,
    });

    // Verify overall result
    expect(result.mode).toBe("ephemeral");
    expect(result.passed).toBe(true);
    expect(result.metrics.availability).toBe(100);
    expect(result.metrics.errorRate).toBe(0);
    expect(result.metrics.failedRequests).toBe(0);
    expect(result.metrics.successfulRequests).toBeGreaterThanOrEqual(20);
    expect(result.metrics.totalRequests).toBe(result.metrics.successfulRequests);

    // Verify latency metrics
    expect(result.metrics.latency.min).toBeGreaterThanOrEqual(0);
    expect(result.metrics.latency.max).toBeGreaterThan(0);
    expect(result.metrics.latency.p95).toBeGreaterThan(0);
    expect(result.metrics.latency.p99).toBeGreaterThan(0);

    // Verify Test A: Rolling reload
    expect(result.tests.rollingReload.passed).toBe(true);
    expect(result.tests.rollingReload.droppedRequests).toBe(0);
    expect(result.tests.rollingReload.successfulRequests).toBeGreaterThan(0);
    expect(result.tests.rollingReload.generationsSeen).toContain("1");
    expect(result.tests.rollingReload.generationsSeen).toContain("2");

    // Verify Test B: Violent crash recovery
    expect(result.tests.violentCrashRecovery.passed).toBe(true);
    expect(result.tests.violentCrashRecovery.droppedRequests).toBe(0);
    expect(result.tests.violentCrashRecovery.survived).toBe(true);
    expect(result.tests.violentCrashRecovery.victimPid).toBeGreaterThan(0);
  }, 35000);

  test("should support --json output format with complete metrics schema", async () => {
    const result = await verifyHaCommand(testAppPath, {
      instances: 2,
      concurrency: 3,
      json: true,
      readyTimeoutMs: 15000,
      drainTimeoutMs: 5000,
    });

    expect(result).toBeDefined();
    expect(result.target).toBe(testAppPath);
    expect(typeof result.passed).toBe("boolean");
    expect(result.metrics).toHaveProperty("totalRequests");
    expect(result.metrics).toHaveProperty("availability");
    expect(result.metrics).toHaveProperty("errorRate");
    expect(result.metrics).toHaveProperty("latency");
    expect(result.tests).toHaveProperty("rollingReload");
    expect(result.tests).toHaveProperty("violentCrashRecovery");
  }, 35000);

  test("should safely reject non-existent live clusters when --live flag is passed", async () => {
    await expect(
      verifyHaCommand("non-existent-cluster-xyz-123", {
        live: true,
      })
    ).rejects.toThrow("not found");
  });
});
