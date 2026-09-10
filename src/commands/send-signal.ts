#!/usr/bin/env bun

/**
 * BS9 - Send Signal Command
 * Sends an OS signal (SIGINT, SIGTERM, SIGKILL, SIGUSR1, SIGUSR2, etc.) to a service process.
 * Mirrors `pm2 sendSignal <signal> <app>`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { listServices } from "../utils/service-discovery.js";

export async function sendSignalCommand(signal: string, appName: string): Promise<void> {
  if (!signal || !appName) {
    console.error("❌ Usage: bs9 sendSignal <signal> <app-name>");
    console.error("   Example: bs9 sendSignal SIGUSR2 my-app");
    console.error("   Example: bs9 sendSignal SIGTERM api-0");
    process.exit(1);
  }

  const cleanName = appName.replace(/^(BS9_|bs9\.)/, "");
  const allServices = await listServices();

  const matched = allServices.filter(s => {
    const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
    return clean === cleanName || clean.startsWith(`${cleanName}-`);
  });

  if (matched.length === 0) {
    console.error(`❌ No running services found matching '${appName}'`);
    process.exit(1);
  }

  let signaledCount = 0;

  for (const svc of matched) {
    const pid = svc.pid && svc.pid !== "-" ? parseInt(svc.pid, 10) : null;
    if (!pid || isNaN(pid)) {
      console.warn(`⚠️  Service '${svc.name}' is not currently running or has no valid PID`);
      continue;
    }

    try {
      // Normalize signal format: e.g. "SIGTERM" or "15"
      const formattedSig = signal.toUpperCase().startsWith("SIG") ? signal.toUpperCase() : `SIG${signal.toUpperCase()}`;
      process.kill(pid, formattedSig as NodeJS.Signals);
      console.log(`📡 Signal ${formattedSig} sent to '${svc.name}' (PID: ${pid})`);
      signaledCount++;
    } catch (err: any) {
      console.error(`❌ Failed to send ${signal} to '${svc.name}' (PID: ${pid}): ${err.message}`);
    }
  }

  console.log(`✅ Sent signal '${signal}' to ${signaledCount} process(es)`);
}
