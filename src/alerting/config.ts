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
    (a === 100 && b >= 64 && b <= 127) ||       // 100.64.0.0/10 (CGNAT)
    (a === 192 && b === 0 && c === 2) ||        // 192.0.2.0/24 (TEST-NET-1)
    (a === 198 && (b === 18 || b === 19)) ||    // 198.18.0.0/15 (benchmarking)
    (a === 198 && b === 51 && c === 100) ||     // 198.51.100.0/24 (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) ||      // 203.0.113.0/24 (TEST-NET-3)
    a >= 224                                    // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved/broadcast)
  );
}

function parseIpv6Hextets(ip: string): number[] | null {
  // Handle embedded IPv4 suffix (e.g. ::ffff:127.0.0.1 or ::127.0.0.1)
  let work = ip;
  const lastColon = work.lastIndexOf(':');
  if (lastColon !== -1 && work.slice(lastColon + 1).includes('.')) {
    const ipv4Part = work.slice(lastColon + 1);
    const m = ipv4Part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const [, a, b, c, d] = m.map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = work.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (parts.length === 1 && left.length !== 8) return null;
  if (parts.length === 2 && missing < 0) return null;

  const full = parts.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (full.length !== 8) return null;

  const hextets: number[] = [];
  for (const h of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    hextets.push(parseInt(h, 16));
  }
  return hextets;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!ip) return true;

  // Plain IPv4
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    return isPrivateIpv4Octets(a, b, c, d);
  }

  if (ip.includes(':')) {
    const h = parseIpv6Hextets(ip);
    if (!h) return true; // Reject malformed IPv6

    // Unspecified (::) and Loopback (::1) in any compressed/expanded form
    const allZeroPrefix = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
    if (allZeroPrefix && h[6] === 0 && (h[7] === 0 || h[7] === 1)) {
      return true;
    }

    // IPv4-compatible IPv6 (::a.b.c.d) or IPv4-mapped IPv6 (::ffff:a.b.c.d)
    if (allZeroPrefix || (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff)) {
      const a = (h[6] >> 8) & 0xff;
      const b = h[6] & 0xff;
      const c = (h[7] >> 8) & 0xff;
      const d = h[7] & 0xff;
      return isPrivateIpv4Octets(a, b, c, d);
    }

    // NAT64 (64:ff9b::/96)
    if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      const a = (h[6] >> 8) & 0xff;
      const b = h[6] & 0xff;
      const c = (h[7] >> 8) & 0xff;
      const d = h[7] & 0xff;
      return isPrivateIpv4Octets(a, b, c, d);
    }

    // 6to4 (2002::/16) embedding an IPv4 address in h[1], h[2]
    if (h[0] === 0x2002) {
      const a = (h[1] >> 8) & 0xff;
      const b = h[1] & 0xff;
      const c = (h[2] >> 8) & 0xff;
      const d = h[2] & 0xff;
      if (isPrivateIpv4Octets(a, b, c, d)) return true;
    }

    // Unique local (fc00::/7), Link-local unicast (fe80::/10), Multicast (ff00::/8)
    if ((h[0] & 0xfe00) === 0xfc00) return true;
    if ((h[0] & 0xffc0) === 0xfe80) return true;
    if ((h[0] & 0xff00) === 0xff00) return true;
    // Documentation (2001:db8::/32) & Teredo (2001::/32)
    if (h[0] === 0x2001 && (h[1] === 0x0db8 || h[1] === 0x0000)) return true;

    return false;
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
    if (!serviceName || serviceName === "__proto__" || serviceName === "constructor" || serviceName === "prototype") {
      throw new Error(`Invalid service name: '${serviceName}'`);
    }
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
    
    // Check cooldown (update timestamp before awaiting sendAlert to prevent concurrent duplicate alerts)
    const now = Date.now();
    const lastAlert = this.lastAlerts.get(serviceName) || 0;
    
    if (now - lastAlert < this.config.cooldown * 1000) {
      return; // Still in cooldown period
    }
    
    this.lastAlerts.set(serviceName, now);
    await this.sendAlert(serviceName, alerts);
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
