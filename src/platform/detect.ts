#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { platform, homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type Platform = 'linux' | 'darwin' | 'win32';

export interface PlatformInfo {
  platform: Platform;
  isLinux: boolean;
  isMacOS: boolean;
  isWindows: boolean;
  serviceManager: 'systemd' | 'launchd' | 'windows-service';
  configDir: string;
  logDir: string;
  serviceDir: string;
  backupDir: string;
}

export function getPlatformInfo(): PlatformInfo {
  const currentPlatform = platform() as Platform;
  const userHome = homedir();

  const baseInfo: PlatformInfo = {
    platform: currentPlatform,
    isLinux: currentPlatform === 'linux',
    isMacOS: currentPlatform === 'darwin',
    isWindows: currentPlatform === 'win32',
    serviceManager: 'systemd',
    configDir: '',
    logDir: '',
    serviceDir: '',
    backupDir: ''
  };

  switch (currentPlatform) {
    case 'linux':
      baseInfo.serviceManager = 'systemd';
      baseInfo.configDir = join(userHome, '.config', 'bs9');
      baseInfo.logDir = join(userHome, '.local', 'share', 'bs9', 'logs');
      baseInfo.serviceDir = join(userHome, '.config', 'systemd', 'user');
      baseInfo.backupDir = join(baseInfo.configDir, 'backups');
      break;

    case 'darwin':
      baseInfo.serviceManager = 'launchd';
      baseInfo.configDir = join(userHome, '.bs9');
      baseInfo.logDir = join(userHome, '.bs9', 'logs');
      baseInfo.serviceDir = join(userHome, 'Library', 'LaunchAgents');
      baseInfo.backupDir = join(baseInfo.configDir, 'backups');
      break;

    case 'win32':
      baseInfo.serviceManager = 'windows-service';
      baseInfo.configDir = join(userHome, '.bs9');
      baseInfo.logDir = join(userHome, '.bs9', 'logs');
      baseInfo.serviceDir = join(userHome, '.bs9', 'services');
      baseInfo.backupDir = join(baseInfo.configDir, 'backups');
      break;

    default:
      throw new Error(`Unsupported platform: ${currentPlatform}`);
  }

  return baseInfo;
}

export function isSupportedPlatform(): boolean {
  const supportedPlatforms: Platform[] = ['linux', 'darwin', 'win32'];
  return supportedPlatforms.includes(platform() as Platform);
}

export function getPlatformSpecificCommands(): string[] {
  const currentPlatform = platform() as Platform;

  switch (currentPlatform) {
    case 'linux':
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'delete', 'save', 'resurrect', 'loadbalancer', 'dbpool'];

    case 'darwin':
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'delete', 'save', 'resurrect', 'loadbalancer', 'dbpool', 'macos'];

    case 'win32':
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'delete', 'save', 'resurrect', 'loadbalancer', 'dbpool', 'windows'];

    default:
      return [];
  }
}

export function getPlatformHelp(): string {
  const currentPlatform = platform() as Platform;

  switch (currentPlatform) {
    case 'linux':
      return `
🐧 Linux Platform Features:
  • Systemd-based service management
  • User-mode service execution
  • Advanced security hardening
  • Resource limits and sandboxing
  
Available Commands:
  ${getPlatformSpecificCommands().join(', ')}
`;

    case 'darwin':
      return `
🍎 macOS Platform Features:
  • Launchd service management
  • Native macOS integration
  • Automatic service recovery
  • Standard macOS logging
  
Available Commands:
  ${getPlatformSpecificCommands().join(', ')}
  
macOS-specific:
  • bs9 macos create - Create launchd service
  • bs9 macos start - Start launchd service
  • bs9 macos stop - Stop launchd service
`;

    case 'win32':
      return `
🪟 Windows Platform Features:
  • Windows service management
  • PowerShell-based automation
  • Event log integration
  • Service recovery policies
  
Available Commands:
  ${getPlatformSpecificCommands().join(', ')}
  
Windows-specific:
  • bs9 windows create - Create Windows service
  • bs9 windows start - Start Windows service
  • bs9 windows stop - Stop Windows service
`;

    default:
      return `❌ Platform ${currentPlatform} is not supported`;
  }
}

// Auto-detect and initialize platform-specific directories
export function initializePlatformDirectories(): void {
  const platformInfo = getPlatformInfo();

  try {
    mkdirSync(platformInfo.configDir, { recursive: true });
    mkdirSync(platformInfo.logDir, { recursive: true });
    mkdirSync(platformInfo.backupDir, { recursive: true });
    mkdirSync(platformInfo.serviceDir, { recursive: true });
  } catch (error) {
    console.warn(`⚠️  Warning: Could not create platform directories: ${error}`);
  }
}
