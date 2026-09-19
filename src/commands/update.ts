#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { getPlatformInfo } from "../platform/detect.js";
import * as fs from "node:fs";

interface UpdateOptions {
  check?: boolean;
  force?: boolean;
  rollback?: boolean;
  version?: string;
}

export function isValidVersion(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(version) || version === 'latest';
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
}

export interface BackupInfo {
  version: string;
  timestamp: number;
  files: string[];
}

export class BS9Updater {
  private configDir: string;
  private backupDir: string;
  private platformInfo: any;

  constructor() {
    this.platformInfo = getPlatformInfo();
    this.configDir = join(homedir(), '.bs9');
    this.backupDir = join(this.configDir, 'backups');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
  }

  public getCurrentVersion(): string {
    try {
      // 1. Try local package.json (dev/source mode or relative to this file)
      const currentFilePath = fileURLToPath(import.meta.url);
      const candidates = [
        join(dirname(dirname(dirname(currentFilePath))), 'package.json'),
        join(dirname(dirname(currentFilePath)), 'package.json'),
        join(process.cwd(), 'package.json')
      ];

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          try {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (pkg.name === 'bs9' && pkg.version) {
              return pkg.version;
            }
          } catch {}
        }
      }

      // 2. Fallback to global package.json
      const globalPackage = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'bs9', 'package.json');
      if (existsSync(globalPackage)) {
        try {
          const pkg = JSON.parse(readFileSync(globalPackage, 'utf8'));
          if (pkg.version) {
            return pkg.version;
          }
        } catch {}
      }

      // 3. Get version from the CLI binary directly if installed via bun install
      const binaryPaths = [
        join(homedir(), '.bun', 'bin', 'bs9'),
        join(homedir(), '.bun', 'bin', 'bs9.exe')
      ];
      for (const binaryPath of binaryPaths) {
        if (existsSync(binaryPath)) {
          try {
            const content = readFileSync(binaryPath, 'utf8');
            const versionMatch = content.match(/version\("([^"]+)"\)/);
            if (versionMatch && versionMatch[1]) {
              return versionMatch[1];
            }
          } catch {}
        }
      }

      return '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  public async getLatestVersion(): Promise<string | null> {
    // 1. Direct fetch from npm registry
    try {
      const response = await fetch('https://registry.npmjs.org/bs9/latest', {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'bs9-cli'
        },
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data.version === 'string' && isValidVersion(data.version)) {
          return data.version;
        }
      }
    } catch (error: any) {
      // Direct registry fetch failed, try CLI fallbacks
    }

    // 2. Fallback: bun pm view bs9 version
    try {
      const bunPm = spawnSync("bun", ["pm", "view", "bs9", "version"], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      if (bunPm.status === 0 && bunPm.stdout) {
        const ver = bunPm.stdout.trim().split('\n')[0].trim();
        if (isValidVersion(ver)) {
          return ver;
        }
      }
    } catch {}

    // 3. Fallback: npm view bs9 version
    try {
      const npmView = spawnSync("npm", ["view", "bs9", "version"], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        shell: process.platform === 'win32'
      });
      if (npmView.status === 0 && npmView.stdout) {
        const ver = npmView.stdout.trim().split('\n')[0].trim();
        if (isValidVersion(ver)) {
          return ver;
        }
      }
    } catch {}

    return null;
  }

  public compareVersions(v1: string, v2: string): number {
    if (semver.valid(v1) && semver.valid(v2)) {
      return semver.compare(v1, v2);
    }
    const parts1 = v1.replace(/^v/, '').split('.').map(Number);
    const parts2 = v2.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }

  public async getUpdateInfo(): Promise<UpdateInfo | null> {
    const currentVersion = this.getCurrentVersion();
    const latestVersion = await this.getLatestVersion();

    if (!latestVersion) {
      return null;
    }

    return {
      currentVersion,
      latestVersion,
      hasUpdate: this.compareVersions(latestVersion, currentVersion) > 0
    };
  }

  public createBackup(): BackupInfo {
    const timestamp = Date.now();
    const currentVersion = this.getCurrentVersion();
    const backupName = `backup-${currentVersion}-${timestamp}`;
    const backupPath = join(this.backupDir, backupName);

    mkdirSync(backupPath, { recursive: true });

    // Backup key files
    const filesToBackup = [
      'bin/bs9',
      'package.json',
      'src',
      'README.md',
      'LICENSE'
    ];

    const backedUpFiles: string[] = [];

    for (const file of filesToBackup) {
      const sourcePath = join(process.cwd(), file);
      const targetPath = join(backupPath, file);

      try {
        if (existsSync(sourcePath)) {
          cpSync(sourcePath, targetPath, { recursive: true, force: true });
          backedUpFiles.push(file);
        }
      } catch (error) {
        console.warn(`⚠️  Failed to backup ${file}: ${error}`);
      }
    }

    return {
      version: currentVersion,
      timestamp,
      files: backedUpFiles
    };
  }

  public async performUpdate(targetVersion?: string): Promise<void> {
    console.log('🔄 Starting BS9 update...');

    if (targetVersion && !isValidVersion(targetVersion)) {
      console.error(`❌ Security: Invalid version format: '${targetVersion}'. Must follow SemVer (e.g. 1.0.0).`);
      return;
    }

    // Get latest version if not specified
    const latestVersion = targetVersion || await this.getLatestVersion();
    if (!latestVersion) {
      console.error('❌ Failed to fetch latest version from npm registry. Update aborted.');
      console.log('💡 Try installing manually: bun install -g bs9@latest');
      return;
    }

    if (!isValidVersion(latestVersion)) {
      console.error(`❌ Security: Invalid latest version format received: '${latestVersion}'.`);
      return;
    }

    const currentVersion = this.getCurrentVersion();

    if (currentVersion === latestVersion && !targetVersion) {
      console.log('✅ BS9 is already up to date');
      console.log(`   Current version: ${currentVersion}`);
      return;
    }

    if (!targetVersion && this.compareVersions(latestVersion, currentVersion) <= 0) {
      console.log('✅ BS9 is already up to date');
      console.log(`   Current version: ${currentVersion}`);
      console.log(`   Latest version:  ${latestVersion}`);
      return;
    }

    console.log(`📦 Updating from ${currentVersion} to ${latestVersion}`);

    // Create a backup before proceeding
    try {
      const backup = this.createBackup();
      const backupInfoPath = join(this.backupDir, 'current-backup.json');
      writeFileSync(backupInfoPath, JSON.stringify(backup, null, 2), 'utf8');
    } catch (err) {
      console.warn(`⚠️  Failed to create backup: ${err}`);
    }

    // Use bun to update globally
    console.log('📦 Installing latest version...');
    try {
      const res = spawnSync("bun", ["install", "-g", `bs9@${latestVersion}`], { stdio: 'inherit' });
      if (res.status !== 0) {
        throw new Error(`Process exited with code ${res.status}`);
      }
      console.log('✅ BS9 updated successfully!');
      console.log(`   Version: ${latestVersion}`);

      // Verify the update
      const updatedVersion = this.getCurrentVersion();
      if (updatedVersion === latestVersion) {
        console.log('✅ Update verified successfully!');
      } else {
        console.log('⚠️  Update may require restarting your terminal to reflect the new version');
      }
    } catch (error) {
      console.error('❌ Failed to update BS9:', error);
      console.log('💡 Try: bun install -g bs9@latest');
    }
  }

  public async rollback(backup?: BackupInfo): Promise<void> {
    console.log('🔄 Rolling back BS9...');

    let backupInfo: BackupInfo;
    if (backup) {
      backupInfo = backup;
    } else {
      // Load latest backup
      const backupInfoPath = join(this.backupDir, 'current-backup.json');
      if (!existsSync(backupInfoPath)) {
        console.error('❌ No backup found for rollback');
        return;
      }
      backupInfo = JSON.parse(fs.readFileSync(backupInfoPath, 'utf-8'));
    }

    const backupPath = join(this.backupDir, `backup-${backupInfo.version}-${backupInfo.timestamp}`);

    if (!existsSync(backupPath)) {
      console.error(`❌ Backup not found: ${backupPath}`);
      return;
    }

    // Restore files
    for (const file of backupInfo.files) {
      const sourcePath = join(backupPath, file);
      const targetPath = join(process.cwd(), file);

      try {
        cpSync(sourcePath, targetPath, { recursive: true, force: true });
        console.log(`✅ Restored ${file}`);
      } catch (error) {
        console.warn(`⚠️  Failed to restore ${file}: ${error}`);
      }
    }

    // Reinstall dependencies
    console.log('📦 Reinstalling dependencies...');
    try {
      const res = spawnSync("bun", ["install"], { stdio: 'inherit', cwd: process.cwd() });
      if (res.status !== 0) {
        throw new Error(`Process exited with code ${res.status}`);
      }
      console.log('✅ Dependencies reinstalled');
    } catch (error) {
      console.error('❌ Failed to reinstall dependencies:', error);
    }

    console.log(`🔄 Rollback to version ${backupInfo.version} completed`);
  }

  public listBackups(): void {
    console.log('📋 BS9 Backup History:');
    console.log('='.repeat(50));

    try {
      if (!existsSync(this.backupDir)) {
        console.log('No backups found.');
        return;
      }

      const backupDirs = readdirSync(this.backupDir).filter(f => f.startsWith('backup-'));
      if (backupDirs.length === 0) {
        console.log('No backups found.');
        return;
      }

      for (const backupName of backupDirs) {
        const match = backupName.match(/backup-(.+)-(\d+)/);
        if (match) {
          const [, version, timestamp] = match;
          const date = new Date(parseInt(timestamp));
          console.log(`${version.padEnd(10)} ${date.toISOString()} ${backupName}`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to list backups:', error);
    }
  }

  public async checkForUpdates(options?: { check?: boolean; force?: boolean }): Promise<void> {
    console.log('🔍 Checking for BS9 updates...');
    const updateInfo = await this.getUpdateInfo();

    if (!updateInfo) {
      console.warn('⚠️  Failed to fetch latest version from npm registry.');
      console.log(`   Current version: ${this.getCurrentVersion()}`);
      console.log('💡 You can try manually: bun install -g bs9@latest');
      return;
    }

    console.log(`Current version: ${updateInfo.currentVersion}`);
    console.log(`Latest version:  ${updateInfo.latestVersion}`);

    if (!options?.force && !updateInfo.hasUpdate) {
      console.log('✅ BS9 is up to date');
      console.log(`   Current version: ${updateInfo.currentVersion}`);
      return;
    }

    if (updateInfo.hasUpdate) {
      console.log('✨ Update available!');
      console.log(`   Run: bs9 update to install ${updateInfo.latestVersion}`);
    } else {
      console.log('✅ BS9 is up to date');
      console.log(`   Current version: ${updateInfo.currentVersion}`);
    }
  }
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  const updater = new BS9Updater();

  try {
    if (options.check) {
      await updater.checkForUpdates(options);
      return;
    }

    if (options.rollback) {
      await updater.rollback();
      return;
    }

    if (options.version) {
      await updater.performUpdate(options.version);
      return;
    }

    // Check for updates first
    const updateInfo = await updater.getUpdateInfo();

    if (!updateInfo) {
      console.warn('⚠️  Failed to fetch latest version from npm registry.');
      console.log('💡 You can try manually: bun install -g bs9@latest');
      return;
    }

    if (!options.force && !updateInfo.hasUpdate) {
      console.log('✅ BS9 is already up to date');
      console.log(`   Current version: ${updateInfo.currentVersion}`);
      return;
    }

    if (updateInfo.hasUpdate) {
      console.log(`📦 Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`);
    }

    // Perform update
    await updater.performUpdate(updateInfo.latestVersion);

  } catch (error) {
    console.error('❌ Update failed:', error);
    process.exit(1);
  }
}
