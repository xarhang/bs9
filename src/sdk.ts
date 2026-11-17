/**
 * BS9 - Programmatic SDK
 *
 * Clean, typed TypeScript/JavaScript API for embedding BS9 process management,
 * service discovery, log rotation, and reverse-proxy config generation.
 *
 * Example:
 *   import { bs9 } from "bs9";
 *   const services = await bs9.list();
 *   const nginxConf = bs9.exportProxyConfig("nginx", {
 *     serviceName: "api",
 *     domain: "api.example.com",
 *     upstreams: [{ host: "127.0.0.1", port: 3000 }],
 *   });
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { reloadCommand } from "./commands/reload.js";
import { deleteCommand } from "./commands/delete.js";
import { statusCommand } from "./commands/status.js";
import { pingCommand } from "./commands/ping.js";
import { ensureDaemonRunning, isDaemonResponsive } from "./daemon/ensure.js";
import { getPlatformInfo } from "./platform/detect.js";
import { listServices, type ServiceMetrics } from "./utils/service-discovery.js";
import { rotateLogIfNeeded, parseLogSizeBytes, type LogRotationOptions } from "./utils/log-rotator.js";
import {
  generateNginxConfig,
  generateCaddyConfig,
  type ProxyConfigOptions,
} from "./utils/proxy-config.js";
import { getClusterDistributionMode } from "./loadbalancer/manager.js";

export interface Bs9StartOptions {
  name?: string;
  port?: string | number;
  host?: string;
  env?: string[];
  instances?: string | number;
  watch?: boolean;
  maxMemoryRestart?: string;
  interpreter?: string;
  otel?: boolean;
  prometheus?: boolean;
  https?: boolean;
  build?: boolean;
  windowsServiceAccount?: string;
}

export class Bs9Client {
  async start(target: string | string[], options: Bs9StartOptions = {}): Promise<void> {
    const targets = Array.isArray(target) ? target : [target];
    const normalized: Record<string, any> = {
      ...options,
      port: options.port !== undefined ? String(options.port) : undefined,
      instances: options.instances !== undefined ? String(options.instances) : undefined,
    };
    await startCommand(targets, normalized);
  }

  async stop(target: string | string[], options: { force?: boolean } = {}): Promise<void> {
    const targets = Array.isArray(target) ? target : [target];
    await stopCommand(targets, options);
  }

  async restart(target: string | string[], options: { force?: boolean } = {}): Promise<void> {
    const targets = Array.isArray(target) ? target : [target];
    await restartCommand(targets, options);
  }

  async reload(target: string | string[], options: Record<string, any> = {}): Promise<void> {
    const targets = Array.isArray(target) ? target : [target];
    await reloadCommand(targets, options);
  }

  async delete(target: string | string[], options: { force?: boolean } = {}): Promise<void> {
    const targets = Array.isArray(target) ? target : [target];
    await deleteCommand(targets, options);
  }

  async status(service?: string | string[], options: Record<string, any> = {}): Promise<void> {
    const targets = service === undefined ? [] : Array.isArray(service) ? service : [service];
    await statusCommand(targets, options);
  }

  async list(): Promise<ServiceMetrics[]> {
    return listServices();
  }

  async ping(): Promise<boolean> {
    return isDaemonResponsive();
  }

  async pingVerbose(): Promise<void> {
    await pingCommand();
  }

  async ensureDaemon(): Promise<void> {
    await ensureDaemonRunning();
  }

  getPlatform() {
    return getPlatformInfo();
  }

  getClusterDistribution(platform?: NodeJS.Platform, env?: Record<string, string | undefined>) {
    return getClusterDistributionMode(platform, env);
  }

  rotateLog(logPath: string, options: LogRotationOptions = {}): boolean {
    return rotateLogIfNeeded(logPath, options);
  }

  parseLogSize(value?: string | number): number {
    return parseLogSizeBytes(value);
  }

  exportProxyConfig(format: "nginx" | "caddy", options: ProxyConfigOptions): string {
    if (format === "nginx") {
      return generateNginxConfig(options);
    }
    if (format === "caddy") {
      return generateCaddyConfig(options);
    }
    throw new Error(`Unsupported proxy config format: ${String(format)}`);
  }
}

export const bs9 = new Bs9Client();
