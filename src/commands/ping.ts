#!/usr/bin/env bun

/**
 * BS9 - Ping Daemon Healthcheck Command
 * Verifies that the BS9 runtime and process managers are active and responsive.
 * Mirrors `pm2 ping`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { listServices } from "../utils/service-discovery.js";
import { getPlatformInfo } from "../platform/detect.js";
import { ControllerAdminClient } from "../cluster/admin-client.js";

export async function pingCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  try {
    const services = await listServices();
    const activeCount = services.filter(s => s.active === "active" || s.sub === "running").length;

    console.log(`pong`);
    console.log(`BS9 is alive and operational on ${platformInfo.platform} (${platformInfo.serviceManager})`);
    console.log(`Managed services: ${services.length} registered (${activeCount} active)`);

    // Query persistent BS9 Daemon status
    const adminClient = new ControllerAdminClient();
    const connected = await adminClient.connect();
    if (connected) {
      try {
        const report = await adminClient.ping();
        console.log(`\n🩺 BS9 Daemon Health:`);
        console.log(`   Controller: ${report.controller.listening ? "listening" : "stopped"} (${report.controller.connectedWorkersCount} connected workers)`);
        console.log(`   State Hub:  ${report.hub.listening ? "listening" : "stopped"} (${report.hub.namespacesCount} namespaces, ${report.hub.walRecordsCount} WAL records)`);
        console.log(`   WAL Status: ${report.hub.walRecovered ? "recovered" : "recovering"}`);
        console.log(`   Reconciler: ${report.reconciler.active ? "active" : "idle"} (${report.reconciler.managedClustersCount} clusters managed, locked: [${report.reconciler.lockedClusters.join(", ") || "none"}])`);
      } catch (e) {
        console.log(`\n⚠️  BS9 Daemon ping query error: ${e}`);
      } finally {
        adminClient.disconnect();
      }
    } else {
      console.log(`\nℹ️  BS9 Daemon: offline / not running`);
    }
  } catch (err) {
    console.error(`❌ BS9 ping failed: ${err}`);
    process.exit(1);
  }
}
