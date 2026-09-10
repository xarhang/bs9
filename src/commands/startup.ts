#!/usr/bin/env bun

/**
 * BS9 - Startup & Unstartup Boot Generator Command
 * Configures system-level auto-resurrect on reboot.
 * Mirrors `pm2 startup` / `pm2 unstartup`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";

export async function startupCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  console.log(`⚙️  Configuring BS9 system boot startup for ${platformInfo.platform}...`);

  if (platformInfo.isWindows) {
    try {
      const bs9Bin = process.execPath; // bun path
      const resurrectCmd = `"${bs9Bin}" "${join(process.cwd(), 'bin', 'bs9')}" resurrect --all`;
      const schtask = `schtasks /Create /TN "BS9_AutoResurrect" /TR "${resurrectCmd.replace(/"/g, '\\"')}" /SC ONLOGON /F`;

      execSync(schtask, { stdio: "ignore" });
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
        execSync(`loginctl enable-linger $(whoami)`, { stdio: "ignore" });
        console.log(`✅ Enabled systemd user lingering.`);
      } catch {}

      // 2. Write systemd unit for resurrect
      const unitDir = join(homedir(), ".config", "systemd", "user");
      if (!existsSync(unitDir)) mkdirSync(unitDir, { recursive: true });

      const unitPath = join(unitDir, "bs9-resurrect.service");
      const unitContent = `[Unit]
Description=BS9 Process Manager Auto Resurrect
After=network.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${join(process.cwd(), 'bin', 'bs9')} resurrect --all
RemainAfterExit=yes

[Install]
WantedBy=default.target
`;
      writeFileSync(unitPath, unitContent);
      execSync(`systemctl --user daemon-reload`, { stdio: "ignore" });
      execSync(`systemctl --user enable bs9-resurrect.service`, { stdio: "ignore" });

      console.log(`✅ Created and enabled systemd user service 'bs9-resurrect.service'.`);
      console.log(`💡 Your BS9 services will automatically resurrect on system boot.`);
    } catch (err: any) {
      console.error(`❌ Failed to configure Linux startup: ${err.message}`);
    }
  } else if (platformInfo.isMacOS) {
    try {
      const launchDir = join(homedir(), "Library", "LaunchAgents");
      if (!existsSync(launchDir)) mkdirSync(launchDir, { recursive: true });

      const plistPath = join(launchDir, "com.bs9.resurrect.plist");
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bs9.resurrect</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${join(process.cwd(), 'bin', 'bs9')}</string>
        <string>resurrect</string>
        <string>--all</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;
      writeFileSync(plistPath, plistContent);
      execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
      console.log(`✅ Created and loaded macOS LaunchAgent: ${plistPath}`);
    } catch (err: any) {
      console.error(`❌ Failed to configure macOS startup: ${err.message}`);
    }
  }
}

export async function unstartupCommand(): Promise<void> {
  const platformInfo = getPlatformInfo();
  console.log(`🗑️  Removing BS9 system boot startup for ${platformInfo.platform}...`);

  if (platformInfo.isWindows) {
    try {
      execSync(`schtasks /Delete /TN "BS9_AutoResurrect" /F`, { stdio: "ignore" });
      console.log(`✅ Removed Windows Scheduled Task 'BS9_AutoResurrect'.`);
    } catch (err: any) {
      console.warn(`⚠️  Task not found or already deleted: ${err.message}`);
    }
  } else if (platformInfo.isLinux) {
    try {
      execSync(`systemctl --user disable bs9-resurrect.service`, { stdio: "ignore" });
      const unitPath = join(homedir(), ".config", "systemd", "user", "bs9-resurrect.service");
      if (existsSync(unitPath)) unlinkSync(unitPath);
      execSync(`systemctl --user daemon-reload`, { stdio: "ignore" });
      console.log(`✅ Removed Linux systemd user service 'bs9-resurrect.service'.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to remove systemd startup: ${err.message}`);
    }
  } else if (platformInfo.isMacOS) {
    try {
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.bs9.resurrect.plist");
      if (existsSync(plistPath)) {
        execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
        unlinkSync(plistPath);
      }
      console.log(`✅ Removed macOS LaunchAgent.`);
    } catch (err: any) {
      console.warn(`⚠️  Failed to remove macOS LaunchAgent: ${err.message}`);
    }
  }
}
