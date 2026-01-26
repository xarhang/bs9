#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import * as fs from "node:fs";

interface UpdateOptions {
  check?: boolean;
  force?: boolean;
  rollback?: boolean;
  version?: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
}

interface BackupInfo {
  version: string;
  timestamp: number;
  files: string[];
}

class BS9Updater {
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

  private getCurrentVersion(): string {
    try {
      // 1. Try local package.json (dev/source mode)
      const localPackage = join(dirname(dirname(dirname(new URL(import.meta.url).pathname))), 'package.json');
      if (existsSync(localPackage)) {
        const pkg = JSON.parse(fs.readFileSync(localPackage, 'utf8'));
        return pkg.version;
      }

      // 2. Get version from the CLI binary directly if installed via bun install
      const binaryPath = join(homedir(), '.bun', 'bin', 'bs9');
      if (existsSync(binaryPath)) {
        const content = fs.readFileSync(binaryPath, 'utf8');
        const versionMatch = content.match(/version\("([^"]+)"\)/);
        if (versionMatch && versionMatch[1]) {
          return versionMatch[1];
        }
      }

      // 3. Fallback to global package.json
      const globalPackage = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'bs9', 'package.json');
      if (existsSync(globalPackage)) {
        const pkgContent = fs.readFileSync(globalPackage, 'utf8');
        const pkg = JSON.parse(pkgContent);
        return pkg.version;
      }

      return '1.3.4'; // absolute fallback
    } catch {
      return '1.3.4'; // Fallback version
    }
  }

  private async getLatestVersion(): Promise<string> {
    try {
      const response = await fetch('https://registry.npmjs.org/bs9/latest');
      const data = await response.json();
      return data.version;
    } catch (error) {
      console.warn('⚠️  Failed to fetch latest version from npm, using fallback');
      return '1.3.4'; // Return current version as fallback
    }
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }

  public async getUpdateInfo(): Promise<UpdateInfo> {
    const currentVersion = this.getCurrentVersion();
    const latestVersion = await this.getLatestVersion();

    return {
      currentVersion,
      latestVersion,
      hasUpdate: this.compareVersions(currentVersion, latestVersion) > 0
    };
  }

  private createBackup(): BackupInfo {
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
          execSync(`cp -r "${sourcePath}" "${targetPath}"`, { stdio: 'ignore' });
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

    // Get latest version if not specified
    const latestVersion = targetVersion || await this.getLatestVersion();
    const currentVersion = this.getCurrentVersion();

    if (currentVersion === latestVersion && !targetVersion) {
      console.log('✅ BS9 is already up to date');
      console.log(`   Current version: ${currentVersion}`);
      return;
    }

    console.log(`📦 Updating from ${currentVersion} to ${latestVersion}`);

    // Use npm to update globally
    console.log('📦 Installing latest version...');
    try {
      execSync(`bun install -g bs9@${latestVersion}`, { stdio: 'inherit' });
      console.log('✅ BS9 updated successfully!');
      console.log(`   Version: ${latestVersion}`);

      // Verify the update
      const updatedVersion = this.getCurrentVersion();
      if (updatedVersion === latestVersion) {
        console.log('✅ Update verified successfully!');
      } else {
        console.log('⚠️  Update may require manual verification');
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
      backupInfo = JSON.parse(require('fs').readFileSync(backupInfoPath, 'utf-8'));
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
        execSync(`cp -r "${sourcePath}" "${targetPath}"`, { stdio: 'ignore' });
        console.log(`✅ Restored ${file}`);
      } catch (error) {
        console.warn(`⚠️  Failed to restore ${file}: ${error}`);
      }
    }

    // Reinstall dependencies
    console.log('📦 Reinstalling dependencies...');
    try {
      execSync('bun install', { stdio: 'inherit', cwd: process.cwd() });
      console.log('✅ Dependencies reinstalled');
    } catch (error) {
      console.error('❌ Failed to reinstall dependencies:', error);
    }

    console.log(`🔄 Rollback to version ${backupInfo.version} completed`);
  }

  private listBackups(): void {
    console.log('📋 BS9 Backup History:');
    console.log('='.repeat(50));

    try {
      const backups = execSync(`ls -la "${this.backupDir}" | grep backup-`, { encoding: 'utf-8' });
      const lines = backups.trim().split('\n');

      if (lines.length === 0) {
        console.log('No backups found.');
        return;
      }

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const backupName = parts[parts.length - 1];
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

    // Check for updates first
    const updateInfo = await updater.getUpdateInfo();

    if (!options.force && !updateInfo.hasUpdate) {
      console.log('✅ BS9 is already up to date');
      console.log(`   Current version: ${updateInfo.currentVersion}`);
      return;
    }

    if (updateInfo.hasUpdate) {
      console.log(`📦 Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`);
    }

    // Perform update
    await updater.performUpdate(options.version);

  } catch (error) {
    console.error('❌ Update failed:', error);
    process.exit(1);
  }
}
