#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  
  constructor() {
    this.configPath = join(homedir(), ".config", "bs9", "alerts.json");
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
        const content = readFileSync(this.configPath, 'utf-8');
        return { ...defaultConfig, ...JSON.parse(content) };
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
      const configDir = join(homedir(), ".config", "bs9");
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to save alert config:', error);
    }
  }
  
  updateConfig(updates: Partial<AlertConfig>): void {
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
    
    if (this.config.webhookUrl) {
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
      } catch (error) {
        console.error('Failed to send webhook alert:', error);
      }
    }
  }
  
  getConfig(): AlertConfig {
    return { ...this.config };
  }
  
  testWebhook(): Promise<boolean> {
    if (!this.config.webhookUrl) {
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
