#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";

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
      const packageJson = join(dirname(process.argv[1]), '..', 'package.json');
      const content = require('fs').readFileSync(packageJson, 'utf-8');
      const pkg = JSON.parse(content);
      return pkg.version;
    } catch {
      return '1.0.0'; // Fallback version
    }
  }
  
  private async getLatestVersion(): Promise<string> {
    try {
      const response = await fetch('https://registry.npmjs.org/bs9/latest');
      const data = await response.json();
      return data.version;
    } catch (error) {
      console.warn('⚠️  Failed to fetch latest version from npm');
      return this.getCurrentVersion();
    }
  }
  
  public async getUpdateInfo(): Promise<UpdateInfo> {
    const currentVersion = this.getCurrentVersion();
    const latestVersion = await this.getLatestVersion();
    
    return {
      currentVersion,
      latestVersion,
      hasUpdate: currentVersion !== latestVersion
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
      const sourcePath = join(dirname(process.argv[1]), '..', file);
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
    
    // Create backup
    console.log('📦 Creating backup...');
    const backup = this.createBackup();
    console.log(`✅ Backup created: ${backup.version}-${backup.timestamp}`);
    
    // Update package.json version
    const packageJsonPath = join(dirname(process.argv[1]), '..', 'package.json');
    const packageJson = JSON.parse(require('fs').readFileSync(packageJsonPath, 'utf-8'));
    const oldVersion = packageJson.version;
    packageJson.version = targetVersion || await this.getLatestVersion();
    
    require('fs').writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(`📝 Updated version: ${oldVersion} → ${packageJson.version}`);
    
    // Install dependencies
    console.log('📦 Installing dependencies...');
    try {
      execSync('bun install', { stdio: 'inherit', cwd: dirname(process.argv[1]) });
      console.log('✅ Dependencies installed');
    } catch (error) {
      console.error('❌ Failed to install dependencies:', error);
      await this.rollback(backup);
      throw error;
    }
    
    // Rebuild
    console.log('🔨 Rebuilding BS9...');
    try {
      execSync('bun run build', { stdio: 'inherit', cwd: dirname(process.argv[1]) });
      console.log('✅ Build completed');
    } catch (error) {
      console.error('❌ Build failed:', error);
      await this.rollback(backup);
      throw error;
    }
    
    // Save backup info
    const backupInfoPath = join(this.backupDir, `current-backup.json`);
    writeFileSync(backupInfoPath, JSON.stringify(backup, null, 2));
    
    console.log('🎉 BS9 updated successfully!');
    console.log(`   Version: ${packageJson.version}`);
    console.log(`   Backup: ${backup.version}-${backup.timestamp}`);
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
      const targetPath = join(dirname(process.argv[1]), '..', file);
      
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
      execSync('bun install', { stdio: 'inherit', cwd: dirname(process.argv[1]) });
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
      console.log('No backups found.');
    }
  }
  
  async checkForUpdates(): Promise<void> {
    console.log('🔍 Checking for BS9 updates...');
    
    const updateInfo = await this.getUpdateInfo();
    
    console.log(`Current version: ${updateInfo.currentVersion}`);
    console.log(`Latest version:  ${updateInfo.latestVersion}`);
    
    if (updateInfo.hasUpdate) {
      console.log('✨ Update available!');
      console.log(`   Run: bs9 update to install ${updateInfo.latestVersion}`);
    } else {
      console.log('✅ BS9 is up to date');
    }
  }
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  const updater = new BS9Updater();
  
  try {
    if (options.check) {
      await updater.checkForUpdates();
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
