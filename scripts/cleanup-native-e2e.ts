import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getPlatformInfo } from "../src/platform/detect.js";

const platformInfo = getPlatformInfo();
const prefix = "bs9-ci-";

if (platformInfo.isWindows && existsSync(platformInfo.serviceDir)) {
  const { WindowsServiceManager } = await import("../src/windows/service.js");
  const manager = new WindowsServiceManager();
  const names = readdirSync(platformInfo.serviceDir)
    .filter(file => file.startsWith(`BS9_${prefix}`) && file.endsWith(".json"))
    .map(file => file.slice(0, -5));
  for (const name of names) {
    try { await manager.deleteService(name); } catch {}
  }
  try { await manager.deleteService("BS9_DAEMON"); } catch {}
}

if (platformInfo.isMacOS) {
  const configPath = join(platformInfo.configDir, "launchd-services.json");
  if (existsSync(configPath)) {
    const configs = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const { launchdCommand } = await import("../src/macos/launchd.js");
    for (const label of Object.keys(configs).filter(name =>
      name.startsWith(`bs9.${prefix}`) || name === "com.bs9.daemon"
    )) {
      try { await launchdCommand("delete", { name: label }); } catch {}
    }
  }
}

if (platformInfo.isLinux && existsSync(platformInfo.serviceDir)) {
  const units = readdirSync(platformInfo.serviceDir)
    .filter(file => (file.startsWith(prefix) || file === "bs9-daemon.service") && file.endsWith(".service"));
  for (const unit of units) {
    spawnSync("systemctl", ["--user", "disable", "--now", unit], { stdio: "ignore" });
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}

const home = process.env.BS9_HOME;
if (home && existsSync(home)) {
  rmSync(home, { recursive: true, force: true });
}
