#!/usr/bin/env node

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export function injectOpenTelemetry(entryFile: string, serviceName: string): void {
  const { lstatSync } = require("node:fs") as typeof import("node:fs");
  if (lstatSync(entryFile).isSymbolicLink()) {
    throw new Error(`Security: Refusing to modify symbolic link '${entryFile}'`);
  }
  const originalContent = readFileSync(entryFile, "utf-8");
  if (originalContent.includes("// BSN OpenTelemetry Auto-injection")) {
    return;
  }

  const wrapper = `
// BSN OpenTelemetry Auto-injection
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: ${JSON.stringify(serviceName)},
    [SemanticResourceAttributes.SERVICE_VERSION]: "1.0.0",
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

// Original user code below
`;

  let newContent: string;
  if (originalContent.startsWith("#!")) {
    const firstNewline = originalContent.indexOf("\n");
    if (firstNewline !== -1) {
      newContent = originalContent.slice(0, firstNewline + 1) + wrapper + originalContent.slice(firstNewline + 1);
    } else {
      newContent = originalContent + "\n" + wrapper;
    }
  } else {
    newContent = wrapper + originalContent;
  }
  
  writeFileSync(entryFile, newContent, { encoding: "utf-8" });
}

export function injectPrometheus(entryFile: string, port: string): void {
  const prometheusInject = `
// BSN Prometheus Auto-injection
import promClient from "prom-client";

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpRequestTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

// Export for use in user code
globalThis.prometheus = { register, httpRequestDuration, httpRequestTotal };
`;

  // This would need to be injected at the right place in the user's code
  // For now, we'll write it to a temporary file that the user can import
  const metricsFile = join(dirname(entryFile), "bsn-metrics.js");
  const { lstatSync } = require("node:fs") as typeof import("node:fs");
  try {
    if (lstatSync(metricsFile).isSymbolicLink()) {
      throw new Error(`Security: Refusing to write through symbolic link '${metricsFile}'`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  writeFileSync(metricsFile, prometheusInject, { encoding: "utf-8" });
  
  console.log(`📊 Prometheus metrics written to: ${metricsFile}`);
  console.log(`   Add to your app: import "./bsn-metrics.js"`);
}
