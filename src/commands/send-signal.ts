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

// Security: Allowed signals list
const ALLOWED_SIGNALS = new Set([
  "SIGINT", "SIGTERM", "SIGKILL", "SIGUSR1", "SIGUSR2",
  "SIGHUP", "SIGQUIT", "SIGCONT", "SIGSTOP", "SIGABRT",
  "SIGALRM", "SIGPIPE", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGWINCH"
]);

function isValidServiceName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function sendSignalCommand(signal: string, appName: string): Promise<void> {
  if (!signal || !appName) {
    console.error("❌ Usage: bs9 sendSignal <signal> <app-name>");
    console.error("   Example: bs9 sendSignal SIGUSR2 my-app");
    console.error("   Example: bs9 sendSignal SIGTERM api-0");
    process.exit(1);
  }

  const cleanName = appName.replace(/^(BS9_|bs9\.)/, "");
  if (!isValidServiceName(cleanName)) {
    console.error(`❌ Security: Invalid service name: '${appName}'. Only alphanumeric, '.', '_', '-' allowed.`);
    process.exit(1);
  }

  // Validate signal
  const trimmedSignal = signal.trim();
  const isNumeric = /^\d+$/.test(trimmedSignal);
  let validatedSignal: number | NodeJS.Signals;

  if (isNumeric) {
    const sigNum = parseInt(trimmedSignal, 10);
    if (sigNum < 1 || sigNum > 31) {
      console.error(`❌ Security: Invalid signal number: ${sigNum}. Must be 1-31.`);
      process.exit(1);
    }
    validatedSignal = sigNum;
  } else {
    const upper = trimmedSignal.toUpperCase();
    const formatted = upper.startsWith("SIG") ? upper : `SIG${upper}`;
    if (!ALLOWED_SIGNALS.has(formatted)) {
      console.error(`❌ Security: Signal '${signal}' is not in the allowed signals list.`);
      process.exit(1);
    }
    validatedSignal = formatted as NodeJS.Signals;
  }

  const allServices = await listServices();

  const matched = allServices.filter(s => {
    const clean = s.name.replace(/^(BS9_|bs9\.)/, "");
    const isWorker = clean.startsWith(`${cleanName}-`) && /^\d+$/.test(clean.slice(cleanName.length + 1));
    return clean === cleanName || isWorker;
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
      process.kill(pid, validatedSignal);
      console.log(`📡 Signal ${validatedSignal} sent to '${svc.name}' (PID: ${pid})`);
      signaledCount++;
    } catch (err: any) {
      console.error(`❌ Failed to send ${signal} to '${svc.name}' (PID: ${pid}): ${err.message}`);
    }
  }

  console.log(`✅ Sent signal '${signal}' to ${signaledCount} process(es)`);
}
