/**
 * BS9 - Grafana Dashboard JSON Generator
 *
 * Generates a ready-to-import Grafana dashboard JSON for monitoring BS9
 * services via Prometheus metrics (CPU, Memory, Restarts, Active Workers, HTTP Latency).
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface GrafanaExportOptions {
  title?: string;
  serviceName?: string;
  datasource?: string;
}

export function generateGrafanaDashboard(options: GrafanaExportOptions = {}): string {
  const title = (options.title || "BS9 Process Manager Overview").slice(0, 120);
  const serviceFilter = options.serviceName
    ? `{service="${options.serviceName.replace(/[^a-zA-Z0-9._-]/g, "")}"}`
    : "";
  const datasource = options.datasource || "Prometheus";

  const dashboard = {
    id: null,
    uid: "bs9-overview",
    title,
    tags: ["bs9", "bun", "process-manager"],
    timezone: "browser",
    schemaVersion: 38,
    version: 1,
    refresh: "10s",
    panels: [
      {
        id: 1,
        type: "stat",
        title: "Active BS9 Workers",
        gridPos: { x: 0, y: 0, w: 6, h: 4 },
        datasource,
        targets: [
          {
            expr: `sum(bs9_service_up${serviceFilter})`,
            legendFormat: "Running",
          },
        ],
      },
      {
        id: 2,
        type: "stat",
        title: "Total Restarts (24h)",
        gridPos: { x: 6, y: 0, w: 6, h: 4 },
        datasource,
        targets: [
          {
            expr: `sum(increase(bs9_service_restarts_total${serviceFilter}[24h]))`,
            legendFormat: "Restarts",
          },
        ],
      },
      {
        id: 3,
        type: "timeseries",
        title: "Memory Usage (MB)",
        gridPos: { x: 0, y: 4, w: 12, h: 8 },
        datasource,
        targets: [
          {
            expr: `bs9_service_memory_bytes${serviceFilter} / 1024 / 1024`,
            legendFormat: "{{service}}",
          },
        ],
      },
      {
        id: 4,
        type: "timeseries",
        title: "CPU Usage (%)",
        gridPos: { x: 12, y: 4, w: 12, h: 8 },
        datasource,
        targets: [
          {
            expr: `rate(bs9_service_cpu_seconds_total${serviceFilter}[1m]) * 100`,
            legendFormat: "{{service}}",
          },
        ],
      },
      {
        id: 5,
        type: "timeseries",
        title: "Event Loop Lag (ms)",
        gridPos: { x: 0, y: 12, w: 24, h: 7 },
        datasource,
        targets: [
          {
            expr: `bs9_event_loop_lag_ms${serviceFilter}`,
            legendFormat: "{{service}} p99",
          },
        ],
      },
    ],
  };

  return JSON.stringify(dashboard, null, 2);
}
