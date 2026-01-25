#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { platform } from "node:os";

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
}

export function getPlatformInfo(): PlatformInfo {
  const currentPlatform = platform() as Platform;
  
  const baseInfo: PlatformInfo = {
    platform: currentPlatform,
    isLinux: currentPlatform === 'linux',
    isMacOS: currentPlatform === 'darwin',
    isWindows: currentPlatform === 'win32',
    serviceManager: 'systemd',
    configDir: '',
    logDir: '',
    serviceDir: ''
  };
  
  switch (currentPlatform) {
    case 'linux':
      baseInfo.serviceManager = 'systemd';
      baseInfo.configDir = `${process.env.HOME}/.config/bs9`;
      baseInfo.logDir = `${process.env.HOME}/.local/share/bs9/logs`;
      baseInfo.serviceDir = `${process.env.HOME}/.config/systemd/user`;
      break;
      
    case 'darwin':
      baseInfo.serviceManager = 'launchd';
      baseInfo.configDir = `${process.env.HOME}/.bs9`;
      baseInfo.logDir = `${process.env.HOME}/.bs9/logs`;
      baseInfo.serviceDir = `${process.env.HOME}/Library/LaunchAgents`;
      break;
      
    case 'win32':
      baseInfo.serviceManager = 'windows-service';
      baseInfo.configDir = `${process.env.USERPROFILE}/.bs9`;
      baseInfo.logDir = `${process.env.USERPROFILE}/.bs9/logs`;
      baseInfo.serviceDir = `${process.env.USERPROFILE}/.bs9/services`;
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
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'loadbalancer', 'dbpool'];
      
    case 'darwin':
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'loadbalancer', 'dbpool', 'macos'];
      
    case 'win32':
      return ['start', 'stop', 'restart', 'status', 'logs', 'monit', 'web', 'alert', 'export', 'deps', 'profile', 'loadbalancer', 'dbpool', 'windows'];
      
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
