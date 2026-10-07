import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { getPlatformInfo } from "../src/platform/detect.js";

const prefix = "bs9-ci-";
const configuredHome = process.env.BS9_HOME;
const isNativeE2E = process.env.BS9_NATIVE_E2E === "1" || process.env.BS9_NATIVE_HA_E2E === "1";
const home = configuredHome ? resolve(configuredHome) : undefined;
const realWorkspace = realpathSync(process.cwd());
const realHome = home && existsSync(home) ? realpathSync(home) : undefined;
const relativeHome = realHome ? relative(realWorkspace, realHome) : "";
const canonicalPathMatches = Boolean(home && realHome && (
  process.platform === "win32"
    ? home.toLowerCase() === realHome.toLowerCase()
    : home === realHome
));
function isPathWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}
const isWorkspaceTestHome = Boolean(
  home &&
  realHome &&
  isNativeE2E &&
  [".tmp-bs9-native-e2e", ".tmp-bs9-native-ha"].includes(basename(home)) &&
  canonicalPathMatches &&
  relativeHome !== "" &&
  isPathWithin(realWorkspace, realHome)
);

if (!isWorkspaceTestHome || !home || !realHome) {
  console.info("Skipping native E2E cleanup: expected an in-workspace BS9_HOME and native E2E flag");
} else {
  const platformInfo = getPlatformInfo();
  const realServiceDir = existsSync(platformInfo.serviceDir) ? realpathSync(platformInfo.serviceDir) : undefined;
  const serviceDirIsScoped = Boolean(realServiceDir && isPathWithin(realHome, realServiceDir));

  if (platformInfo.isWindows && serviceDirIsScoped && realServiceDir) {
    const { WindowsServiceManager } = await import("../src/windows/service.js");
    const manager = new WindowsServiceManager();
    const names = readdirSync(realServiceDir)
      .filter(file => file.startsWith(`BS9_${prefix}`) && file.endsWith(".json"))
      .map(file => file.slice(0, -5));
    for (const name of names) {
      try { await manager.deleteService(name); } catch {}
    }
  }

  if (platformInfo.isMacOS && serviceDirIsScoped && existsSync(platformInfo.configDir)) {
    const realConfigDir = realpathSync(platformInfo.configDir);
    if (isPathWithin(realHome, realConfigDir)) {
      const configPath = join(realConfigDir, "launchd-services.json");
      const realConfigPath = existsSync(configPath) ? realpathSync(configPath) : undefined;
      if (realConfigPath && isPathWithin(realHome, realConfigPath)) {
        const configs = JSON.parse(readFileSync(realConfigPath, "utf8")) as Record<string, unknown>;
        const { launchdCommand } = await import("../src/macos/launchd.js");
        for (const label of Object.keys(configs).filter(name => name.startsWith(`bs9.${prefix}`))) {
          try { await launchdCommand("delete", { name: label }); } catch {}
        }
      }
    }
  }

  if (platformInfo.isLinux && serviceDirIsScoped && realServiceDir) {
    const units = readdirSync(realServiceDir)
      .filter(file => file.startsWith(prefix) && file.endsWith(".service"));
    for (const unit of units) {
      spawnSync("systemctl", ["--user", "disable", "--now", unit], { stdio: "ignore" });
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }

  if (existsSync(realHome)) {
    rmSync(realHome, { recursive: true, force: true });
  }
}
