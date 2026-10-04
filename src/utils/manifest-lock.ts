import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 25;

interface ManifestLockOwner {
  host: string;
  pid: number;
  acquiredAt: string;
  token: string;
}

/**
 * Serializes manifest read/modify/write and delete transactions across BS9
 * processes. The lock is deliberately fail-closed: after an owner crash the
 * stale lock is left in place for an operator to inspect and remove, rather
 * than risking deletion of a newly acquired lock and allowing concurrent
 * writers to corrupt desired state.
 */
export function acquireManifestLock(manifestPath: string, timeoutMs = LOCK_TIMEOUT_MS): () => void {
  const lockPath = `${manifestPath}.lock`;
  const owner: ManifestLockOwner = {
    host: hostname(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(owner), { encoding: "utf-8" });
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
        fd = undefined;
        try { unlinkSync(lockPath); } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        let currentOwner = "owner metadata unavailable";
        try {
          const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<ManifestLockOwner>;
          if (Number.isInteger(parsed.pid) && typeof parsed.host === "string") {
            currentOwner = `PID ${parsed.pid} on ${parsed.host}`;
          }
        } catch {}
        throw new Error(`Timed out waiting for manifest lock ${lockPath} held by ${currentOwner}. If the owner process is no longer running, inspect and remove the stale lock before retrying.`);
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, RETRY_DELAY_MS);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd); } finally {
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<ManifestLockOwner>;
        if (current.token === owner.token) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
}

export function withManifestLock<T>(manifestPath: string, operation: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const release = acquireManifestLock(manifestPath, timeoutMs);
  try {
    return operation();
  } finally {
    release();
  }
}

export function removeManifestIfPresent(manifestPath: string): boolean {
  return withManifestLock(manifestPath, () => {
    if (!existsSync(manifestPath)) return false;
    unlinkSync(manifestPath);
    return true;
  });
}
