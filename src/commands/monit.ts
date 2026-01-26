#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { listServices, ServiceMetrics } from "../utils/service-discovery.js";

interface MonitOptions {
  refresh?: string;
}

interface PreviousState {
  [key: string]: ServiceMetrics;
}

export async function monitCommand(options: MonitOptions): Promise<void> {
  const refreshInterval = Number(options.refresh) || 2;

  // Terminal UI state
  let previousState: PreviousState = {};
  let lastRenderedTime: number = 0;

  // Terminal optimization: Enter alternate screen buffer & hide cursor
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  const cleanup = () => {
    // Exit alternate buffer and show cursor
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    console.log('\n👋 Monitoring stopped');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const getMetrics = async (): Promise<ServiceMetrics[]> => {
    try {
      const services = await listServices();

      const servicesWithHealth = await Promise.all(services.map(async (service) => {
        try {
          let port: string | null = null;
          const portMatch = service.description.match(/port[=:]?\s*(\d+)/i);
          if (portMatch) port = portMatch[1];

          if (port) {
            try {
              const healthCheck = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
              service.health = healthCheck.status === 200 ? "✅ OK" : "❌ FAIL";
            } catch {
              service.health = "❌ FAIL";
            }
          } else {
            service.health = "⚠️  NO_PORT";
          }
        } catch {
          service.health = "⚠️  UNKNOWN";
        }
        return service;
      }));

      return servicesWithHealth;
    } catch (error) {
      return [];
    }
  };

  const formatMemory = (bytes: number): string => {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${sizes[i]}`;
  };

  const hasChanged = (current: ServiceMetrics[]): boolean => {
    if (current.length !== Object.keys(previousState).length) return true;

    for (const service of current) {
      const prev = previousState[service.name];
      if (!prev) return true;

      // Check for meaningful changes (exclude CPU as it always fluctuates)
      if (prev.active !== service.active ||
        prev.sub !== service.sub ||
        prev.health !== service.health ||
        prev.memory !== service.memory ||
        prev.pid !== service.pid) {
        return true;
      }
    }
    return false;
  };

  const renderDashboard = (services: ServiceMetrics[], force: boolean = false) => {
    const changed = hasChanged(services);

    // Always update timestamp area at least once every 10s even if no metrics changed
    const now = Date.now();
    const timeToUpdateTimestamp = now - lastRenderedTime > 10000;

    if (!force && !changed && !timeToUpdateTimestamp) return;

    lastRenderedTime = now;

    // In-place update: Move cursor to home (instead of full screen clear)
    process.stdout.write('\x1b[H');

    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const bgDark = '\x1b[48;5;236m';
    const textLight = '\x1b[38;5;15m';
    const textGreen = '\x1b[38;5;46m';
    const textRed = '\x1b[38;5;196m';
    const textYellow = '\x1b[38;5;226m';
    const textBlue = '\x1b[38;5;39m';
    const textCyan = '\x1b[38;5;51m';
    const textGray = '\x1b[38;5;245m';

    process.stdout.write(`${bgDark}${textLight}${bold}╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗${reset}\n`);
    process.stdout.write(`${bgDark}${textLight}${bold}║${reset} ${textCyan}${bold}🔍 SYSTEM SERVICE MONITOR${reset} ${textGray}│${reset} ${textLight}Refresh: ${textCyan}${refreshInterval}s${reset} ${textGray}│${reset} ${textLight}Last: ${textCyan}${new Date().toLocaleTimeString()}${reset} ${textGray}│${reset} ${textLight}Services: ${textCyan}${services.length}${reset} ${bgDark}${textLight}${bold}║${reset}\n`);
    process.stdout.write(`${bgDark}${textLight}${bold}╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝${reset}\n\n`);

    if (services.length === 0) {
      process.stdout.write(`${textGray}  No BS9-managed services running.                     ${reset}\n`);
      // Fill remaining lines to clear old output if any
      process.stdout.write('\x1b[J');
      return;
    }

    process.stdout.write(`${textGray}┌──────────────────┬─────────────────┬──────────┬───────────┬───────────┬───────────┬───────┬───────┬─────────────────────────────────┐${reset}\n`);
    process.stdout.write(`${textGray}│${reset}${bold}${textBlue}SERVICE${reset}...........${textGray}│${reset}${bold}${textBlue}STATE${reset}............${textGray}│${reset}${bold}${textBlue}HEALTH${reset}....${textGray}│${reset}${bold}${textBlue}CPU${reset}........${textGray}│${reset}${bold}${textBlue}MEMORY${reset}.....${textGray}│${reset}${bold}${textBlue}UPTIME${reset}.....${textGray}│${reset}${bold}${textBlue}TASKS${reset}..${textGray}│${reset}${bold}${textBlue}PID${reset}....${textGray}│${reset}${bold}${textBlue}DESCRIPTION${reset}......................${textGray}│${reset}\n`);
    process.stdout.write(`${textGray}├──────────────────┼─────────────────┼──────────┼───────────┼───────────┼───────────┼───────┼───────┼─────────────────────────────────┤${reset}\n`);

    for (const service of services) {
      const stateIcon = service.active === 'active' ? '●' : '●';
      let health = '';
      if (service.health === '✅ OK') health = `${textGreen}✓ OK${reset}`;
      else if (service.health === '❌ FAIL') health = `${textRed}✗ FAIL${reset}`;
      else health = `${textYellow}⚠ UNKNOWN${reset}`;

      const cpuVal = (service.cpu === '-' || service.cpu === '') ? '0' : service.cpu;
      const cpuMs = parseFloat(cpuVal);
      const cpuColor = cpuMs > 20000 ? textRed : cpuMs > 10000 ? textYellow : textGreen;
      const cpu = `${cpuColor}${service.cpu.padEnd(11)}${reset}`;

      const memColor = service.memory !== '-' && parseFloat(service.memory) > 500 ? textYellow : textLight;
      const memory = `${memColor}${service.memory.padEnd(11)}${reset}`;
      const uptime = service.uptime !== '-' ? `${textCyan}${service.uptime.padEnd(11)}${reset}` : `${textGray}-${reset.padEnd(11)}`;
      const tasks = service.tasks !== '-' ? `${textLight}${service.tasks.padEnd(7)}${reset}` : `${textGray}-${reset.padEnd(7)}`;
      const pid = service.pid !== '-' ? `${textLight}${service.pid.padEnd(7)}${reset}` : `${textGray}-${reset.padEnd(7)}`;
      const description = (service.description || '').substring(0, 33).padEnd(33, '.');

      process.stdout.write(`${textGray}│${reset}${service.name.padEnd(18, '.')}${textGray}│${reset}${service.active === 'active' ? textGreen : textRed}${stateIcon} ${service.sub.padEnd(14, '.')}${reset}${textGray}│${reset}${health.padEnd(10, '.')}${textGray}│${reset}${cpu}${textGray}│${reset}${memory}${textGray}│${reset}${uptime}${textGray}│${reset}${tasks}${textGray}│${reset}${pid}${textGray}│${reset}${description}${textGray}│${reset}\n`);
    }

    process.stdout.write(`${textGray}└──────────────────┴─────────────────┴──────────┴───────────┴───────────┴───────────┴───────┴───────┴─────────────────────────────────┘${reset}\n\n`);

    const running = services.filter(s => s.active === 'active').length;
    const totalMemory = services.reduce((sum, s) => {
      if (s.memory !== '-') {
        const match = s.memory.match(/([\d.]+)(B|KB|MB|GB)/);
        if (match) {
          const [, value, unit] = match;
          return sum + Number(value) * Math.pow(1024, ['B', 'KB', 'MB', 'GB'].indexOf(unit));
        }
      }
      return sum;
    }, 0);

    process.stdout.write(`${bgDark}${textLight}${bold}╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗${reset}\n`);
    process.stdout.write(`${bgDark}${textLight}${bold}║${reset} ${textCyan}📊 SUMMARY:${reset} ${textGreen}● ${running}/${services.length} services running${reset} ${textGray}│${reset} ${textCyan}💾 Total Memory:${reset} ${textYellow}${formatMemory(totalMemory).padEnd(8)}${reset} ${bgDark}${textLight}${bold}║${reset}\n`);

    const failed = services.filter(s => s.active !== 'active');
    const unhealthy = services.filter(s => s.health === '❌ FAIL');

    if (failed.length > 0 || unhealthy.length > 0) {
      process.stdout.write(`${bgDark}${textLight}${bold}║${reset} ${textRed}⚠️  ALERTS:                                                                                                     ${bgDark}${textLight}${bold}║${reset}\n`);
      if (failed.length > 0) {
        process.stdout.write(`${bgDark}${textLight}${bold}║${reset}   ${textRed}Failed:${reset} ${failed.map(s => s.name).join(', ').substring(0, 80).padEnd(90)} ${bgDark}${textLight}${bold}║${reset}\n`);
      }
      if (unhealthy.length > 0) {
        process.stdout.write(`${bgDark}${textLight}${bold}║${reset}   ${textRed}Unhealthy:${reset} ${unhealthy.map(s => s.name).join(', ').substring(0, 80).padEnd(87)} ${bgDark}${textLight}${bold}║${reset}\n`);
      }
    }

    process.stdout.write(`${bgDark}${textLight}${bold}╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝${reset}\n`);

    // Clear remaining screen to avoid artifacts if service list shrank
    process.stdout.write('\x1b[J');

    // Update state cache
    previousState = {};
    for (const service of services) {
      previousState[service.name] = JSON.parse(JSON.stringify(service));
    }
  };

  // Start loop
  while (true) {
    try {
      const currentServices = await getMetrics();
      renderDashboard(currentServices);
    } catch (err) {
      process.stdout.write('\x1b[H');
      process.stdout.write(`\x1b[31m⚠️  Dashboard Update Error: ${String(err).substring(0, 80)}\x1b[0m\n`);
    }
    await setTimeout(refreshInterval * 1000);
  }
}