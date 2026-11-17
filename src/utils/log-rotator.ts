/**
 * BS9 - Lightweight Built-in Log Rotator
 *
 * Rotates oversized service and daemon logs with optional gzip compression
 * and strict symlink/containment safety.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";

export const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_LOG_FILES = 5;

export interface LogRotationOptions {
  maxBytes?: number;
  maxFiles?: number;
  compress?: boolean;
}

export function parseLogSizeBytes(value?: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_LOG_BYTES;
  }
  if (!value || typeof value !== "string") {
    return DEFAULT_MAX_LOG_BYTES;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?B?)$/i);
  if (!match) return DEFAULT_MAX_LOG_BYTES;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_LOG_BYTES;
  const unit = (match[2] || "B").toUpperCase();
  if (unit.startsWith("G")) return Math.round(num * 1024 * 1024 * 1024);
  if (unit.startsWith("M")) return Math.round(num * 1024 * 1024);
  if (unit.startsWith("K")) return Math.round(num * 1024);
  return Math.round(num);
}

/**
 * Rotates `logPath` if its size meets or exceeds `maxBytes`.
 * Refuses to operate on symbolic links to prevent symlink-following attacks.
 */
export function rotateLogIfNeeded(logPath: string, options: LogRotationOptions = {}): boolean {
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_LOG_BYTES;
  const maxFiles = options.maxFiles !== undefined && options.maxFiles >= 1 ? Math.floor(options.maxFiles) : DEFAULT_MAX_LOG_FILES;
  const compress = options.compress !== false;

  if (!existsSync(logPath)) return false;

  let stat;
  try {
    stat = lstatSync(logPath);
  } catch {
    return false;
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return false;
  }

  if (stat.size < maxBytes) {
    return false;
  }

  // Shift existing archives from oldest to newest
  for (let idx = maxFiles; idx >= 1; idx--) {
    for (const ext of ["", ".gz"]) {
      const candidate = `${logPath}.${idx}${ext}`;
      if (!existsSync(candidate)) continue;
      try {
        if (lstatSync(candidate).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (idx >= maxFiles) {
        try { unlinkSync(candidate); } catch {}
      } else {
        const nextPath = `${logPath}.${idx + 1}${ext}`;
        try { renameSync(candidate, nextPath); } catch {}
      }
    }
  }

  const rotatedRaw = `${logPath}.1`;
  try {
    const content = readFileSync(logPath);
    if (compress) {
      const compressed = gzipSync(content);
      writeFileSync(`${rotatedRaw}.gz`, compressed, { mode: 0o600 });
    } else {
      writeFileSync(rotatedRaw, content, { mode: 0o600 });
    }
    truncateSync(logPath, 0);
    return true;
  } catch {
    return false;
  }
}
