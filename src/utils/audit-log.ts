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

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory } from "./private-files.js";
import { rotateLogIfNeeded } from "./log-rotator.js";

const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const MAX_AUDIT_READ_BYTES = 512 * 1024; // 512 KB bounded tail read

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

function sanitizeAuditStatus(status: unknown): AuditEvent["status"] {
  if (status === "success" || status === "failure" || status === "denied") {
    return status;
  }
  return "failure";
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
  let fd: number | undefined;
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
      status: sanitizeAuditStatus(event.status),
      ...(event.actor ? { actor: sanitizeAuditField(event.actor, 64) } : {}),
      ...(event.details ? { details: sanitizeAuditField(event.details, 256) } : {}),
    };

    const payload = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    fd = openSync(
      auditPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW,
      0o600
    );
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      return false;
    }
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function readAuditEvents(
  limit = 100,
  auditPath: string = getAuditLogPath()
): AuditEvent[] {
  if (!existsSync(auditPath)) return [];
  let fd: number | undefined;
  try {
    const st = lstatSync(auditPath);
    if (st.isSymbolicLink() || !st.isFile()) return [];

    fd = openSync(auditPath, constants.O_RDONLY | O_NOFOLLOW);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size === 0) return [];

    const readBytes = Math.min(fdStat.size, MAX_AUDIT_READ_BYTES);
    const startOffset = fdStat.size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    let totalRead = 0;
    while (totalRead < readBytes) {
      const n = readSync(fd, buf, totalRead, readBytes - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }

    let raw = buf.subarray(0, totalRead).toString("utf8");
    if (startOffset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }

    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100;
    const tail = lines.slice(-safeLimit);
    const events: AuditEvent[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {}
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}
