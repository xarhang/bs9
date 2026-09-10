#!/usr/bin/env bun

/**
 * BS9 - Ping Daemon Healthcheck Command
 * Verifies that the BS9 runtime and process managers are active and responsive.
 * Mirrors `pm2 ping`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { listServices } from "../utils/service-discovery.js";
import { getPlatformInfo } from "../platform/detect.js";

export async function pingCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  try {
    const services = await listServices();
    const activeCount = services.filter(s => s.active === "active" || s.sub === "running").length;

    console.log(`pong`);
    console.log(`BS9 is alive and operational on ${platformInfo.platform} (${platformInfo.serviceManager})`);
    console.log(`Managed services: ${services.length} registered (${activeCount} active)`);
  } catch (err) {
    console.error(`❌ BS9 ping failed: ${err}`);
    process.exit(1);
  }
}
