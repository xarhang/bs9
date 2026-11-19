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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { gzipSync } from "node:zlib";

export const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_LOG_FILES = 5;

const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

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

function writeFileNoFollow(filePath: string, data: Buffer): void {
  if (existsSync(filePath)) {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${filePath}`);
    }
  }
  const fd = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
    0o600
  );
  try {
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Rotates `logPath` if its size meets or exceeds `maxBytes`.
 * Refuses to operate on symbolic links to prevent symlink-following attacks.
 */
export function rotateLogIfNeeded(logPath: string, options: LogRotationOptions = {}): boolean {
  const maxBytes = typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_LOG_BYTES;
  const maxFiles = typeof options.maxFiles === "number" && Number.isFinite(options.maxFiles) && options.maxFiles >= 1
    ? Math.min(Math.floor(options.maxFiles), 1000)
    : DEFAULT_MAX_LOG_FILES;
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
        if (lstatSync(candidate).isSymbolicLink()) {
          // Remove attacker-placed symlinks at archive slots instead of leaving them
          unlinkSync(candidate);
          continue;
        }
      } catch {
        continue;
      }
      if (idx >= maxFiles) {
        try { unlinkSync(candidate); } catch {}
      } else {
        const nextPath = `${logPath}.${idx + 1}${ext}`;
        try {
          if (existsSync(nextPath) && lstatSync(nextPath).isSymbolicLink()) {
            unlinkSync(nextPath);
          }
          renameSync(candidate, nextPath);
        } catch {}
      }
    }
  }

  const rotatedRaw = `${logPath}.1`;
  // Prefer atomic rename first so concurrent appends to the path aren't lost
  let renamed = false;
  try {
    if (existsSync(rotatedRaw) && lstatSync(rotatedRaw).isSymbolicLink()) {
      unlinkSync(rotatedRaw);
    }
    renameSync(logPath, rotatedRaw);
    renamed = true;
  } catch {
    renamed = false;
  }

  if (renamed) {
    try {
      writeFileNoFollow(logPath, Buffer.alloc(0));
      if (compress) {
        const content = readFileSync(rotatedRaw);
        const compressed = gzipSync(content);
        writeFileNoFollow(`${rotatedRaw}.gz`, compressed);
        try { unlinkSync(rotatedRaw); } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  // Fallback for platforms/filesystems where renaming an open file fails (e.g. Windows EBUSY)
  let fd: number | undefined;
  try {
    fd = openSync(logPath, constants.O_RDWR | O_NOFOLLOW);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      return false;
    }
    const content = readFileSync(fd);
    if (compress) {
      const compressed = gzipSync(content);
      writeFileNoFollow(`${rotatedRaw}.gz`, compressed);
    } else {
      writeFileNoFollow(rotatedRaw, content);
    }
    ftruncateSync(fd, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}
