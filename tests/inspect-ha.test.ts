import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { inspectApplicationHa, inspectHaCommand } from "../src/commands/inspect-ha.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";

describe("Milestone 7: bs9 inspect-ha Diagnostics & Static Analysis", () => {
  const testFiles: string[] = [];

  function createTempFile(name: string, content: string): string {
    const p = join(tmpdir(), `bs9-inspect-test-${Date.now()}-${name}`);
    writeFileSync(p, content, "utf-8");
    testFiles.push(p);
    return p;
  }

  afterAll(() => {
    for (const f of testFiles) {
      try { unlinkSync(f); } catch {}
    }
    testFiles.length = 0;
  });

  test("should classify a purely stateless Bun.serve app as Tier 1 (Fully Stateless / HA Ready)", () => {
    const filePath = createTempFile("stateless-app.ts", `
      export default {
        port: 3000,
        fetch(req: Request) {
          const url = new URL(req.url);
          if (url.pathname === "/health") {
            return new Response("OK");
          }
          return new Response("Hello World");
        }
      };
    `);

    const report = inspectApplicationHa(filePath);
    expect(report.tier).toBe(1);
    expect(report.tierName).toContain("Tier 1");
    expect(report.haReady).toBe(true);
    expect(report.framework).toBe("Bun.serve");
    expect(report.frameworkDetected).toBe(true);
    expect(report.pitfalls.length).toBe(0);
  });

  test("should classify an app using bs9/runtime State/Lease/Queue as Tier 2 (Managed State HA Ready)", () => {
    const filePath = createTempFile("managed-app.ts", `
      import { state, lease, queue } from "bs9/runtime";

      Bun.serve({
        port: 3000,
        async fetch(req: Request) {
          const count = ((await state.get("visits")) as number) || 0;
          await state.set("visits", count + 1);

          const l = await lease.acquire("job-processor", 5000);
          if (l.acquired) {
            await queue.push("jobs", { id: "1" });
            await l.release();
          }

          return new Response(JSON.stringify({ visits: count + 1 }));
        }
      });
    `);

    const report = inspectApplicationHa(filePath);
    expect(report.tier).toBe(2);
    expect(report.tierName).toContain("Tier 2");
    expect(report.haReady).toBe(true);
    expect(report.framework).toBe("Bun.serve");
    expect(report.managedState.usesBs9Runtime).toBe(true);
    expect(report.managedState.features).toContain("State");
    expect(report.managedState.features).toContain("Lease");
    expect(report.managedState.features).toContain("Queue");
    expect(report.pitfalls.length).toBe(0);
  });

  test("should classify an unmanaged in-memory state app as Tier 3 with actionable remediation", () => {
    const filePath = createTempFile("unmanaged-app.ts", `
      // In-memory collections and variables that will reset on worker reload:
      const cache = new Map<string, any>();
      export const activeSessions = new Set<string>();
      let requestCounter = 0;
      var totalLatency = 0;
      const sessionStore = {};

      export default {
        port: 3000,
        fetch(req: Request) {
          requestCounter++;
          cache.set("key", Date.now());
          activeSessions.add("user-1");
          return new Response("OK");
        }
      };
    `);

    const report = inspectApplicationHa(filePath);
    expect(report.tier).toBe(3);
    expect(report.tierName).toContain("Tier 3");
    expect(report.haReady).toBe(false);
    expect(report.pitfalls.length).toBeGreaterThanOrEqual(4);

    // Verify pitfall types detected
    const types = report.pitfalls.map((p) => p.type);
    expect(types).toContain("collection");
    expect(types).toContain("mutable-variable");

    // Verify remediation advice mentions bs9/runtime
    const remediations = report.pitfalls.map((p) => p.remediation).join(" ");
    expect(remediations).toContain("bs9/runtime");
    expect(remediations).toContain("state");
  });

  test("should detect and traverse referenced relative imports across files", () => {
    const helperFile = createTempFile("store.ts", `
      export const inMemoryCache = new Map<string, string>();
      export let globalCounter = 0;
    `);

    const helperRelative = "./" + helperFile.replace(/\\/g, "/").split("/").pop();

    const mainFile = createTempFile("main-server.ts", `
      import { inMemoryCache, globalCounter } from "${helperRelative}";

      Bun.serve({
        fetch(req) {
          return new Response("Served");
        }
      });
    `);

    const report = inspectApplicationHa(mainFile);
    expect(report.tier).toBe(3);
    expect(report.scannedFiles.length).toBe(2);

    const helperPitfalls = report.pitfalls.filter((p) => p.file === helperFile);
    expect(helperPitfalls.length).toBeGreaterThanOrEqual(2);
    expect(helperPitfalls.some((p) => p.name === "inMemoryCache")).toBe(true);
    expect(helperPitfalls.some((p) => p.name === "globalCounter")).toBe(true);
  });

  test("should detect frameworks accurately: Hono, Elysia, Express, Fastify", () => {
    const honoFile = createTempFile("hono-app.ts", `
      import { Hono } from "hono";
      const app = new Hono();
      app.get("/", (c) => c.text("Hono!"));
      export default app;
    `);
    expect(inspectApplicationHa(honoFile).framework).toBe("Hono");

    const elysiaFile = createTempFile("elysia-app.ts", `
      import { Elysia } from "elysia";
      const app = new Elysia().get("/", () => "Elysia!");
    `);
    expect(inspectApplicationHa(elysiaFile).framework).toBe("Elysia");

    const expressFile = createTempFile("express-app.js", `
      const express = require("express");
      const app = express();
      app.get("/", (req, res) => res.send("Express!"));
    `);
    expect(inspectApplicationHa(expressFile).framework).toBe("Express");

    const fastifyFile = createTempFile("fastify-app.js", `
      import Fastify from "fastify";
      const fastify = Fastify();
      fastify.get("/", async (req, reply) => "Fastify!");
    `);
    expect(inspectApplicationHa(fastifyFile).framework).toBe("Fastify");
  });

  test("should support --json option and return valid JSON output without throwing", async () => {
    const file = createTempFile("json-test.ts", `
      export default {
        fetch(req) { return new Response("JSON output test"); }
      };
    `);

    const report = await inspectHaCommand(file, { json: true });
    expect(report).toBeDefined();
    expect(report.tier).toBe(1);
    expect(report.haReady).toBe(true);
  });
});
