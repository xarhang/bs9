#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { AlertManager, formatWebhookForDisplay } from "../alerting/config.js";

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
      console.log(`Webhook: ${formatWebhookForDisplay(config.webhookUrl)}`);
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
  
  if (options.disable) {
    updates.enabled = false;
  } else if (options.enable !== undefined) {
    updates.enabled = options.enable;
  }
  
  if (options.webhook) {
    updates.webhookUrl = options.webhook;
  }

  const parseNonNegativeNumber = (raw: string, flag: string): number => {
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`Invalid ${flag} value: '${raw}' (must be a non-negative number)`);
    }
    return num;
  };
  
  const thresholdUpdates: any = {};
  if (options.cpu !== undefined) thresholdUpdates.cpu = parseNonNegativeNumber(options.cpu, "--cpu");
  if (options.memory !== undefined) thresholdUpdates.memory = parseNonNegativeNumber(options.memory, "--memory");
  if (options.errorRate !== undefined) thresholdUpdates.errorRate = parseNonNegativeNumber(options.errorRate, "--error-rate");
  if (options.uptime !== undefined) thresholdUpdates.uptime = parseNonNegativeNumber(options.uptime, "--uptime");
  if (options.cooldown !== undefined) updates.cooldown = parseNonNegativeNumber(options.cooldown, "--cooldown");
  
  if (Object.keys(thresholdUpdates).length > 0) {
    updates.thresholds = {
      ...alertManager.getConfig().thresholds,
      ...thresholdUpdates,
    };
  }
  
  if (options.service) {
    const serviceName = options.service;
    if (
      !serviceName ||
      serviceName === "__proto__" ||
      serviceName === "constructor" ||
      serviceName === "prototype" ||
      !/^[a-zA-Z0-9._-]+$/.test(serviceName) ||
      serviceName.startsWith("-") ||
      serviceName === "." ||
      serviceName === ".."
    ) {
      throw new Error(`Invalid service name: '${serviceName}'`);
    }
    const existingCfg = alertManager.getConfig().services;
    const existingEnabled = Object.hasOwn(existingCfg, serviceName) ? existingCfg[serviceName].enabled : true;
    const enabled = options.disable ? false : (options.enable === true ? true : existingEnabled);
    alertManager.setServiceAlert(serviceName, enabled, Object.keys(thresholdUpdates).length > 0 ? thresholdUpdates : undefined);
    console.log(`✅ Updated alert config for service: ${serviceName}`);
  } else if (Object.keys(updates).length > 0) {
    alertManager.updateConfig(updates);
    console.log('✅ Updated global alert configuration');
  } else {
    console.log('ℹ️  No changes specified. Use --help for options.');
  }
}
