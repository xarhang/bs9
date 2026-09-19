#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(tmpdir(), `bs9-packaged-qualification-${process.pid}-${Date.now()}`);
const installDir = join(root, "install");
const bs9Home = join(root, "home");
mkdirSync(installDir, { recursive: true });
mkdirSync(bs9Home, { recursive: true });

function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run("npm", ["pack", "--pack-destination", root]);
  const tarball = readdirSync(root).find(name => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not create a tarball");

  run("bun", ["init", "-y"], { cwd: installDir });
  run("bun", ["add", join(root, tarball)], { cwd: installDir });

  const packageBin = resolve(installDir, "node_modules", "bs9", "bin", "bs9");
  if (!existsSync(packageBin)) throw new Error(`Packaged bin entry is missing: ${packageBin}`);

  run(process.execPath, [packageBin, "-V"], { cwd: installDir, env: { BS9_HOME: bs9Home } });
  run(process.execPath, [packageBin, "--help"], { cwd: installDir, env: { BS9_HOME: bs9Home } });
  run(process.execPath, [packageBin, "doctor"], { cwd: installDir, env: { BS9_HOME: bs9Home } });

  run("bun", ["test", "tests/e2e-native-ha-load.test.ts"], {
    env: {
      BS9_NATIVE_HA_E2E: "1",
      BS9_WINDOWS_BACKGROUND: "1",
      BS9_HOME: bs9Home,
      BS9_TEST_BIN_PATH: packageBin,
      BS9_HA_CONCURRENCY: process.env.BS9_HA_CONCURRENCY || "25",
      BS9_HA_SOAK_SECONDS: process.env.BS9_HA_SOAK_SECONDS || "10",
    },
  });
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
