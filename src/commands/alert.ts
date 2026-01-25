#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { AlertManager } from "../alerting/config.js";

interface AlertOptions {
  enable?: boolean;
  disable?: boolean;
  webhook?: string;
  cpu?: string;
  memory?: string;
  errorRate?: string;
  uptime?: string;
  cooldown?: string;
  service?: string;
  list?: boolean;
  test?: boolean;
}

export async function alertCommand(options: AlertOptions): Promise<void> {
  const alertManager = new AlertManager();
  
  if (options.list) {
    const config = alertManager.getConfig();
    console.log('🔔 BS9 Alert Configuration');
    console.log('='.repeat(40));
    console.log(`Enabled: ${config.enabled}`);
    if (config.webhookUrl) {
      console.log(`Webhook: ${config.webhookUrl}`);
    }
    console.log('');
    console.log('Thresholds:');
    console.log(`  CPU: ${config.thresholds.cpu}%`);
    console.log(`  Memory: ${config.thresholds.memory}%`);
    console.log(`  Error Rate: ${config.thresholds.errorRate}%`);
    console.log(`  Uptime: ${config.thresholds.uptime}%`);
    console.log(`  Cooldown: ${config.cooldown}s`);
    console.log('');
    
    if (Object.keys(config.services).length > 0) {
      console.log('Service-specific configs:');
      for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
        console.log(`  ${serviceName}:`);
        console.log(`    Enabled: ${serviceConfig.enabled}`);
        if (serviceConfig.customThresholds) {
          console.log(`    Custom thresholds:`, serviceConfig.customThresholds);
        }
      }
    }
    return;
  }
  
  if (options.test) {
    console.log('🧪 Testing alert webhook...');
    const success = await alertManager.testWebhook();
    if (success) {
      console.log('✅ Webhook test successful');
    } else {
      console.log('❌ Webhook test failed');
    }
    return;
  }
  
  const updates: any = {};
  
  if (options.enable !== undefined) {
    updates.enabled = options.enable;
  }
  
  if (options.webhook) {
    updates.webhookUrl = options.webhook;
  }
  
  const thresholdUpdates: any = {};
  if (options.cpu) thresholdUpdates.cpu = Number(options.cpu);
  if (options.memory) thresholdUpdates.memory = Number(options.memory);
  if (options.errorRate) thresholdUpdates.errorRate = Number(options.errorRate);
  if (options.uptime) thresholdUpdates.uptime = Number(options.uptime);
  if (options.cooldown) thresholdUpdates.cooldown = Number(options.cooldown);
  
  if (Object.keys(thresholdUpdates).length > 0) {
    updates.thresholds = {
      ...alertManager.getConfig().thresholds,
      ...thresholdUpdates,
    };
  }
  
  if (options.service) {
    const serviceName = options.service;
    const enabled = options.enable !== false;
    alertManager.setServiceAlert(serviceName, enabled, Object.keys(thresholdUpdates).length > 0 ? thresholdUpdates : undefined);
    console.log(`✅ Updated alert config for service: ${serviceName}`);
  } else if (Object.keys(updates).length > 0) {
    alertManager.updateConfig(updates);
    console.log('✅ Updated global alert configuration');
  } else {
    console.log('ℹ️  No changes specified. Use --help for options.');
  }
}
