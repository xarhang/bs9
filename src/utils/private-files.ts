import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Restricts a POSIX application-owned directory and repairs an existing
 * directory left with permissions from an older BS9 release.
 */
export function ensurePrivateDirectory(path: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Private-file helpers are only supported on POSIX platforms");
  }

  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`Refusing to use a non-directory or symbolic-link private directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

/** Repairs permissions on existing POSIX files that can contain secrets. */
export function securePrivateFile(path: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Private-file helpers are only supported on POSIX platforms");
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`Refusing to secure a non-file or symbolic-link private file: ${path}`);
  }

  chmodSync(path, 0o600);
}

/**
 * Atomically writes an owner-only POSIX file. A same-directory exclusive temp
 * file keeps both first creation and replacement private across the rename.
 */
export function writePrivateFile(path: string, content: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Private-file helpers are only supported on POSIX platforms");
  }

  const directory = dirname(path);
  ensurePrivateDirectory(directory);

  const tempPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, content, { encoding: "utf-8" });
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }

  try {
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
  securePrivateFile(path);
}
