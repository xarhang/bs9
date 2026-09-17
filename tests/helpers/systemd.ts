import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * GitHub-hosted Linux runners have the systemctl binary but do not provide a
 * user systemd session. Tests that exercise real user services are only valid
 * when that supervisor is actually reachable.
 */
export function hasUsableUserSystemd(): boolean {
  if (process.platform !== "linux") return true;

  const result = spawnSync("systemctl", ["--user", "show-environment"], {
    stdio: "ignore",
  });

  return result.status === 0;
}

/**
 * Stops the bs9-daemon systemd user unit and removes any unit files or symlinks
 * whose content or target references the given sandbox directory.
 *
 * This ensures that after a test run the persistent unit does not retain
 * environment variables (e.g. BS9_HOME, socket paths) pointing to a sandbox
 * that will be deleted, which would cause the next test's `daemon start` to
 * fail immediately when systemd auto-restarts the stale unit.
 */
export function removeSandboxSystemdLinks(sandboxDir: string): void {
  if (process.platform === "darwin") {
    const launchAgentsDir = join(resolve(sandboxDir), "Library", "LaunchAgents");
    if (existsSync(launchAgentsDir)) {
      for (const entry of readdirSync(launchAgentsDir).filter(name => name.endsWith(".plist"))) {
        spawnSync("launchctl", ["unload", join(launchAgentsDir, entry)], { stdio: "ignore" });
      }
    }
    return;
  }

  if (process.platform !== "linux") return;

  // Stop the unit first so systemd does not restart it after we remove files.
  spawnSync("systemctl", ["--user", "stop", "bs9-daemon"], { stdio: "ignore" });

  const unitDir = join(homedir(), ".config", "systemd", "user");
  if (!existsSync(unitDir)) return;

  const sandboxRoot = resolve(sandboxDir);

  for (const entry of readdirSync(unitDir)) {
    const linkPath = join(unitDir, entry);
    try {
      const stat = lstatSync(linkPath);

      if (stat.isSymbolicLink()) {
        // Remove symlinks that point into the sandbox.
        const rawTarget = readlinkSync(linkPath);
        const target = resolve(isAbsolute(rawTarget) ? rawTarget : join(unitDir, rawTarget));
        if (target === sandboxRoot || target.startsWith(`${sandboxRoot}/`)) {
          const unitName = entry.replace(/\.service$/, "");
          spawnSync("systemctl", ["--user", "stop", unitName], { stdio: "ignore" });
          unlinkSync(linkPath);
        }
      } else if (stat.isFile() && entry.endsWith(".service")) {
        // Remove regular unit files that contain sandbox paths in their content
        // (e.g. BS9_HOME= or socket paths baked into the unit by ensure.ts).
        try {
          const content = readFileSync(linkPath, "utf-8");
          if (content.includes(sandboxRoot)) {
            const unitName = entry.replace(/\.service$/, "");
            spawnSync("systemctl", ["--user", "stop", unitName], { stdio: "ignore" });
            unlinkSync(linkPath);
          }
        } catch {
          // Unreadable — leave it alone.
        }
      }
    } catch {
      // A concurrently removed or unreadable entry needs no further cleanup.
    }
  }

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}
