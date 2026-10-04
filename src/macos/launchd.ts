#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile, writePrivateFile } from "../utils/private-files.js";

export function isValidServiceName(name: string): boolean {
  const clean = name.replace(/^bs9\./, '');
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(clean) && clean.length <= 64 && !clean.includes('..') && !clean.includes('/');
}

export interface LaunchdServiceConfig {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  environmentVariables: Record<string, string>;
  runAtLoad: boolean;
  keepAlive: boolean;
  standardOutPath?: string;
  standardErrorPath?: string;
  startInterval?: number;
}

/** Escape XML text and reject characters forbidden by XML 1.0. */
export function escapePlistXmlText(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const valid = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) throw new Error("Launchd plist contains a character forbidden by XML 1.0");
  }

  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Serialize the launchd configuration as valid XML plist text. */
export function generateLaunchdPlist(config: LaunchdServiceConfig): string {
  const plistContent: Record<string, unknown> = {
    Label: config.label,
    ProgramArguments: config.programArguments,
    WorkingDirectory: config.workingDirectory,
    EnvironmentVariables: config.environmentVariables,
    RunAtLoad: config.runAtLoad,
    KeepAlive: config.keepAlive,
    StandardOutPath: config.standardOutPath,
    StandardErrorPath: config.standardErrorPath,
    StartInterval: config.startInterval,
  };

  const entries = Object.entries(plistContent).filter(([, value]) => value !== undefined).map(([key, value]) => {
    const xmlKey = escapePlistXmlText(key);
    if (typeof value === "boolean") {
      return `    <key>${xmlKey}</key>\n    <${value ? "true" : "false"}/>`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid integer plist value for ${key}`);
      }
      return `    <key>${xmlKey}</key>\n    <integer>${value}</integer>`;
    }
    if (typeof value === "string") {
      return `    <key>${xmlKey}</key>\n    <string>${escapePlistXmlText(value)}</string>`;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => `        <string>${escapePlistXmlText(String(item))}</string>`).join("\n");
      return `    <key>${xmlKey}</key>\n    <array>\n${items}\n    </array>`;
    }
    if (typeof value === "object" && value !== null) {
      const items = Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        `        <key>${escapePlistXmlText(key)}</key>\n        <string>${escapePlistXmlText(String(item))}</string>`
      ).join("\n");
      return `    <key>${xmlKey}</key>\n    <dict>\n${items}\n    </dict>`;
    }
    return "";
  }).filter(Boolean).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>`;
}

interface LaunchdServiceStatus {
  label: string;
  pid?: number;
  status: 'running' | 'stopped' | 'loaded' | 'unloaded';
  lastExitStatus?: number;
  exitTime?: Date;
}

class LaunchdServiceManager {
  private launchAgentsDir: string;
  private configPath: string;
  
  constructor() {
    const platformInfo = getPlatformInfo();
    this.launchAgentsDir = platformInfo.serviceDir;
    this.configPath = join(platformInfo.configDir, 'launchd-services.json');
    this.ensureDirectories();
  }
  
  private ensureDirectories(): void {
    const configDir = dirname(this.configPath);
    const backupDir = getPlatformInfo().backupDir;
    ensurePrivateDirectory(this.launchAgentsDir);
    ensurePrivateDirectory(configDir);
    if (existsSync(this.configPath)) securePrivateFile(this.configPath);
    for (const file of readdirSync(this.launchAgentsDir)) {
      if (!file.startsWith("bs9.") || !file.endsWith(".plist")) continue;
      const label = file.slice(0, -".plist".length);
      if (isValidServiceName(label)) securePrivateFile(join(this.launchAgentsDir, file));
    }
    if (existsSync(backupDir)) {
      ensurePrivateDirectory(backupDir);
      for (const file of readdirSync(backupDir)) {
        if (file.startsWith("bs9.") && file.endsWith(".plist")) {
          securePrivateFile(join(backupDir, file));
        }
      }
    }
  }
  
  private loadConfigs(): Record<string, LaunchdServiceConfig> {
    if (!existsSync(this.configPath)) return {};

    securePrivateFile(this.configPath);
    let configs: Record<string, LaunchdServiceConfig>;
    try {
      configs = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch (error) {
      console.warn('Failed to load launchd configs:', error);
      return {};
    }

    return configs;
  }
  
  private saveConfigs(configs: Record<string, LaunchdServiceConfig>): void {
    writePrivateFile(this.configPath, JSON.stringify(configs, null, 2));
  }
  
  async createService(config: LaunchdServiceConfig): Promise<void> {
    if (!isValidServiceName(config.label)) {
      throw new Error(`Security: Invalid service label: ${config.label}`);
    }

    const configs = this.loadConfigs();
    configs[config.label] = config;
    this.saveConfigs(configs);
    
    // Generate plist file
    const plistPath = join(this.launchAgentsDir, `${config.label}.plist`);
    writePrivateFile(plistPath, generateLaunchdPlist(config));
    
    try {
      // Load the service
      const res = spawnSync("launchctl", ["load", plistPath], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`launchctl load exited with code ${res.status}`);
      console.log(`✅ Launchd service '${config.label}' created and loaded successfully`);
    } catch (error) {
      console.error(`❌ Failed to create launchd service: ${error}`);
      throw error;
    }
  }
  
  async startService(label: string): Promise<void> {
    if (!isValidServiceName(label)) {
      throw new Error(`Security: Invalid service label: ${label}`);
    }
    try {
      const res = spawnSync("launchctl", ["start", label], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`launchctl start exited with code ${res.status}`);
      console.log(`✅ Launchd service '${label}' started successfully`);
    } catch (error) {
      console.error(`❌ Failed to start launchd service: ${error}`);
      throw error;
    }
  }
  
  async stopService(label: string): Promise<void> {
    if (!isValidServiceName(label)) {
      throw new Error(`Security: Invalid service label: ${label}`);
    }
    try {
      const res = spawnSync("launchctl", ["stop", label], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`launchctl stop exited with code ${res.status}`);
      console.log(`✅ Launchd service '${label}' stopped successfully`);
    } catch (error) {
      console.error(`❌ Failed to stop launchd service: ${error}`);
      throw error;
    }
  }
  
  async unloadService(label: string): Promise<void> {
    if (!isValidServiceName(label)) {
      throw new Error(`Security: Invalid service label: ${label}`);
    }
    const plistPath = join(this.launchAgentsDir, `${label}.plist`);
    
    try {
      // Stop service first
      try {
        await this.stopService(label);
      } catch {
        // Service might not be running
      }
      
      // Unload service
      spawnSync("launchctl", ["unload", plistPath], { stdio: 'inherit' });
      
      // Remove plist file
      if (existsSync(plistPath)) unlinkSync(plistPath);
      
      // Remove from config
      const configs = this.loadConfigs();
      delete configs[label];
      this.saveConfigs(configs);
      
      console.log(`✅ Launchd service '${label}' unloaded and deleted successfully`);
    } catch (error) {
      console.error(`❌ Failed to unload launchd service: ${error}`);
      throw error;
    }
  }
  
  async getServiceStatus(label: string): Promise<LaunchdServiceStatus | null> {
    if (!isValidServiceName(label)) {
      return null;
    }
    try {
      const res = spawnSync("launchctl", ["list", label], { encoding: 'utf-8' });
      const output = res.stdout || '';

      if (res.status === 0 && output.trim()) {
        const status: LaunchdServiceStatus = {
          label: label,
          status: 'loaded'
        };

        // Current macOS returns a dictionary, while older versions may return
        // a tab-separated PID/status/label row.
        const dictionaryPid = output.match(/"PID"\s*=\s*(\d+)/);
        const dictionaryExit = output.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
        const row = output.split('\n').find(line => line.trim().endsWith(label));
        const parts = row?.trim().split(/\s+/);
        const parsedPid = dictionaryPid
          ? parseInt(dictionaryPid[1], 10)
          : parts?.[0] && parts[0] !== '-'
            ? parseInt(parts[0], 10)
            : undefined;

        if (parsedPid !== undefined && Number.isFinite(parsedPid)) {
          status.pid = parsedPid;
          status.status = 'running';
        }

        if (dictionaryExit) {
          status.lastExitStatus = parseInt(dictionaryExit[1], 10);
        } else if (parts?.[1] && parts[1] !== '-') {
          status.lastExitStatus = parseInt(parts[1], 10);
        }

        return status;
      }
    } catch (error) {
      // Service might not exist
    }
    
    return null;
  }
  
  async listServices(): Promise<LaunchdServiceStatus[]> {
    try {
      const configs = this.loadConfigs();
      const services: LaunchdServiceStatus[] = [];
      
      for (const label of Object.keys(configs)) {
        const status = await this.getServiceStatus(label);
        if (status) {
          services.push(status);
        }
      }
      
      return services;
    } catch (error) {
      console.error('Failed to list launchd services:', error);
      return [];
    }
  }
  
  async enableAutoStart(label: string): Promise<void> {
    if (!isValidServiceName(label)) {
      throw new Error(`Security: Invalid service label: ${label}`);
    }
    const configs = this.loadConfigs();
    const config = configs[label];
    
    if (!config) {
      throw new Error(`Service '${label}' not found`);
    }
    
    config.runAtLoad = true;
    config.keepAlive = true;
    this.saveConfigs(configs);
    
    // Update plist file
    const plistPath = join(this.launchAgentsDir, `${label}.plist`);
    writePrivateFile(plistPath, generateLaunchdPlist(config));
    
    // Reload service
    try {
      spawnSync("launchctl", ["unload", plistPath], { stdio: 'inherit' });
      spawnSync("launchctl", ["load", plistPath], { stdio: 'inherit' });
      console.log(`✅ Launchd service '${label}' set to auto-start`);
    } catch (error) {
      console.error(`❌ Failed to configure auto-start: ${error}`);
      throw error;
    }
  }
  
  async disableAutoStart(label: string): Promise<void> {
    if (!isValidServiceName(label)) {
      throw new Error(`Security: Invalid service label: ${label}`);
    }
    const configs = this.loadConfigs();
    const config = configs[label];
    
    if (!config) {
      throw new Error(`Service '${label}' not found`);
    }
    
    config.runAtLoad = false;
    config.keepAlive = false;
    this.saveConfigs(configs);
    
    // Update plist file
    const plistPath = join(this.launchAgentsDir, `${label}.plist`);
    writePrivateFile(plistPath, generateLaunchdPlist(config));
    
    // Reload service
    try {
      spawnSync("launchctl", ["unload", plistPath], { stdio: 'inherit' });
      spawnSync("launchctl", ["load", plistPath], { stdio: 'inherit' });
      console.log(`✅ Launchd service '${label}' set to manual start`);
    } catch (error) {
      console.error(`❌ Failed to configure auto-start: ${error}`);
      throw error;
    }
  }
}

export async function launchdCommand(action: string, options: any): Promise<void> {
  console.log('🍎 BS9 macOS Launchd Service Management');
  console.log('='.repeat(80));
  
  const manager = new LaunchdServiceManager();
  
  try {
    switch (action) {
      case 'create':
        if (!options.name || !options.file) {
          console.error('❌ --name and --file are required for create action');
          process.exit(1);
        }
        
        const config: LaunchdServiceConfig = {
          label: options.name,
          programArguments: [options.file, ...(options.args || [])],
          workingDirectory: options.workingDir || process.cwd(),
          environmentVariables: options.env ? JSON.parse(options.env) : {},
          runAtLoad: options.autoStart !== false,
          keepAlive: options.keepAlive !== false,
          standardOutPath: options.logOut || join(getPlatformInfo().logDir, `${options.name}.out.log`),
          standardErrorPath: options.logErr || join(getPlatformInfo().logDir, `${options.name}.err.log`)
        };
        
        await manager.createService(config);
        break;
        
      case 'start':
        if (!options.name) {
          console.error('❌ --name is required for start action');
          process.exit(1);
        }
        await manager.startService(options.name);
        break;
        
      case 'stop':
        if (!options.name) {
          console.error('❌ --name is required for stop action');
          process.exit(1);
        }
        await manager.stopService(options.name);
        break;
        
      case 'restart':
        if (!options.name) {
          console.error('❌ --name is required for restart action');
          process.exit(1);
        }
        await manager.stopService(options.name);
        await manager.startService(options.name);
        break;
        
      case 'delete':
      case 'unload':
        if (!options.name) {
          console.error('❌ --name is required for unload action');
          process.exit(1);
        }
        await manager.unloadService(options.name);
        break;
        
      case 'status':
        if (options.name) {
          const status = await manager.getServiceStatus(options.name);
          if (status) {
            console.log(`📊 Service Status: ${status.label}`);
            console.log(`   Status: ${status.status}`);
            if (status.pid) console.log(`   PID: ${status.pid}`);
            if (status.lastExitStatus !== undefined) console.log(`   Last Exit Status: ${status.lastExitStatus}`);
          } else {
            console.log(`❌ Service '${options.name}' not found`);
          }
        } else {
          const services = await manager.listServices();
          console.log('📋 BS9 macOS Services:');
          console.log('-'.repeat(80));
          console.log('LABEL'.padEnd(30) + 'STATUS'.padEnd(15) + 'PID'.padEnd(10) + 'EXIT STATUS');
          console.log('-'.repeat(80));
          
          for (const service of services) {
            console.log(
              service.label.padEnd(30) +
              service.status.padEnd(15) +
              (service.pid?.toString() || '-').padEnd(10) +
              (service.lastExitStatus?.toString() || '-')
            );
          }
          
          if (services.length === 0) {
            console.log('No BS9 macOS services found.');
          }
        }
        break;
        
      case 'enable':
        if (!options.name) {
          console.error('❌ --name is required for enable action');
          process.exit(1);
        }
        await manager.enableAutoStart(options.name);
        break;
        
      case 'disable':
        if (!options.name) {
          console.error('❌ --name is required for disable action');
          process.exit(1);
        }
        await manager.disableAutoStart(options.name);
        break;
        
      case 'save':
        if (options.name) {
          if (!isValidServiceName(options.name)) {
            throw new Error(`Security: Invalid service name: ${options.name}`);
          }
          const platformInfo = getPlatformInfo();
          const plistFile = join(platformInfo.serviceDir, `${options.name}.plist`);
          if (existsSync(plistFile)) {
            securePrivateFile(plistFile);
            const plistContent = readFileSync(plistFile, 'utf-8');
            const backupFile = join(platformInfo.backupDir, `${options.name}.plist`);
            ensurePrivateDirectory(platformInfo.backupDir);
            writePrivateFile(backupFile, plistContent);
            console.log(`💾 Service '${options.name}' saved to backup`);
          } else {
            console.warn(`⚠️ No plist found for '${options.name}' to save`);
          }
        }
        break;

      case 'resurrect':
        if (options.name) {
          if (!isValidServiceName(options.name)) {
            throw new Error(`Security: Invalid service name: ${options.name}`);
          }
          const platformInfo = getPlatformInfo();
          const backupFile = join(platformInfo.backupDir, `${options.name}.plist`);
          if (existsSync(backupFile)) {
            ensurePrivateDirectory(platformInfo.backupDir);
            securePrivateFile(backupFile);
            const plistContent = readFileSync(backupFile, 'utf-8');
            const plistFile = join(platformInfo.serviceDir, `${options.name}.plist`);
            writePrivateFile(plistFile, plistContent);
            await manager.startService(options.name);
            console.log(`✅ Service '${options.name}' resurrected from backup`);
          } else {
            throw new Error(`Backup for '${options.name}' not found`);
          }
        }
        break;

      default:
        console.error(`❌ Unknown action: ${action}`);
        console.log('Available actions: create, start, stop, restart, unload, status, enable, disable, save, resurrect');
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`❌ Failed to ${action} macOS service: ${error}`);
    throw error;
  }
}
