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
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDirectory, securePrivateFile, writePrivateFile } from "../utils/private-files.js";

export function isValidWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
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
  }): Promise<void> {
    if (!this.config.enabled) return;
    
    const serviceConfig = this.config.services[serviceName];
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
    
    if (this.config.webhookUrl && isValidWebhookUrl(this.config.webhookUrl)) {
      try {
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
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
  
  testWebhook(): Promise<boolean> {
    if (!this.config.webhookUrl || !isValidWebhookUrl(this.config.webhookUrl)) {
      return Promise.resolve(false);
    }
    
    return fetch(this.config.webhookUrl, {
      method: 'POST',
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
