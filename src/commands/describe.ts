#!/usr/bin/env bun

/**
 * BS9 - Describe / Show Service Command
 * Displays comprehensive runtime and metadata info for a service, mirroring `pm2 show/describe`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { listServices } from "../utils/service-discovery.js";
import { getPlatformInfo } from "../platform/detect.js";
import { getCrashState, formatCrashState } from "../utils/crash-tracker.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function describeCommand(name: string): Promise<void> {
  if (!name) {
    console.error("❌ Service name required. Usage: bs9 show <name> or bs9 describe <name>");
    process.exit(1);
  }

  const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
  if (!isValidServiceName(cleanName)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }

  const platformInfo = getPlatformInfo();
  const services = await listServices();

  const matched = services.find(
    (s) => s.name === name || s.name === cleanName || s.name === `BS9_${cleanName}` || s.name === `bs9.${cleanName}`
  );

  const crashRecord = getCrashState(name) || getCrashState(cleanName);

  console.log(`\n================================================================================`);
  console.log(`🔍 Describing Service: ${matched ? matched.name : name}`);
  console.log(`================================================================================`);

  // Basic Information
  console.log(`📌 App Name          : ${matched ? matched.name : name}`);
  console.log(`🟢 Status            : ${matched ? `${matched.active}/${matched.sub}` : "not found / stopped"}`);
  console.log(`🆔 PID               : ${matched?.pid || "-"}`);
  console.log(`⏱️  Uptime            : ${matched?.uptime || "-"}`);
  console.log(`💻 CPU Usage         : ${matched?.cpu || "-"}`);
  console.log(`🧠 Memory Usage      : ${matched?.memory || "-"}`);

  // Crash Loop & Self Healing
  if (crashRecord) {
    console.log(`🛡️  Self-Healing      : ${formatCrashState(crashRecord)}`);
    console.log(`💥 Total Crashes     : ${crashRecord.crashes.length} (recent window)`);
    console.log(`🔄 Backoff Delay     : ${crashRecord.backoffMs / 1000}s`);
  }

  // Paths & Logs
  const logPrefix = platformInfo.isWindows ? `BS9_${cleanName}` : platformInfo.isMacOS ? `bs9.${cleanName}` : cleanName;
  const outLog = join(platformInfo.logDir, `${logPrefix}.out.log`);
  const errLog = join(platformInfo.logDir, `${logPrefix}.err.log`);

  console.log(`📄 Out Log           : ${existsSync(outLog) ? outLog : "None"}`);
  console.log(`⚠️  Error Log         : ${existsSync(errLog) ? errLog : "None"}`);

  // Windows Specific Metadata
  if (platformInfo.isWindows) {
    const metaPath = join(homedir(), ".bs9", "services", `BS9_${cleanName}.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        console.log(`📂 Working Dir       : ${meta.workingDir || "-"}`);
        console.log(`⚙️  Script/Executable : ${meta.executable || "-"}`);
        if (meta.arguments) console.log(`🏷️  Arguments         : ${meta.arguments.join(" ")}`);
        if (meta.watchdogPid) console.log(`🐕 Watchdog PID      : ${meta.watchdogPid}`);
        if (meta.environment) {
          console.log(`\n🌐 Environment Variables:`);
          for (const [k, v] of Object.entries(meta.environment)) {
            console.log(`   - ${k}=${v}`);
          }
        }
      } catch {}
    }
  }

  console.log(`================================================================================\n`);
}