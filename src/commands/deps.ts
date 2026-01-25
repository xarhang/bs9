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

interface DepOptions {
  format?: string;
  output?: string;
}

interface ServiceDependency {
  name: string;
  dependsOn: string[];
  status: 'running' | 'stopped' | 'failed' | 'unknown';
  health: 'healthy' | 'unhealthy' | 'unknown';
  port?: number;
  endpoints: string[];
}

interface DependencyGraph {
  services: ServiceDependency[];
  edges: Array<{
    from: string;
    to: string;
    type: 'http' | 'database' | 'message' | 'custom';
  }>;
}

export async function depsCommand(options: DepOptions): Promise<void> {
  console.log('🔗 BS9 Service Dependency Visualization');
  console.log('='.repeat(80));
  
  try {
    const graph = await buildDependencyGraph();
    
    if (options.format === 'dot') {
      const dotOutput = generateDotGraph(graph);
      if (options.output) {
        await Bun.write(options.output, dotOutput);
        console.log(`✅ Dependency graph saved to: ${options.output}`);
      } else {
        console.log(dotOutput);
      }
    } else if (options.format === 'json') {
      const jsonOutput = JSON.stringify(graph, null, 2);
      if (options.output) {
        await Bun.write(options.output, jsonOutput);
        console.log(`✅ Dependency graph saved to: ${options.output}`);
      } else {
        console.log(jsonOutput);
      }
    } else {
      displayDependencyGraph(graph);
    }
    
  } catch (error) {
    console.error(`❌ Failed to analyze dependencies: ${error}`);
    process.exit(1);
  }
}

async function buildDependencyGraph(): Promise<DependencyGraph> {
  const services: ServiceDependency[] = [];
  const edges: Array<{from: string; to: string; type: 'http' | 'database' | 'message' | 'custom'}> = [];
  
  try {
    // Get all BS9 services
    const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
    const lines = listOutput.split("\n").filter(line => line.includes(".service"));
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
      if (!match) continue;
      
      const [, statusIndicator, name, loaded, active, sub, description] = match;
      
      if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;
      
      const service: ServiceDependency = {
        name,
        dependsOn: [],
        status: getServiceStatus(active, sub),
        health: 'unknown',
        endpoints: [],
      };
      
      // Extract port from description
      const portMatch = description.match(/port[=:]?\s*(\d+)/i);
      if (portMatch) {
        service.port = Number(portMatch[1]);
      }
      
      // Analyze service for dependencies
      const deps = await analyzeServiceDependencies(name, service.port);
      service.dependsOn = deps.dependsOn;
      service.endpoints = deps.endpoints;
      
      services.push(service);
      
      // Add edges to graph
      for (const dep of deps.dependsOn) {
        edges.push({
          from: name,
          to: dep,
          type: deps.type,
        });
      }
    }
    
  } catch (error) {
    console.error('Error fetching services:', error);
  }
  
  return { services, edges };
}

async function analyzeServiceDependencies(serviceName: string, port?: number): Promise<{
  dependsOn: string[];
  endpoints: string[];
  type: 'http' | 'database' | 'message' | 'custom';
}> {
  const dependsOn: string[] = [];
  const endpoints: string[] = [];
  let type: 'http' | 'database' | 'message' | 'custom' = 'custom';
  
  try {
    // Check if service has health endpoints
    if (port) {
      endpoints.push(`http://localhost:${port}/healthz`);
      endpoints.push(`http://localhost:${port}/readyz`);
      endpoints.push(`http://localhost:${port}/metrics`);
      
      // Check for common dependency patterns
      try {
        const response = Bun.fetch(`http://localhost:${port}/dependencies`, { timeout: 1000 });
        if (response.ok) {
          const deps = await response.json();
          if (Array.isArray(deps)) {
            dependsOn.push(...deps);
            type = 'http';
          }
        }
      } catch {
        // Service doesn't expose dependencies endpoint
      }
    }
    
    // Analyze service files for dependency patterns
    try {
      const servicePath = `/home/xarhang/.config/systemd/user/${serviceName}.service`;
      const serviceContent = Bun.file(servicePath).text();
      
      // Look for environment variables that suggest dependencies
      const envMatches = serviceContent.match(/Environment=([^\n]+)/g) || [];
      for (const env of envMatches) {
        if (env.includes('DATABASE_URL') || env.includes('DB_HOST')) {
          dependsOn.push('database');
          type = 'database';
        }
        if (env.includes('REDIS_URL') || env.includes('REDIS_HOST')) {
          dependsOn.push('redis');
          type = 'message';
        }
        if (env.includes('API_URL') || env.includes('SERVICE_URL')) {
          const urlMatch = env.match(/https?:\/\/([^:\/]+)/);
          if (urlMatch) {
            dependsOn.push(urlMatch[1]);
            type = 'http';
          }
        }
      }
    } catch {
      // Service file not accessible
    }
    
  } catch (error) {
    console.error(`Error analyzing dependencies for ${serviceName}:`, error);
  }
  
  return { dependsOn, endpoints, type };
}

function getServiceStatus(active: string, sub: string): 'running' | 'stopped' | 'failed' | 'unknown' {
  if (active === 'active' && sub === 'running') return 'running';
  if (active === 'inactive') return 'stopped';
  if (active === 'failed' || sub === 'failed') return 'failed';
  return 'unknown';
}

function displayDependencyGraph(graph: DependencyGraph): void {
  console.log('\n📊 Service Dependencies:');
  console.log('-'.repeat(60));
  
  for (const service of graph.services) {
    const statusIcon = getStatusIcon(service.status);
    const healthIcon = getHealthIcon(service.health);
    
    console.log(`${statusIcon} ${service.name} ${healthIcon}`);
    
    if (service.dependsOn.length > 0) {
      console.log(`   └─ Depends on: ${service.dependsOn.join(', ')}`);
    }
    
    if (service.endpoints.length > 0) {
      console.log(`   └─ Endpoints: ${service.endpoints.slice(0, 2).join(', ')}${service.endpoints.length > 2 ? '...' : ''}`);
    }
    
    console.log('');
  }
  
  console.log('\n🔗 Dependency Relationships:');
  console.log('-'.repeat(60));
  
  if (graph.edges.length === 0) {
    console.log('No dependencies found between services.');
  } else {
    for (const edge of graph.edges) {
      const fromService = graph.services.find(s => s.name === edge.from);
      const toService = graph.services.find(s => s.name === edge.to);
      
      const fromIcon = fromService ? getStatusIcon(fromService.status) : '❓';
      const toIcon = toService ? getStatusIcon(toService.status) : '❓';
      
      console.log(`${fromIcon} ${edge.from} → ${edge.to} ${toIcon} (${edge.type})`);
    }
  }
  
  console.log('\n📈 Summary:');
  console.log(`   Total Services: ${graph.services.length}`);
  console.log(`   Dependencies: ${graph.edges.length}`);
  console.log(`   Running: ${graph.services.filter(s => s.status === 'running').length}`);
  console.log(`   Failed: ${graph.services.filter(s => s.status === 'failed').length}`);
}

function generateDotGraph(graph: DependencyGraph): string {
  let dot = 'digraph BS9_Dependencies {\n';
  dot += '  rankdir=LR;\n';
  dot += '  node [shape=box, style=filled];\n\n';
  
  // Add nodes
  for (const service of graph.services) {
    const color = getNodeColor(service.status);
    const label = `${service.name}\\n${service.status}`;
    dot += `  "${service.name}" [label="${label}", fillcolor="${color}"];\n`;
  }
  
  dot += '\n';
  
  // Add edges
  for (const edge of graph.edges) {
    const color = getEdgeColor(edge.type);
    dot += `  "${edge.from}" -> "${edge.to}" [color="${color}", label="${edge.type}"];\n`;
  }
  
  dot += '}\n';
  
  return dot;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'running': return '✅';
    case 'stopped': return '⏸️';
    case 'failed': return '❌';
    default: return '❓';
  }
}

function getHealthIcon(health: string): string {
  switch (health) {
    case 'healthy': return '🟢';
    case 'unhealthy': return '🔴';
    default: return '⚪';
  }
}

function getNodeColor(status: string): string {
  switch (status) {
    case 'running': return 'lightgreen';
    case 'stopped': return 'lightgray';
    case 'failed': return 'lightcoral';
    default: return 'lightyellow';
  }
}

function getEdgeColor(type: string): string {
  switch (type) {
    case 'http': return 'blue';
    case 'database': return 'green';
    case 'message': return 'orange';
    default: return 'gray';
  }
}
