#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDirectory, securePrivateFile, writePrivateFile } from "../utils/private-files.js";

function isPrivateIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a > 255 || b > 255 || c > 255 || d > 255 || a < 0 || b < 0 || c < 0 || d < 0) return true;
  return (
    a === 0 ||                                  // 0.0.0.0/8
    a === 10 ||                                 // 10.0.0.0/8
    a === 127 ||                                // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) ||                 // 169.254.0.0/16 (link-local / cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||        // 172.16.0.0/12
    (a === 192 && b === 168) ||                 // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127)          // 100.64.0.0/10 (CGNAT)
  );
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!ip) return true;

  if (ip === '::' || ip === '::1') {
    return true;
  }

  // Block private, loopback, and link-local IPv4 ranges (including dotted IPv4-mapped IPv6)
  const ipv4Match = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    return isPrivateIpv4Octets(a, b, c, d);
  }

  // Handle hex IPv4-mapped IPv6 (e.g. ::ffff:7f00:1 or 0:0:0:0:0:ffff:7f00:0001)
  const hexMappedMatch = ip.match(/^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMappedMatch) {
    const hi = parseInt(hexMappedMatch[1], 16);
    const lo = parseInt(hexMappedMatch[2], 16);
    return isPrivateIpv4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
  }

  // Block IPv6 unspecified/loopback in expanded form, unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  if (ip.includes(':')) {
    if (/^(?:0{1,4}:){7}0{0,3}[01]$/.test(ip)) {
      return true;
    }
    if (/^(fc|fd|fe[89ab]|ff)[0-9a-f]{0,2}:/i.test(ip)) {
      return true;
    }
  }

  return false;
}

export function isValidWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) return false;

    // Block loopback, unspecified, and local/internal hostnames
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return false;
    }

    if (isBlockedIpAddress(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function isSafeWebhookTarget(
  rawUrl: string,
  resolveDns: (hostname: string) => Promise<Array<{ address: string }>> = (h) => lookup(h, { all: true }),
): Promise<boolean> {
  if (!isValidWebhookUrl(rawUrl)) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    // If hostname is already an IP literal, isValidWebhookUrl already validated it.
    if (isIP(hostname) !== 0) {
      return true;
    }
    const records = await resolveDns(hostname);
    if (!records || records.length === 0) {
      return false;
    }
    return records.every((record) => !isBlockedIpAddress(record.address));
  } catch {
    return false;
  }
}

export function formatWebhookForDisplay(webhookUrl?: string): string {
  return webhookUrl ? "[configured; value redacted]" : "[not configured]";
}

interface AlertConfig {
  enabled: boolean;
  webhookUrl?: string;
  thresholds: {
    cpu: number; // percentage
    memory: number; // percentage
    errorRate: number; // percentage
    uptime: number; // percentage
  };
  cooldown: number; // seconds between alerts
  services: {
    [serviceName: string]: {
      enabled: boolean;
      customThresholds?: Partial<AlertConfig['thresholds']>;
    };
  };
}

class AlertManager {
  private configPath: string;
  private config: AlertConfig;
  private lastAlerts: Map<string, number> = new Map();
  
  constructor(configPath = join(homedir(), ".config", "bs9", "alerts.json")) {
    this.configPath = configPath;
    this.config = this.loadConfig();
  }
  
  private loadConfig(): AlertConfig {
    const defaultConfig: AlertConfig = {
      enabled: true,
      thresholds: {
        cpu: 80,
        memory: 85,
        errorRate: 5,
        uptime: 95,
      },
      cooldown: 300, // 5 minutes
      services: {},
    };
    
    if (existsSync(this.configPath)) {
      try {
        this.secureConfigDirectory();
        this.secureExistingConfig();
        const content = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Deep merge: preserve defaultConfig nested objects when partial config is loaded
        return {
          ...defaultConfig,
          ...parsed,
          thresholds: { ...defaultConfig.thresholds, ...parsed.thresholds },
          services: { ...defaultConfig.services, ...parsed.services },
        };
      } catch (error) {
        console.error('Failed to load alert config, using defaults:', error);
        return defaultConfig;
      }
    }
    
    // Create default config file
    this.saveConfig(defaultConfig);
    return defaultConfig;
  }
  
  private saveConfig(config: AlertConfig): void {
    try {
      const configDir = dirname(this.configPath);
      this.secureConfigDirectory();
      if (process.platform === "linux" || process.platform === "darwin") {
        writePrivateFile(this.configPath, JSON.stringify(config, null, 2));
      } else {
        // Preserve the existing Windows profile DACL and its inheritance.
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        writeFileSync(this.configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (error) {
      console.error('Failed to save alert config:', error);
      throw error;
    }
  }

  private secureConfigDirectory(): void {
    const configDir = dirname(this.configPath);
    if (process.platform === "linux" || process.platform === "darwin") {
      ensurePrivateDirectory(configDir);
    } else if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
  }

  private secureExistingConfig(): void {
    if (existsSync(this.configPath) && (process.platform === "linux" || process.platform === "darwin")) {
      securePrivateFile(this.configPath);
    }
  }
  
  updateConfig(updates: Partial<AlertConfig>): void {
    if (updates.webhookUrl !== undefined && updates.webhookUrl !== '' && !isValidWebhookUrl(updates.webhookUrl)) {
      throw new Error("Security: Invalid webhook URL. Only http and https protocols are allowed.");
    }
    this.config = { ...this.config, ...updates };
    this.saveConfig(this.config);
  }
  
  setServiceAlert(serviceName: string, enabled: boolean, customThresholds?: Partial<AlertConfig['thresholds']>): void {
    this.config.services[serviceName] = {
      enabled,
      customThresholds,
    };
    this.saveConfig(this.config);
  }
  
  async checkAlerts(serviceName: string, metrics: {
    cpu: number;
    memory: number;
    health: 'healthy' | 'unhealthy' | 'unknown';
    uptime: number;
    errorRate?: number;
  }): Promise<void> {
    if (!this.config.enabled) return;
    
    const serviceConfig = Object.hasOwn(this.config.services, serviceName)
      ? this.config.services[serviceName]
      : undefined;
    if (serviceConfig && !serviceConfig.enabled) return;
    
    const thresholds = {
      ...this.config.thresholds,
      ...serviceConfig?.customThresholds,
    };
    
    const alerts: string[] = [];
    
    // Check CPU threshold
    if (metrics.cpu > thresholds.cpu) {
      alerts.push(`CPU usage (${metrics.cpu}%) exceeds threshold (${thresholds.cpu}%)`);
    }
    
    // Check Memory threshold
    if (metrics.memory > thresholds.memory) {
      alerts.push(`Memory usage (${metrics.memory}%) exceeds threshold (${thresholds.memory}%)`);
    }
    
    // Check Error Rate threshold
    if (metrics.errorRate !== undefined && metrics.errorRate > thresholds.errorRate) {
      alerts.push(`Error rate (${metrics.errorRate}%) exceeds threshold (${thresholds.errorRate}%)`);
    }
    
    // Check Uptime threshold
    if (metrics.uptime < thresholds.uptime) {
      alerts.push(`Uptime (${metrics.uptime}%) below threshold (${thresholds.uptime}%)`);
    }
    
    // Check health
    if (metrics.health === 'unhealthy') {
      alerts.push('Service health check failed');
    }
    
    if (alerts.length === 0) return;
    
    // Check cooldown
    const now = Date.now();
    const lastAlert = this.lastAlerts.get(serviceName) || 0;
    
    if (now - lastAlert < this.config.cooldown * 1000) {
      return; // Still in cooldown period
    }
    
    // Send alert
    await this.sendAlert(serviceName, alerts);
    this.lastAlerts.set(serviceName, now);
  }
  
  private async sendAlert(serviceName: string, alerts: string[]): Promise<void> {
    const message = `🚨 BS9 Alert for ${serviceName}:\n${alerts.join('\n')}`;
    
    console.error(message);
    
    if (this.config.webhookUrl && await isSafeWebhookTarget(this.config.webhookUrl)) {
      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            service: serviceName,
            alerts,
            timestamp: new Date().toISOString(),
            severity: 'warning',
          }),
        });
        
        if (!response.ok) {
          console.error(`Failed to send webhook alert: ${response.statusText}`);
        }
      } catch {
        // Fetch errors may embed the request URL, which carries the webhook token.
        console.error('Failed to send webhook alert');
      }
    }
  }
  
  getConfig(): AlertConfig {
    return { ...this.config };
  }
  
  async testWebhook(): Promise<boolean> {
    if (!this.config.webhookUrl || !(await isSafeWebhookTarget(this.config.webhookUrl))) {
      return false;
    }
    
    return fetch(this.config.webhookUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        test: true,
        message: 'BS9 Alert System Test',
        timestamp: new Date().toISOString(),
      }),
    })
    .then(response => response.ok)
    .catch(() => false);
  }
}

export { AlertManager, AlertConfig };
