#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { getPlatformInfo } from "../platform/detect.js";
import { recordCrash, resetCrash, sleep, startHealthyTimer, formatCrashState } from "../utils/crash-tracker.js";

export function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

interface WindowsServiceConfig {
  name: string;
  displayName: string;
  description: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  watch?: boolean;
  maxMemoryRestart?: string;
  restartDelay?: number;
  noAutorestart?: boolean;
  time?: boolean;
  scriptFile?: string;
}

interface WindowsServiceStatus {
  name: string;
  state: 'running' | 'stopped' | 'paused' | 'starting' | 'stopping';
  startType: 'auto' | 'demand' | 'disabled';
  processId?: number;
  startTime?: Date;
  description?: string;
}

export class WindowsServiceManager {
  private configPath: string;
  private servicesDir: string;

  constructor() {
    const platformInfo = getPlatformInfo();
    this.configPath = join(homedir(), '.bs9', 'windows-services.json');
    this.servicesDir = platformInfo.serviceDir;
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    if (!existsSync(dirname(this.configPath))) {
      mkdirSync(dirname(this.configPath), { recursive: true });
    }
    if (!existsSync(this.servicesDir)) {
      mkdirSync(this.servicesDir, { recursive: true });
    }
  }

  private loadConfigs(): Record<string, WindowsServiceConfig> {
    try {
      if (existsSync(this.configPath)) {
        return JSON.parse(readFileSync(this.configPath, 'utf-8'));
      }
    } catch (error) {
      console.warn('Failed to load Windows service configs:', error);
    }
    return {};
  }

  private saveConfigs(configs: Record<string, WindowsServiceConfig>): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(configs, null, 2));
    } catch (error) {
      console.error('Failed to save Windows service configs:', error);
    }
  }

  public checkAdminPrivileges(): boolean {
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async createService(config: WindowsServiceConfig): Promise<void> {
    if (!isValidServiceName(config.name)) {
      throw new Error(`Security: Invalid service name: ${config.name}`);
    }

    const isAdmin = this.checkAdminPrivileges();

    // Save to config either way
    const configs = this.loadConfigs();
    configs[config.name] = config;
    this.saveConfigs(configs);

    if (isAdmin) {
      // Native Windows Service path
      const scriptPath = join(homedir(), '.bs9', `${config.name}-setup.ps1`);
      writeFileSync(scriptPath, this.generateServiceScript(config));
      try {
        const res = spawnSync("powershell", ["-Bypass", "-File", scriptPath], { stdio: 'inherit' });
        if (res.status !== 0) throw new Error(`powershell setup script failed with code ${res.status}`);
        console.log(`✅ Windows service '${config.name}' created successfully`);
      } catch (error) {
        throw error;
      }
    } else {
      // Background Process path
      console.log(`ℹ️ Non-admin user detected. Registering '${config.name}' as a background process...`);
      this.saveProcessMetadata(config.name, {
        name: config.name,
        description: config.description,
        executable: config.executable,
        arguments: config.arguments,
        workingDir: config.workingDirectory,
        environment: config.environment,
        status: 'stopped',
        watch: config.watch,
        maxMemoryRestart: config.maxMemoryRestart,
        restartDelay: config.restartDelay,
        noAutorestart: config.noAutorestart,
        time: config.time,
        scriptFile: config.scriptFile
      });
      console.log(`✅ Service '${config.name}' registered for background execution`);
    }
  }

  async startService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      const res = spawnSync("net", ["start", serviceName], { stdio: 'inherit' });
      if (res.status === 0) {
        console.log(`🚀 Windows service '${serviceName}' started successfully`);
      } else {
        // If net start fails, maybe it's a legacy background process or service doesn't exist
        const metadata = this.getProcessMetadata(serviceName);
        if (metadata) await this.startBackgroundProcess(metadata);
        else throw new Error(`Failed to start service '${serviceName}'`);
      }
    } else {
      const metadata = this.getProcessMetadata(serviceName);
      if (!metadata) throw new Error(`Service '${serviceName}' not found or not registered for background execution`);
      await this.startBackgroundProcess(metadata);
    }
  }

  async stopService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      const res = spawnSync("net", ["stop", serviceName], { stdio: 'inherit' });
      if (res.status !== 0) {
        const metadata = this.getProcessMetadata(serviceName);
        if (metadata) await this.stopBackgroundProcess(metadata);
      }
    } else {
      const metadata = this.getProcessMetadata(serviceName);
      if (!metadata) throw new Error(`Service '${serviceName}' not found`);
      await this.stopBackgroundProcess(metadata);
    }
  }

  async deleteService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const isAdmin = this.checkAdminPrivileges();
    await this.stopService(serviceName);

    if (isAdmin) {
      try { spawnSync("sc.exe", ["delete", serviceName], { stdio: 'ignore' }); } catch { }
    }

    // Remove metadata and config
    const configs = this.loadConfigs();
    delete configs[serviceName];
    this.saveConfigs(configs);

    const metaPath = join(this.servicesDir, `${serviceName}.json`);
    if (existsSync(metaPath)) unlinkSync(metaPath);

    console.log(`✅ Service '${serviceName}' deleted successfully`);
  }

  async getServiceStatus(serviceName: string): Promise<WindowsServiceStatus | null> {
    if (!isValidServiceName(serviceName)) {
      return null;
    }

    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      try {
        const res = spawnSync("sc.exe", ["query", serviceName], { encoding: 'utf-8' });
        const output = res.stdout || '';
        const status: WindowsServiceStatus = { name: serviceName, state: 'stopped', startType: 'demand' };
        if (output.includes('RUNNING')) status.state = 'running';
        // (Simplified parsing for brevity)
        return status;
      } catch { }
    }

    // Check background process metadata
    const metadata = this.getProcessMetadata(serviceName);
    if (metadata && metadata.pid) {
      try {
        const res = spawnSync("tasklist", ["/FI", `PID eq ${metadata.pid}`, "/NH"], { stdio: 'ignore' });
        if (res.status === 0) {
          return { name: serviceName, state: 'running', startType: 'demand', processId: metadata.pid };
        }
      } catch { }
    }

    return metadata ? { name: serviceName, state: 'stopped', startType: 'demand' } : null;
  }

  async listServices(): Promise<WindowsServiceStatus[]> {
    const services: WindowsServiceStatus[] = [];
    const configs = this.loadConfigs();

    for (const name of Object.keys(configs)) {
      const status = await this.getServiceStatus(name);
      if (status) {
        status.description = configs[name].description;
        services.push(status);
      }
    }

    return services;
  }

  private async startBackgroundProcess(metadata: any): Promise<void> {
    console.log(`🚀 Starting background process for '${metadata.name}'...`);

    const logsDir = join(homedir(), '.bs9', 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    // Path to dedicated detached watchdog agent
    const watchdogScript = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.js');
    const watchdogTs = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.ts');
    const agentFile = existsSync(watchdogTs) ? watchdogTs : watchdogScript;

    // Make sure status is set so watchdog starts immediately
    metadata.status = 'starting';
    this.saveProcessMetadata(metadata.name, metadata);

    const watchdogOut = openSync(join(logsDir, `${metadata.name}.watchdog.log`), 'a');

    // Spawn detached watchdog agent that persists even after CLI exits
    const watchdog = spawn(process.execPath, ['run', agentFile, metadata.name], {
      cwd: metadata.workingDir,
      detached: true,
      stdio: ['ignore', watchdogOut, watchdogOut],
      env: { ...process.env },
    });

    watchdog.unref();

    metadata.watchdogPid = watchdog.pid;
    this.saveProcessMetadata(metadata.name, metadata);

    // Wait briefly up to 1 second for child process to be spawned and record PID
    let attempts = 0;
    while (attempts < 10) {
      await sleep(100);
      const fresh = this.getProcessMetadata(metadata.name);
      if (fresh && fresh.pid) {
        metadata.pid = fresh.pid;
        metadata.status = 'running';
        break;
      }
      attempts++;
    }

    console.log(`✅ Started background service '${metadata.name}' (PID: ${metadata.pid || 'running'}, Watchdog: ${watchdog.pid})`);
  }

  private async stopBackgroundProcess(metadata: any): Promise<void> {
    console.log(`🛑 Stopping background process for '${metadata.name}'...`);

    // Signal status stopped so watchdog stops looping
    metadata.status = 'stopped';
    this.saveProcessMetadata(metadata.name, metadata);

    // Kill child application process
    if (metadata.pid) {
      try {
        process.kill(metadata.pid);
      } catch {
        try { execSync(`taskkill /F /PID ${metadata.pid}`, { stdio: 'ignore' }); } catch { }
      }
      metadata.pid = null;
    }

    // Kill watchdog supervisor process
    if (metadata.watchdogPid) {
      try {
        process.kill(metadata.watchdogPid);
      } catch {
        try { execSync(`taskkill /F /PID ${metadata.watchdogPid}`, { stdio: 'ignore' }); } catch { }
      }
      metadata.watchdogPid = null;
    }

    metadata.startTime = null;
    this.saveProcessMetadata(metadata.name, metadata);
    console.log(`✅ Service '${metadata.name}' stopped`);
  }

  private saveProcessMetadata(name: string, data: any): void {
    writeFileSync(join(this.servicesDir, `${name}.json`), JSON.stringify(data, null, 2));
  }

  public getProcessMetadata(name: string): any {
    if (!isValidServiceName(name)) return null;
    const path = join(this.servicesDir, `${name}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
  }

  private generateServiceScript(config: WindowsServiceConfig): string {
    const escapePsString = (str: string) => str.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    const envVars = Object.entries(config.environment || {})
      .map(([key, value]) => {
        const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '');
        return safeKey ? `$env:${safeKey}="${escapePsString(String(value))}"` : '';
      })
      .filter(Boolean)
      .join('\n');
    const args = (config.arguments || []).map(arg => `\\"${escapePsString(arg)}\\"`).join(' ');
    const binPath = `${config.executable} ${args}`.trim();
    return `${envVars}\nNew-Service -Name "${escapePsString(config.name)}" -DisplayName "${escapePsString(config.displayName || config.name)}" -BinaryPathName "${binPath}" -StartupType Automatic\n`;
  }
}

export async function windowsCommand(action: string, options: any): Promise<void> {
  console.log('🪟 BS9 Windows Service Management');
  console.log('='.repeat(80));

  const manager = new WindowsServiceManager();

  try {
    switch (action) {
      case 'create':
        await manager.createService({
          name: options.name,
          displayName: options.displayName || options.name,
          description: options.description || `BS9 Service: ${options.name}`,
          executable: options.file, // Note: caller passes 'file'
          arguments: options.args || [],
          workingDirectory: options.workingDir || process.cwd(),
          environment: options.env ? JSON.parse(options.env) : {},
          watch: options.watch,
          maxMemoryRestart: options.maxMemoryRestart,
          restartDelay: options.restartDelay,
          noAutorestart: options.noAutorestart,
          time: options.time,
          scriptFile: options.scriptFile || (options.args && options.args.length > 0 ? options.args[options.args.length - 1] : options.file)
        });
        await manager.startService(options.name);
        break;
      case 'start':
        await manager.startService(options.name);
        break;
      case 'stop':
        await manager.stopService(options.name);
        break;
      case 'restart':
        await manager.stopService(options.name);
        await manager.startService(options.name);
        break;
      case 'delete':
        await manager.deleteService(options.name);
        break;
      case 'save':
        if (options.name) {
          const metadata = manager.getProcessMetadata(options.name);
          if (metadata) {
            const platformInfo = getPlatformInfo();
            const backupFile = join(platformInfo.backupDir, `${options.name}.json`);
            if (!existsSync(platformInfo.backupDir)) mkdirSync(platformInfo.backupDir, { recursive: true });
            writeFileSync(backupFile, JSON.stringify(metadata, null, 2));
            console.log(`💾 Service '${options.name}' saved to backup`);
          } else {
            console.warn(`⚠️ No metadata found for '${options.name}' to save`);
          }
        }
        break;
      case 'resurrect':
        if (options.name) {
          const platformInfo = getPlatformInfo();
          const backupFile = join(platformInfo.backupDir, `${options.name}.json`);
          if (existsSync(backupFile)) {
            const metadata = JSON.parse(readFileSync(backupFile, 'utf-8'));
            const { startCommand } = await import("../commands/start.js");
            const targetFile = metadata.scriptFile || (metadata.arguments && metadata.arguments.length > 0 ? metadata.arguments[metadata.arguments.length - 1] : metadata.executable);
            await startCommand([targetFile], {
              name: metadata.name.replace(/^BS9_/, ''),
              port: metadata.environment?.PORT,
              host: metadata.environment?.HOST,
              env: Object.entries(metadata.environment || {}).map(([k, v]) => `${k}=${v}`),
            });
            console.log(`✅ Service '${options.name}' resurrected from backup`);
          } else {
            throw new Error(`Backup for '${options.name}' not found`);
          }
        }
        break;
      case 'status':
      case 'show':
        if (options.name) {
          const status = await manager.getServiceStatus(options.name);
          if (status) {
            console.log(`📊 Service Status: ${status.name}`);
            console.log(`   State: ${status.state}`);
            if (status.processId) console.log(`   PID: ${status.processId}`);
          } else {
            throw new Error(`Service '${options.name}' not found`);
          }
        } else {
          const services = await manager.listServices();
          console.table(services.map(s => ({ Name: s.name, State: s.state, PID: s.processId || '-' })));
        }
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`❌ Failed to ${action} Windows service: ${error}`);
    throw error;
  }
}
