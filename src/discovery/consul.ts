#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync } from "node:child_process";

interface ConsulService {
  ID: string;
  Name: string;
  Tags: string[];
  Address: string;
  Port: number;
  EnableTagOverride: boolean;
  Meta: Record<string, string>;
}

interface ConsulHealthCheck {
  HTTP?: string;
  TCP?: string;
  Interval: string;
  Timeout: string;
  DeregisterCriticalServiceAfter: string;
}

interface ConsulRegistration {
  Name: string;
  ID: string;
  Tags: string[];
  Address: string;
  Port: number;
  EnableTagOverride: boolean;
  Check: ConsulHealthCheck;
  Meta?: Record<string, string>;
}

class ConsulServiceDiscovery {
  private consulUrl: string;
  private serviceName: string = '';
  private serviceId: string = '';
  private registeredServices: Map<string, ConsulService> = new Map();
  
  constructor(consulUrl: string = 'http://localhost:8500') {
    this.consulUrl = consulUrl;
  }
  
  async registerService(config: {
    name: string;
    id: string;
    address: string;
    port: number;
    tags?: string[];
    healthCheck?: string;
    meta?: Record<string, string>;
  }): Promise<void> {
    const registration: ConsulRegistration = {
      Name: config.name,
      ID: config.id,
      Tags: config.tags || ['bs9', 'service'],
      Address: config.address,
      Port: config.port,
      EnableTagOverride: false,
      Check: {
        HTTP: config.healthCheck || `http://${config.address}:${config.port}/healthz`,
        Interval: '10s',
        Timeout: '5s',
        DeregisterCriticalServiceAfter: '30s'
      },
      Meta: config.meta || {}
    };
    
    try {
      const response = await fetch(`${this.consulUrl}/v1/agent/service/register`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registration)
      });
      
      if (response.ok) {
        console.log(`✅ Service ${config.name} registered with Consul`);
        this.registeredServices.set(config.id, {
          ID: config.id,
          Name: config.name,
          Tags: registration.Tags,
          Address: config.address,
          Port: config.port,
          EnableTagOverride: registration.EnableTagOverride,
          Meta: registration.Meta || {}
        });
      } else {
        throw new Error(`Failed to register service: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`❌ Consul registration failed: ${error}`);
      throw error;
    }
  }
  
  async deregisterService(serviceId: string): Promise<void> {
    try {
      const response = await fetch(`${this.consulUrl}/v1/agent/service/deregister/${serviceId}`, {
        method: 'PUT'
      });
      
      if (response.ok) {
        console.log(`✅ Service ${serviceId} deregistered from Consul`);
        this.registeredServices.delete(serviceId);
      } else {
        throw new Error(`Failed to deregister service: ${response.statusText}`);
      }
    } catch (error) {
      console.error(`❌ Consul deregistration failed: ${error}`);
      throw error;
    }
  }
  
  async discoverServices(serviceName?: string): Promise<ConsulService[]> {
    try {
      let url = `${this.consulUrl}/v1/agent/services`;
      if (serviceName) {
        url += `?service=${serviceName}`;
      }
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to discover services: ${response.statusText}`);
      }
      
      const services: Record<string, ConsulService> = await response.json();
      return Object.values(services).filter(service => 
        service.Tags.includes('bs9')
      );
    } catch (error) {
      console.error(`❌ Service discovery failed: ${error}`);
      return [];
    }
  }
  
  async getServiceHealth(serviceName: string): Promise<any[]> {
    try {
      const response = await fetch(`${this.consulUrl}/v1/health/service/${serviceName}`);
      if (!response.ok) {
        throw new Error(`Failed to get service health: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error(`❌ Health check failed: ${error}`);
      return [];
    }
  }
  
  async watchService(serviceName: string, callback: (services: ConsulService[]) => void): Promise<void> {
    let lastServices: ConsulService[] = [];
    
    const checkServices = async () => {
      try {
        const services = await this.discoverServices(serviceName);
        
        // Check if services have changed
        const servicesChanged = JSON.stringify(services) !== JSON.stringify(lastServices);
        
        if (servicesChanged) {
          callback(services);
          lastServices = services;
        }
      } catch (error) {
        console.error(`❌ Service watch error: ${error}`);
      }
    };
    
    // Initial check
    await checkServices();
    
    // Set up periodic checking
    setInterval(checkServices, 5000);
  }
  
  getRegisteredServices(): ConsulService[] {
    return Array.from(this.registeredServices.values());
  }
  
  async isConsulAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.consulUrl}/v1/status/leader`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export async function consulCommand(action: string, options: any): Promise<void> {
  const consul = new ConsulServiceDiscovery(options.consulUrl);
  
  try {
    switch (action) {
      case 'register':
        if (!options.name || !options.id || !options.address || !options.port) {
          console.error('❌ --name, --id, --address, and --port are required for register');
          process.exit(1);
        }
        
        await consul.registerService({
          name: options.name,
          id: options.id,
          address: options.address,
          port: parseInt(options.port),
          tags: options.tags ? options.tags.split(',') : undefined,
          healthCheck: options.healthCheck,
          meta: options.meta ? JSON.parse(options.meta) : undefined
        });
        break;
        
      case 'deregister':
        if (!options.id) {
          console.error('❌ --id is required for deregister');
          process.exit(1);
        }
        await consul.deregisterService(options.id);
        break;
        
      case 'discover':
        const services = await consul.discoverServices(options.service);
        console.log('🔍 Discovered Services:');
        console.log('='.repeat(50));
        
        if (services.length === 0) {
          console.log('No BS9 services found in Consul');
        } else {
          services.forEach(service => {
            console.log(`📦 ${service.Name} (${service.ID})`);
            console.log(`   Address: ${service.Address}:${service.Port}`);
            console.log(`   Tags: ${service.Tags.join(', ')}`);
            console.log(`   Health: ${service.Meta?.health || 'unknown'}`);
            console.log('');
          });
        }
        break;
        
      case 'health':
        if (!options.service) {
          console.error('❌ --service is required for health check');
          process.exit(1);
        }
        
        const health = await consul.getServiceHealth(options.service);
        console.log(`🏥 Health Status for ${options.service}:`);
        console.log('='.repeat(50));
        
        if (health.length === 0) {
          console.log('No health information available');
        } else {
          health.forEach(check => {
            const status = check.Checks?.[0]?.Status || 'unknown';
            const output = check.Checks?.[0]?.Output || 'No output';
            
            console.log(`📦 ${check.Service.ID}`);
            console.log(`   Status: ${status}`);
            console.log(`   Node: ${check.Node.Node}`);
            console.log(`   Address: ${check.Service.Address}:${check.Service.Port}`);
            console.log(`   Output: ${output}`);
            console.log('');
          });
        }
        break;
        
      case 'status':
        const available = await consul.isConsulAvailable();
        if (available) {
          console.log('✅ Consul is available');
          console.log(`   URL: ${options.consulUrl || 'http://localhost:8500'}`);
        } else {
          console.log('❌ Consul is not available');
          console.log(`   URL: ${options.consulUrl || 'http://localhost:8500'}`);
        }
        break;
        
      default:
        console.error(`❌ Unknown action: ${action}`);
        console.log('Available actions: register, deregister, discover, health, status');
        process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Consul command failed: ${error}`);
    process.exit(1);
  }
}
