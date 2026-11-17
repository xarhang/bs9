/**
 * BS9 - Tamper-Safe Security & Lifecycle Audit Log
 *
 * Records critical lifecycle and authentication events in JSONL format with
 * symlink refusal, private file permissions (0o600), log-injection sanitization,
 * and automatic size-based rotation.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory } from "./private-files.js";
import { rotateLogIfNeeded } from "./log-rotator.js";

export interface AuditEvent {
  timestamp: string;
  action: string;
  target: string;
  status: "success" | "failure" | "denied";
  actor?: string;
  details?: string;
}

function sanitizeAuditField(val: unknown, maxLen = 128): string {
  return String(val ?? "")
    .replace(/[\r\n\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function getAuditLogPath(): string {
  if (process.env.BS9_AUDIT_LOG) {
    return process.env.BS9_AUDIT_LOG;
  }
  return join(getPlatformInfo().configDir, "audit.log");
}

export function recordAuditEvent(
  event: Omit<AuditEvent, "timestamp">,
  auditPath: string = getAuditLogPath()
): boolean {
  try {
    const dir = dirname(auditPath);
    if (process.platform === "linux" || process.platform === "darwin") {
      ensurePrivateDirectory(dir);
    } else {
      mkdirSync(dir, { recursive: true });
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        return false;
      }
    }

    if (existsSync(auditPath)) {
      const st = lstatSync(auditPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        return false;
      }
    }

    rotateLogIfNeeded(auditPath, { maxBytes: 10 * 1024 * 1024, maxFiles: 5 });

    const entry: AuditEvent = {
      timestamp: new Date().toISOString(),
      action: sanitizeAuditField(event.action, 64),
      target: sanitizeAuditField(event.target, 128),
      status: event.status,
      ...(event.actor ? { actor: sanitizeAuditField(event.actor, 64) } : {}),
      ...(event.details ? { details: sanitizeAuditField(event.details, 256) } : {}),
    };

    appendFileSync(auditPath, JSON.stringify(entry) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function readAuditEvents(
  limit = 100,
  auditPath: string = getAuditLogPath()
): AuditEvent[] {
  if (!existsSync(auditPath)) return [];
  try {
    const st = lstatSync(auditPath);
    if (st.isSymbolicLink() || !st.isFile()) return [];
    const raw = readFileSync(auditPath, "utf8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(1000, limit)));
    const events: AuditEvent[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}
