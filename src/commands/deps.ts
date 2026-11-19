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
import { getPlatformInfo, PlatformInfo } from "../platform/detect.js";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

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

function resolveSafeOutputPath(outputPath: string): string {
  if (!outputPath || outputPath.includes("\0")) {
    throw new Error("Invalid output file path");
  }
  const resolved = resolve(outputPath);
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Security: Refusing to write through symbolic link '${outputPath}'`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const parentDir = dirname(resolved);
  const realParent = existsSync(parentDir) ? realpathSync(parentDir) : parentDir;
  const realTarget = existsSync(resolved) ? realpathSync(resolved) : join(realParent, resolved.slice(parentDir.length + (parentDir.endsWith(sep) ? 0 : 1)));
  const allowedRoots = [resolve(process.cwd()), resolve(homedir()), resolve(tmpdir())].map((r) =>
    existsSync(r) ? realpathSync(r) : r
  );
  const isContained = allowedRoots.some((root) => realTarget === root || realTarget.startsWith(root + sep));
  if (!isContained) {
    throw new Error(`Security: Output path '${outputPath}' is outside allowed directories`);
  }
  return resolved;
}

export async function depsCommand(options: DepOptions): Promise<void> {
  console.log('🔗 BS9 Service Dependency Visualization');
  console.log('='.repeat(80));

  try {
    const graph = await buildDependencyGraph();

    if (options.format === 'dot') {
      const dotOutput = generateDotGraph(graph);
      if (options.output) {
        const safeOut = resolveSafeOutputPath(options.output);
        await Bun.write(safeOut, dotOutput);
        console.log(`✅ Dependency graph saved to: ${safeOut}`);
      } else {
        console.log(dotOutput);
      }
    } else if (options.format === 'json') {
      const jsonOutput = JSON.stringify(graph, null, 2);
      if (options.output) {
        const safeOut = resolveSafeOutputPath(options.output);
        await Bun.write(safeOut, jsonOutput);
        console.log(`✅ Dependency graph saved to: ${safeOut}`);
      } else {
        console.log(jsonOutput);
      }
    } else {
      displayDependencyGraph(graph);
    }

  } catch (error) {
    console.error(`❌ Failed to analyze dependencies: ${error}`);
    process.exitCode = 1;
    return;
  }
}

async function buildDependencyGraph(): Promise<DependencyGraph> {
  const services: ServiceDependency[] = [];
  const edges: Array<{ from: string; to: string; type: 'http' | 'database' | 'message' | 'custom' }> = [];
  const platformInfo = getPlatformInfo();

  try {
    if (platformInfo.isWindows) {
      const { WindowsServiceManager } = await import("../windows/service.js");
      const manager = new WindowsServiceManager();
      const winServices = await manager.listServices();

      for (const svc of winServices) {
        const service: ServiceDependency = {
          name: svc.name,
          dependsOn: [],
          status: svc.state === 'running' ? 'running' : 'stopped',
          health: 'unknown',
          endpoints: [],
        };

        const deps = await analyzeServiceDependencies(svc.name, platformInfo);
        service.dependsOn = deps.dependencies.map(d => d.target);
        service.endpoints = deps.endpoints;

        services.push(service);

        for (const dep of deps.dependencies) {
          edges.push({ from: svc.name, to: dep.target, type: dep.type });
        }
      }
    } else {
      // Linux/macOS path
      const listCmd = platformInfo.isLinux
        ? "systemctl --user list-units --type=service --no-pager --no-legend"
        : "launchctl list";

      try {
        const listOutput = execSync(listCmd, { encoding: "utf-8", windowsHide: true });
        const lines = listOutput.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          if (!platformInfo.isLinux && !line.includes("bs9")) continue;

          let name = "";
          let active = "";
          let sub = "";
          let description = "";

          if (platformInfo.isLinux) {
            const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
            if (!match) continue;
            [, , name, , active, sub, description] = match;
            if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;
          } else {
            // MacOS launchctl list parsing
            const parts = line.split(/\s+/);
            name = parts[parts.length - 1];
            active = "active";
            sub = "running";
          }

          const service: ServiceDependency = {
            name,
            dependsOn: [],
            status: getServiceStatus(active, sub),
            health: 'unknown',
            endpoints: [],
          };

          const deps = await analyzeServiceDependencies(name, platformInfo);
          service.dependsOn = deps.dependencies.map(d => d.target);
          service.endpoints = deps.endpoints;

          services.push(service);

          for (const dep of deps.dependencies) {
            edges.push({ from: name, to: dep.target, type: dep.type });
          }
        }
      } catch (err) {
        console.error('Error fetching services:', err);
      }
    }

  } catch (error) {
    console.error('Error in buildDependencyGraph:', error);
  }

  return { services, edges };
}

async function analyzeServiceDependencies(serviceName: string, platformInfo: PlatformInfo): Promise<{
  dependencies: Array<{ target: string; type: 'http' | 'database' | 'message' | 'custom' }>;
  endpoints: string[];
}> {
  const dependencies: Array<{ target: string; type: 'http' | 'database' | 'message' | 'custom' }> = [];
  const endpoints: string[] = [];

  try {
    // Try to find environment variables in service config file
    let serviceContent = "";
    if (platformInfo.isLinux) {
      const servicePath = join(platformInfo.serviceDir, `${serviceName}.service`);
      if (existsSync(servicePath)) serviceContent = readFileSync(servicePath, "utf-8");
    } else if (platformInfo.isWindows) {
      // For Windows, we might store this in windows-services.json
      const configPath = join(process.env.USERPROFILE || "", '.bs9', 'windows-services.json');
      if (existsSync(configPath)) {
        const configs = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (configs[serviceName]) {
          const env = configs[serviceName].environment || {};
          serviceContent = Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join("\n");
        }
      }
    }

    if (serviceContent) {
      // Extract port
      const portMatch = serviceContent.match(/PORT=(\d+)/i);
      if (portMatch) {
        const port = Number(portMatch[1]);
        endpoints.push(`http://localhost:${port}/healthz`);
        endpoints.push(`http://localhost:${port}/metrics`);
      }

      // Look for environment variables that suggest dependencies
      const envMatches = serviceContent.match(/Environment=([^\n]+)/g) || [];
      for (const env of envMatches) {
        if (env.includes('DATABASE_URL') || env.includes('DB_HOST')) {
          dependencies.push({ target: 'database', type: 'database' });
        }
        if (env.includes('REDIS_URL') || env.includes('REDIS_HOST')) {
          dependencies.push({ target: 'redis', type: 'message' });
        }
        if (env.includes('API_URL') || env.includes('SERVICE_URL')) {
          const urlMatch = env.match(/https?:\/\/([^:\/"'\s]+)/);
          if (urlMatch) {
            dependencies.push({ target: urlMatch[1], type: 'http' });
          }
        }
      }
    }
  } catch (error) {
    // Silent fail for dependency analysis
  }

  return { dependencies, endpoints };
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

function escapeDot(val: string): string {
  return String(val ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}

function generateDotGraph(graph: DependencyGraph): string {
  let dot = 'digraph BS9_Dependencies {\n';
  dot += '  rankdir=LR;\n';
  dot += '  node [shape=box, style=filled];\n\n';

  // Add nodes
  for (const service of graph.services) {
    const color = getNodeColor(service.status);
    const safeName = escapeDot(service.name);
    const label = `${safeName}\\n${escapeDot(service.status)}`;
    dot += `  "${safeName}" [label="${label}", fillcolor="${color}"];\n`;
  }

  dot += '\n';

  // Add edges
  for (const edge of graph.edges) {
    const color = getEdgeColor(edge.type);
    dot += `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [color="${color}", label="${escapeDot(edge.type)}"];\n`;
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
