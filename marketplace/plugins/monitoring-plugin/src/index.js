#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { Plugin } from 'bs9-core';
import { register, collectDefaultMetrics, Registry } from 'prom-client';
import si from 'systeminformation';

export default class MonitoringPlugin extends Plugin {
  constructor() {
    super({
      name: 'bs9-monitoring-plugin',
      version: '1.0.0',
      description: 'Advanced monitoring and metrics plugin for BS9'
    });
    
    this.metricsRegistry = new Registry();
    this.metrics = {};
    this.intervalId = null;
    this.config = {
      interval: 30000, // 30 seconds
      enabledMetrics: ['cpu', 'memory', 'disk', 'network'],
      prometheus: {
        enabled: true,
        port: 9090
      },
      alerts: {
        enabled: true,
        thresholds: {
          cpu: 80,
          memory: 85,
          disk: 90
        }
      }
    };
  }

  async initialize() {
    console.log('🔍 BS9 Monitoring Plugin initialized');
    
    // Initialize metrics
    this.initializeMetrics();
    
    // Start metrics collection
    this.startMetricsCollection();
    
    // Start Prometheus server if enabled
    if (this.config.prometheus.enabled) {
      this.startPrometheusServer();
    }
    
    console.log(`✅ Monitoring started with ${this.config.interval/1000}s interval`);
  }

  initializeMetrics() {
    // Service metrics
    this.metrics.serviceUptime = new register.Gauge({
      name: 'bs9_service_uptime_seconds',
      help: 'Service uptime in seconds',
      labelNames: ['service']
    });

    this.metrics.serviceMemoryUsage = new register.Gauge({
      name: 'bs9_service_memory_bytes',
      help: 'Service memory usage in bytes',
      labelNames: ['service', 'type']
    });

    this.metrics.serviceCpuUsage = new register.Gauge({
      name: 'bs9_service_cpu_percent',
      help: 'Service CPU usage percentage',
      labelNames: ['service']
    });

    this.metrics.serviceRestarts = new register.Counter({
      name: 'bs9_service_restarts_total',
      help: 'Total number of service restarts',
      labelNames: ['service']
    });

    // System metrics
    this.metrics.systemCpuUsage = new register.Gauge({
      name: 'bs9_system_cpu_percent',
      help: 'System CPU usage percentage'
    });

    this.metrics.systemMemoryUsage = new register.Gauge({
      name: 'bs9_system_memory_bytes',
      help: 'System memory usage in bytes',
      labelNames: ['type']
    });

    this.metrics.systemDiskUsage = new register.Gauge({
      name: 'bs9_system_disk_bytes',
      help: 'System disk usage in bytes',
      labelNames: ['mount', 'type']
    });

    this.metrics.systemNetworkIO = new register.Counter({
      name: 'bs9_system_network_bytes_total',
      help: 'System network I/O in bytes',
      labelNames: ['interface', 'direction']
    });

    // Register default metrics
    collectDefaultMetrics({ register: this.metricsRegistry });
  }

  async startMetricsCollection() {
    this.intervalId = setInterval(async () => {
      try {
        await this.collectMetrics();
      } catch (error) {
        console.error('❌ Error collecting metrics:', error);
      }
    }, this.config.interval);
  }

  async collectMetrics() {
    // Collect service metrics
    await this.collectServiceMetrics();
    
    // Collect system metrics
    if (this.config.enabledMetrics.includes('cpu')) {
      await this.collectCpuMetrics();
    }
    
    if (this.config.enabledMetrics.includes('memory')) {
      await this.collectMemoryMetrics();
    }
    
    if (this.config.enabledMetrics.includes('disk')) {
      await this.collectDiskMetrics();
    }
    
    if (this.config.enabledMetrics.includes('network')) {
      await this.collectNetworkMetrics();
    }
  }

  async collectServiceMetrics() {
    try {
      const services = await this.bs9.services.list();
      
      for (const service of services) {
        // Service uptime
        if (service.uptime) {
          this.metrics.serviceUptime.set({ service: service.name }, service.uptime);
        }
        
        // Service memory usage
        if (service.memory) {
          this.metrics.serviceMemoryUsage.set({ service: service.name, type: 'rss' }, service.memory.rss || 0);
          this.metrics.serviceMemoryUsage.set({ service: service.name, type: 'heap' }, service.memory.heapUsed || 0);
        }
        
        // Service CPU usage
        if (service.cpu) {
          this.metrics.serviceCpuUsage.set({ service: service.name }, service.cpu);
        }
        
        // Service restarts
        if (service.restarts) {
          this.metrics.serviceRestarts.set({ service: service.name }, service.restarts);
        }
      }
    } catch (error) {
      console.error('❌ Error collecting service metrics:', error);
    }
  }

  async collectCpuMetrics() {
    try {
      const cpuData = await si.currentLoad();
      this.metrics.systemCpuUsage.set(cpuData.currentLoad);
      
      // Check CPU alert threshold
      if (this.config.alerts.enabled && cpuData.currentLoad > this.config.alerts.thresholds.cpu) {
        this.triggerAlert('cpu', `CPU usage is ${cpuData.currentLoad.toFixed(2)}%`);
      }
    } catch (error) {
      console.error('❌ Error collecting CPU metrics:', error);
    }
  }

  async collectMemoryMetrics() {
    try {
      const memData = await si.mem();
      this.metrics.systemMemoryUsage.set({ type: 'total' }, memData.total);
      this.metrics.systemMemoryUsage.set({ type: 'used' }, memData.used);
      this.metrics.systemMemoryUsage.set({ type: 'free' }, memData.free);
      
      // Check memory alert threshold
      const memoryUsagePercent = (memData.used / memData.total) * 100;
      if (this.config.alerts.enabled && memoryUsagePercent > this.config.alerts.thresholds.memory) {
        this.triggerAlert('memory', `Memory usage is ${memoryUsagePercent.toFixed(2)}%`);
      }
    } catch (error) {
      console.error('❌ Error collecting memory metrics:', error);
    }
  }

  async collectDiskMetrics() {
    try {
      const diskData = await si.fsSize();
      
      for (const disk of diskData) {
        this.metrics.systemDiskUsage.set({ mount: disk.mount, type: 'total' }, disk.size);
        this.metrics.systemDiskUsage.set({ mount: disk.mount, type: 'used' }, disk.used);
        this.metrics.systemDiskUsage.set({ mount: disk.mount, type: 'available' }, disk.available);
        
        // Check disk alert threshold
        const diskUsagePercent = (disk.used / disk.size) * 100;
        if (this.config.alerts.enabled && diskUsagePercent > this.config.alerts.thresholds.disk) {
          this.triggerAlert('disk', `Disk usage on ${disk.mount} is ${diskUsagePercent.toFixed(2)}%`);
        }
      }
    } catch (error) {
      console.error('❌ Error collecting disk metrics:', error);
    }
  }

  async collectNetworkMetrics() {
    try {
      const networkData = await si.networkStats();
      
      for (const network of networkData) {
        this.metrics.systemNetworkIO.set({ interface: network.iface, direction: 'rx' }, network.rx_bytes);
        this.metrics.systemNetworkIO.set({ interface: network.iface, direction: 'tx' }, network.tx_bytes);
      }
    } catch (error) {
      console.error('❌ Error collecting network metrics:', error);
    }
  }

  async startPrometheusServer() {
    const { serve } = await import('bun');
    
    serve({
      port: this.config.prometheus.port,
      fetch: async (req) => {
        const url = new URL(req.url);
        
        if (url.pathname === '/metrics') {
          const metrics = await this.metricsRegistry.metrics();
          return new Response(metrics, {
            headers: { 'Content-Type': 'text/plain' }
          });
        }
        
        return new Response('BS9 Monitoring Plugin', {
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    });
    
    console.log(`📊 Prometheus metrics server started on port ${this.config.prometheus.port}`);
  }

  triggerAlert(type, message) {
    console.log(`🚨 ALERT [${type.toUpperCase()}]: ${message}`);
    
    // Here you could integrate with external alerting systems
    // like Slack, email, Discord, etc.
  }

  // Plugin hooks
  async onServiceStart(service) {
    console.log(`🔍 Monitoring service start: ${service.name}`);
    // Additional monitoring logic when service starts
  }

  async onServiceStop(service) {
    console.log(`🔍 Monitoring service stop: ${service.name}`);
    // Additional monitoring logic when service stops
  }

  async onServiceRestart(service) {
    console.log(`🔍 Monitoring service restart: ${service.name}`);
    // Additional monitoring logic when service restarts
  }

  async onServiceStatus(service) {
    console.log(`🔍 Monitoring service status: ${service.name}`);
    // Additional monitoring logic when service status changes
  }

  // Plugin commands
  registerCommands() {
    return [
      {
        name: 'monitor',
        description: 'Advanced monitoring commands',
        handler: this.handleMonitorCommand.bind(this)
      },
      {
        name: 'metrics',
        description: 'Metrics collection and analysis',
        handler: this.handleMetricsCommand.bind(this)
      }
    ];
  }

  async handleMonitorCommand(args, options) {
    const subcommand = args[0];
    
    switch (subcommand) {
      case 'status':
        return await this.showMonitorStatus();
      case 'start':
        return await this.startMonitoring();
      case 'stop':
        return await this.stopMonitoring();
      case 'config':
        return await this.showConfig();
      default:
        return await this.showHelp();
    }
  }

  async handleMetricsCommand(args, options) {
    const subcommand = args[0];
    
    switch (subcommand) {
      case 'show':
        return await this.showMetrics();
      case 'export':
        return await this.exportMetrics(args[1]);
      case 'reset':
        return await this.resetMetrics();
      default:
        return await this.showMetricsHelp();
    }
  }

  async showMonitorStatus() {
    const status = {
      enabled: this.intervalId !== null,
      interval: this.config.interval,
      metrics: this.config.enabledMetrics,
      prometheus: this.config.prometheus.enabled,
      alerts: this.config.alerts.enabled
    };
    
    return {
      success: true,
      data: status
    };
  }

  async startMonitoring() {
    if (this.intervalId) {
      return { success: false, message: 'Monitoring already started' };
    }
    
    await this.startMetricsCollection();
    return { success: true, message: 'Monitoring started' };
  }

  async stopMonitoring() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      return { success: true, message: 'Monitoring stopped' };
    }
    
    return { success: false, message: 'Monitoring not running' };
  }

  async showConfig() {
    return {
      success: true,
      data: this.config
    };
  }

  async showMetrics() {
    try {
      const metrics = await this.metricsRegistry.getMetricsAsJSON();
      return {
        success: true,
        data: metrics
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async exportMetrics(format = 'json') {
    try {
      const metrics = await this.metricsRegistry.metrics();
      
      if (format === 'prometheus') {
        return {
          success: true,
          data: metrics
        };
      } else {
        const jsonMetrics = await this.metricsRegistry.getMetricsAsJSON();
        return {
          success: true,
          data: jsonMetrics
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async resetMetrics() {
    try {
      this.metricsRegistry.reset();
      return { success: true, message: 'Metrics reset' };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async showHelp() {
    return {
      success: true,
      message: `
BS9 Monitoring Plugin Commands:

monitor status     - Show monitoring status
monitor start      - Start monitoring
monitor stop       - Stop monitoring
monitor config     - Show configuration

metrics show       - Show current metrics
metrics export     - Export metrics (json|prometheus)
metrics reset      - Reset metrics
      `
    };
  }

  async showMetricsHelp() {
    return {
      success: true,
      message: `
BS9 Metrics Commands:

metrics show       - Show current metrics
metrics export     - Export metrics (json|prometheus)
metrics reset      - Reset metrics
      `
    };
  }

  async cleanup() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    console.log('🔍 BS9 Monitoring Plugin cleaned up');
  }
}
