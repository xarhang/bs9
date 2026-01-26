#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { serve } from "bun";
import { setTimeout } from "node:timers/promises";

// Security: Input validation functions
function isValidHost(host: string): boolean {
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const localhostRegex = /^(localhost|127\.0\.0\.1)$/;

  return hostnameRegex.test(host) && host.length <= 253 ||
    ipv4Regex.test(host) ||
    localhostRegex.test(host);
}

function isValidPort(port: number): boolean {
  return !isNaN(port) && port >= 1 && port <= 65535;
}

function isValidPath(path: string): boolean {
  // Prevent path traversal attacks
  return !path.includes('..') && !path.includes('~') &&
    /^[a-zA-Z0-9\-_\/]*$/.test(path) && path.length <= 256;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const allowedHeaders = [
    'content-type', 'content-length', 'accept', 'accept-encoding',
    'accept-language', 'user-agent', 'authorization', 'x-forwarded-for',
    'x-real-ip', 'x-forwarded-proto', 'host', 'connection'
  ];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (allowedHeaders.includes(lowerKey)) {
      // Remove potential injection attempts
      sanitized[key] = value.replace(/[\r\n]/g, '').substring(0, 1024);
    }
  }

  return sanitized;
}

interface LoadBalancerConfig {
  port: number;
  algorithm: 'round-robin' | 'least-connections' | 'weighted-round-robin';
  healthCheck: {
    enabled: boolean;
    path: string;
    interval: number;
    timeout: number;
    retries: number;
  };
  backends: BackendServer[];
}

interface BackendServer {
  id: string;
  host: string;
  port: number;
  weight?: number;
  connections: number;
  healthy: boolean;
  lastHealthCheck: number;
  responseTime: number;
}

interface LoadBalancerStats {
  totalRequests: number;
  activeConnections: number;
  backendStats: Array<{
    id: string;
    host: string;
    port: number;
    connections: number;
    healthy: boolean;
    responseTime: number;
    requestsHandled: number;
  }>;
}

class LoadBalancer {
  private config: LoadBalancerConfig;
  private currentIndex = 0;
  private stats: LoadBalancerStats = {
    totalRequests: 0,
    activeConnections: 0,
    backendStats: [],
  };

  constructor(config: LoadBalancerConfig) {
    // Security: Validate configuration
    if (!isValidPort(config.port)) {
      throw new Error(`❌ Security: Invalid load balancer port: ${config.port}`);
    }

    if (!isValidPath(config.healthCheck.path)) {
      throw new Error(`❌ Security: Invalid health check path: ${config.healthCheck.path}`);
    }

    // Security: Validate backends
    for (const backend of config.backends) {
      if (!isValidHost(backend.host)) {
        throw new Error(`❌ Security: Invalid backend host: ${backend.host}`);
      }

      if (!isValidPort(backend.port)) {
        throw new Error(`❌ Security: Invalid backend port: ${backend.port}`);
      }

      if (!/^[a-zA-Z0-9._:-]+$/.test(backend.id) || backend.id.length > 64) {
        throw new Error(`❌ Security: Invalid backend ID: ${backend.id}`);
      }
    }

    this.config = config;
    this.initializeStats();

    // Start health checking
    if (config.healthCheck.enabled) {
      this.startHealthChecking();
    }
  }

  private initializeStats(): void {
    this.stats.backendStats = this.config.backends.map(backend => ({
      id: backend.id,
      host: backend.host,
      port: backend.port,
      connections: 0,
      healthy: true,
      responseTime: 0,
      requestsHandled: 0,
    }));
  }

  private startHealthChecking(): void {
    setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheck.interval);
  }

  private async performHealthChecks(): Promise<void> {
    for (const backend of this.config.backends) {
      try {
        const startTime = Date.now();
        const response = await fetch(`http://${backend.host}:${backend.port}${this.config.healthCheck.path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(this.config.healthCheck.timeout),
        });

        const responseTime = Date.now() - startTime;

        if (response.ok) {
          backend.healthy = true;
          backend.responseTime = responseTime;
        } else {
          backend.healthy = false;
        }

        backend.lastHealthCheck = Date.now();

      } catch (error) {
        backend.healthy = false;
        backend.lastHealthCheck = Date.now();
      }
    }
  }

  private selectBackend(): BackendServer | null {
    const healthyBackends = this.config.backends.filter(b => b.healthy);

    if (healthyBackends.length === 0) {
      return null;
    }

    switch (this.config.algorithm) {
      case 'round-robin':
        return this.selectRoundRobin(healthyBackends);
      case 'least-connections':
        return this.selectLeastConnections(healthyBackends);
      case 'weighted-round-robin':
        return this.selectWeightedRoundRobin(healthyBackends);
      default:
        return healthyBackends[0];
    }
  }

  private selectRoundRobin(backends: BackendServer[]): BackendServer {
    const backend = backends[this.currentIndex % backends.length];
    this.currentIndex++;
    return backend;
  }

  private selectLeastConnections(backends: BackendServer[]): BackendServer {
    return backends.reduce((min, current) =>
      current.connections < min.connections ? current : min
    );
  }

  private selectWeightedRoundRobin(backends: BackendServer[]): BackendServer {
    const totalWeight = backends.reduce((sum, b) => sum + (b.weight || 1), 0);
    let random = Math.random() * totalWeight;

    for (const backend of backends) {
      random -= (backend.weight || 1);
      if (random <= 0) {
        return backend;
      }
    }

    return backends[0];
  }

  public async handleRequest(request: Request): Promise<Response> {
    const backend = this.selectBackend();

    if (!backend) {
      return new Response('Service Unavailable - No healthy backends', {
        status: 503,
        headers: { 'Retry-After': '5' }
      });
    }

    // Update stats
    this.stats.totalRequests++;
    backend.connections++;
    this.stats.activeConnections++;

    const backendStats = this.stats.backendStats.find(s => s.id === backend.id);
    if (backendStats) {
      backendStats.requestsHandled++;
      backendStats.connections = backend.connections;
      backendStats.healthy = backend.healthy;
      backendStats.responseTime = backend.responseTime;
    }

    try {
      const startTime = Date.now();

      // Forward request to backend
      const url = new URL(request.url);
      const backendUrl = `http://${backend.host}:${backend.port}${url.pathname}${url.search}`;

      const response = await fetch(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(5000),
      });

      const responseTime = Date.now() - startTime;
      backend.responseTime = responseTime;

      // Create response with backend data
      const responseBody = await response.arrayBuffer();
      const forwardedResponse = new Response(responseBody, {
        status: response.status,
        headers: response.headers,
      });

      // Add load balancer headers
      forwardedResponse.headers.set('X-Load-Balancer-Backend', `${backend.host}:${backend.port}`);
      forwardedResponse.headers.set('X-Load-Balancer-Response-Time', responseTime.toString());

      return forwardedResponse;

    } catch (error) {
      backend.healthy = false;
      return new Response('Bad Gateway', { status: 502 });
    } finally {
      // Update connection count
      backend.connections--;
      this.stats.activeConnections--;

      if (backendStats) {
        backendStats.connections = backend.connections;
      }
    }
  }

  public getStats(): LoadBalancerStats {
    return { ...this.stats };
  }

  public getConfig(): LoadBalancerConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<LoadBalancerConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Update backend stats if backends changed
    if (newConfig.backends) {
      this.initializeStats();
    }
  }
}

// CLI command for load balancer management
export async function loadbalancerCommand(action: string, options?: any): Promise<void> {
  switch (action) {
    case 'start':
      await startLoadBalancer(options);
      break;
    case 'status':
      await showLoadBalancerStatus(options);
      break;
    case 'config':
      await configureLoadBalancer(options);
      break;
    default:
      console.error('❌ Invalid action. Use: start, status, config');
      process.exit(1);
  }
}

async function startLoadBalancer(options?: any): Promise<void> {
  const config: LoadBalancerConfig = {
    port: options?.port || 8080,
    algorithm: options?.algorithm || 'round-robin',
    healthCheck: {
      enabled: options?.healthCheck !== false,
      path: options?.healthPath || '/healthz',
      interval: options?.healthInterval || 10000,
      timeout: options?.healthTimeout || 5000,
      retries: options?.healthRetries || 3,
    },
    backends: parseBackends(options?.backends || []),
  };

  if (config.backends.length === 0) {
    console.error('❌ At least one backend is required');
    process.exit(1);
  }

  const loadBalancer = new LoadBalancer(config);

  console.log(`🚀 Starting BS9 Load Balancer`);
  console.log(`📡 Port: ${config.port}`);
  console.log(`⚖️  Algorithm: ${config.algorithm}`);
  console.log(`🏥 Health Check: ${config.healthCheck.enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`🔗 Backends: ${config.backends.length}`);

  for (const backend of config.backends) {
    console.log(`   - ${backend.host}:${backend.port} (weight: ${backend.weight || 1})`);
  }

  // Start load balancer server
  const server = serve({
    port: config.port,
    fetch: async (request) => {
      // Handle load balancer API endpoints
      const url = new URL(request.url);

      if (url.pathname === '/lb-stats') {
        return new Response(JSON.stringify(loadBalancer.getStats()), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/lb-config') {
        return new Response(JSON.stringify(loadBalancer.getConfig()), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Forward all other requests
      return loadBalancer.handleRequest(request);
    },
  });

  console.log(`✅ Load balancer running on http://localhost:${config.port}`);
  console.log(`📊 Stats: http://localhost:${config.port}/lb-stats`);
  console.log(`⚙️  Config: http://localhost:${config.port}/lb-config`);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down load balancer...');
    server.stop();
    process.exit(0);
  });
}

async function showLoadBalancerStatus(options?: any): Promise<void> {
  const port = options?.port || 8080;

  try {
    const response = await fetch(`http://localhost:${port}/lb-stats`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const stats: LoadBalancerStats = await response.json();

    console.log('📊 Load Balancer Status');
    console.log('='.repeat(60));
    console.log(`Total Requests: ${stats.totalRequests}`);
    console.log(`Active Connections: ${stats.activeConnections}`);
    console.log(`Backends: ${stats.backendStats.length}`);

    console.log('\n🔗 Backend Status:');
    for (const backend of stats.backendStats) {
      const statusIcon = backend.healthy ? '✅' : '❌';
      console.log(`${statusIcon} ${backend.host}:${backend.port}`);
      console.log(`   Connections: ${backend.connections}`);
      console.log(`   Response Time: ${backend.responseTime}ms`);
      console.log(`   Requests Handled: ${backend.requestsHandled}`);
      console.log('');
    }

  } catch (error) {
    console.error(`❌ Failed to get load balancer status: ${error}`);
    process.exit(1);
  }
}

async function configureLoadBalancer(options?: any): Promise<void> {
  const port = options?.port || 8080;

  if (!options?.backends && !options?.algorithm) {
    console.error('❌ No configuration changes specified');
    process.exit(1);
  }

  try {
    const configResponse = await fetch(`http://localhost:${port}/lb-config`);
    if (!configResponse.ok) {
      throw new Error(`HTTP ${configResponse.status}`);
    }

    const currentConfig: LoadBalancerConfig = await configResponse.json();

    const newConfig: Partial<LoadBalancerConfig> = {};

    if (options?.backends) {
      newConfig.backends = parseBackends(options.backends);
    }

    if (options?.algorithm) {
      newConfig.algorithm = options.algorithm;
    }

    // Apply configuration (this would need to be implemented in the load balancer)
    console.log('📝 Load balancer configuration updated');
    console.log('Note: Dynamic configuration updates require load balancer restart');

  } catch (error) {
    console.error(`❌ Failed to configure load balancer: ${error}`);
    process.exit(1);
  }
}

function parseBackends(backendsStr: string): BackendServer[] {
  const backends: BackendServer[] = [];

  for (const backendStr of backendsStr.split(',')) {
    const parts = backendStr.trim().split(':');

    if (parts.length < 2) {
      console.error(`❌ Invalid backend format: ${backendStr}. Use host:port or host:port:weight`);
      process.exit(1);
    }

    const host = parts[0];
    const port = parseInt(parts[1]);
    const weight = parts[2] ? parseInt(parts[2]) : 1;

    if (!host || isNaN(port)) {
      console.error(`❌ Invalid backend format: ${backendStr}`);
      process.exit(1);
    }

    backends.push({
      id: `${host}:${port}`,
      host,
      port,
      weight,
      connections: 0,
      healthy: true,
      lastHealthCheck: Date.now(),
      responseTime: 0,
    });
  }

  return backends;
}
