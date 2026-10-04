#!/usr/bin/env bun

/**
 * BS9 - Startup & Unstartup Boot Generator Command
 * Configures system-level auto-resurrect on reboot.
 * Mirrors `pm2 startup` / `pm2 unstartup`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, writePrivateFile } from "../utils/private-files.js";
import { formatSystemdExecStart } from "../utils/systemd.js";
import { escapePlistXmlText } from "../macos/launchd.js";

function getBs9BinaryInfo(): { execPath: string; scriptArgs: string[] } {
  const currentScript = process.argv[1] ? resolve(process.argv[1]) : "";
  if (currentScript && existsSync(currentScript)) {
    return {
      execPath: process.execPath,
      scriptArgs: [currentScript]
    };
  }
  return {
    execPath: "bs9",
    scriptArgs: []
  };
}

export async function startupCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  console.log(`⚙️  Configuring BS9 system boot startup for ${platformInfo.platform}...`);

  const { execPath, scriptArgs } = getBs9BinaryInfo();

  if (platformInfo.isWindows) {
    try {
      const resurrectCmd = scriptArgs.length > 0
        ? `"${execPath}" "${scriptArgs[0]}" resurrect --all`
        : `"${execPath}" resurrect --all`;

      const res = spawnSync("schtasks", ["/Create", "/TN", "BS9_AutoResurrect", "/TR", resurrectCmd, "/SC", "ONLOGON", "/F"], { stdio: "ignore" });
      if (res.status !== 0) throw new Error(`schtasks exited with code ${res.status}`);
      console.log(`✅ Registered Windows Scheduled Task 'BS9_AutoResurrect' on user logon.`);
      console.log(`💡 Your BS9 services will automatically resurrect when your user logs in.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to create Windows Scheduled Task: ${err.message}`);
      console.log(`💡 Try running terminal as Administrator.`);
    }
  } else if (platformInfo.isLinux) {
    try {
      // 1. Enable linger so user services run even when user isn't logged in
      try {
        const username = userInfo().username;
        spawnSync("loginctl", ["enable-linger", username], { stdio: "ignore" });
        console.log(`✅ Enabled systemd user lingering.`);
      } catch {}

      // 2. Write systemd unit for resurrect
      const unitDir = join(homedir(), ".config", "systemd", "user");
      ensurePrivateDirectory(unitDir);

      const execStartLine = formatSystemdExecStart(execPath, [...scriptArgs, "resurrect", "--all"]);

      const unitPath = join(unitDir, "bs9-resurrect.service");
      const unitContent = generateResurrectSystemdUnit(execStartLine);

      writePrivateFile(unitPath, unitContent);
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "bs9-resurrect.service"], { stdio: "ignore" });

      console.log(`✅ Created and enabled systemd user service 'bs9-resurrect.service'.`);
      console.log(`💡 Your BS9 services will automatically resurrect on system boot.`);
    } catch (err: any) {
      console.error(`❌ Failed to configure Linux startup: ${err.message}`);
      throw err;
    }
  } else if (platformInfo.isMacOS) {
    try {
      const launchDir = join(homedir(), "Library", "LaunchAgents");
      ensurePrivateDirectory(launchDir);

      const plistPath = join(launchDir, "com.bs9.resurrect.plist");
      const plistContent = generateResurrectLaunchdPlist(execPath, scriptArgs);
      writePrivateFile(plistPath, plistContent);
      spawnSync("launchctl", ["load", plistPath], { stdio: "ignore" });
      console.log(`✅ Created and loaded macOS LaunchAgent: ${plistPath}`);
    } catch (err: any) {
      console.error(`❌ Failed to configure macOS startup: ${err.message}`);
    }
  }
}

export function generateResurrectSystemdUnit(execStartLine: string): string {
  return `[Unit]
Description=BS9 Process Manager Auto Resurrect
After=network.target
Documentation=https://github.com/xarhang/bs9

[Service]
Type=oneshot
ExecStart=${execStartLine}
RemainAfterExit=yes

[Install]
WantedBy=default.target
`;
}

export function generateResurrectLaunchdPlist(execPath: string, scriptArgs: string[]): string {
  const programArgs = [execPath, ...scriptArgs, "resurrect", "--all"]
    .map((arg) => `        <string>${escapePlistXmlText(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bs9.resurrect</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;
}

export async function unstartupCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  console.log(`🗑️  Removing BS9 system boot startup for ${platformInfo.platform}...`);

  if (platformInfo.isWindows) {
    try {
      spawnSync("schtasks", ["/Delete", "/TN", "BS9_AutoResurrect", "/F"], { stdio: "ignore" });
      console.log(`✅ Removed Windows Scheduled Task 'BS9_AutoResurrect'.`);
    } catch (err: any) {
      console.warn(`⚠️  Task not found or already deleted: ${err.message}`);
    }
  } else if (platformInfo.isLinux) {
    try {
      spawnSync("systemctl", ["--user", "disable", "bs9-resurrect.service"], { stdio: "ignore" });
      const unitPath = join(homedir(), ".config", "systemd", "user", "bs9-resurrect.service");
      if (existsSync(unitPath)) unlinkSync(unitPath);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      console.log(`✅ Removed Linux systemd user service 'bs9-resurrect.service'.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to remove systemd startup: ${err.message}`);
    }
  } else if (platformInfo.isMacOS) {
    try {
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.bs9.resurrect.plist");
      if (existsSync(plistPath)) {
        spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
        unlinkSync(plistPath);
      }
      console.log(`✅ Removed macOS LaunchAgent.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to remove macOS LaunchAgent: ${err.message}`);
    }
  }
}
