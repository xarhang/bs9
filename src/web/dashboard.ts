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
import { execSync } from "node:child_process";
import { join } from "node:path";

interface ServiceMetrics {
  name: string;
  loaded: string;
  active: string;
  sub: string;
  state: string;
  cpu: string;
  memory: string;
  uptime: string;
  tasks: string;
  health: string;
  description: string;
}

const getMetrics = (): ServiceMetrics[] => {
  try {
    const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
    const lines = listOutput.split("\n").filter(line => line.includes(".service"));
    
    const services: ServiceMetrics[] = [];
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
      if (!match) continue;
      
      const [, statusIndicator, name, loaded, active, sub, description] = match;
      
      if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;
      
      const service: ServiceMetrics = {
        name,
        loaded,
        active,
        sub,
        state: `${active}/${sub}`,
        cpu: '-',
        memory: '-',
        uptime: '-',
        tasks: '-',
        health: 'unknown',
        description,
      };
      
      // Get additional metrics
      try {
        const showOutput = execSync(`systemctl --user show ${name} -p CPUUsageNSec MemoryCurrent ActiveEnterTimestamp TasksCurrent State`, { encoding: "utf-8" });
        const cpuMatch = showOutput.match(/CPUUsageNSec=(\d+)/);
        const memMatch = showOutput.match(/MemoryCurrent=(\d+)/);
        const timeMatch = showOutput.match(/ActiveEnterTimestamp=(.+)/);
        const tasksMatch = showOutput.match(/TasksCurrent=(\d+)/);
        
        if (cpuMatch) {
          const cpuNs = Number(cpuMatch[1]);
          service.cpu = `${(cpuNs / 1000000).toFixed(1)}ms`;
        }
        if (memMatch) {
          const memBytes = Number(memMatch[1]);
          service.memory = formatMemory(memBytes);
        }
        if (timeMatch) {
          service.uptime = formatUptime(timeMatch[1]);
        }
        if (tasksMatch) {
          service.tasks = tasksMatch[1];
        }
      } catch {
        // Ignore metrics errors
      }
      
      // Check health endpoint
      try {
        let port: string | null = null;
        
        // First try to get port from description
        const portMatch = description.match(/port[=:]?\s*(\d+)/i);
        if (portMatch) {
          port = portMatch[1];
        } else {
          // If not in description, check environment variables
          const envOutput = execSync(`systemctl --user show ${name} -p Environment`, { encoding: "utf-8" });
          const envPortMatch = envOutput.match(/PORT=(\d+)/);
          if (envPortMatch) {
            port = envPortMatch[1];
          }
        }
        
        if (port) {
          const healthCheck = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/healthz`, { encoding: "utf-8", timeout: 1000 });
          service.health = healthCheck === "200" ? "healthy" : "unhealthy";
        } else {
          service.health = "no_port";
        }
      } catch {
        service.health = "unknown";
      }
      
      services.push(service);
    }
    
    return services;
  } catch (error) {
    console.error('Error fetching metrics:', error);
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

const formatUptime = (timestamp: string): string => {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  } catch {
    return '-';
  }
};

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BS9 Web Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stat-value { font-size: 2em; font-weight: bold; color: #333; }
        .stat-label { color: #666; margin-top: 5px; }
        .services-table { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; }
        .status-healthy { color: #28a745; font-weight: bold; }
        .status-unhealthy { color: #dc3545; font-weight: bold; }
        .status-unknown { color: #ffc107; font-weight: bold; }
        .state-active { color: #28a745; }
        .state-failed { color: #dc3545; }
        .refresh-btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        .refresh-btn:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 BS9 Web Dashboard</h1>
            <p>Real-time monitoring dashboard for BS9 services</p>
            <button class="refresh-btn" onclick="location.reload()">Refresh</button>
        </div>
        
        <div class="stats" id="stats">
            <!-- Stats will be populated by JavaScript -->
        </div>
        
        <div class="services-table">
            <table>
                <thead>
                    <tr>
                        <th>Service</th>
                        <th>State</th>
                        <th>Health</th>
                        <th>CPU</th>
                        <th>Memory</th>
                        <th>Uptime</th>
                        <th>Tasks</th>
                    </tr>
                </thead>
                <tbody id="services-tbody">
                    <!-- Services will be populated by JavaScript -->
                </tbody>
            </table>
        </div>
    </div>
    
    <script>
        async function loadMetrics() {
            try {
                const response = await fetch('/api/metrics');
                const data = await response.json();
                
                // Update stats
                const statsHtml = \`
                    <div class="stat-card">
                        <div class="stat-value">\${data.total}</div>
                        <div class="stat-label">Total Services</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${data.running}</div>
                        <div class="stat-label">Running</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${data.totalMemory}</div>
                        <div class="stat-label">Total Memory</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${data.lastUpdate}</div>
                        <div class="stat-label">Last Update</div>
                    </div>
                \`;
                document.getElementById('stats').innerHTML = statsHtml;
                
                // Update services table
                const tbody = document.getElementById('services-tbody');
                tbody.innerHTML = data.services.map(service => \`
                    <tr>
                        <td><strong>\${service.name}</strong></td>
                        <td class="state-\${service.active === 'active' ? 'active' : 'failed'}">\${service.state}</td>
                        <td class="status-\${service.health}">\${service.health.toUpperCase()}</td>
                        <td>\${service.cpu}</td>
                        <td>\${service.memory}</td>
                        <td>\${service.uptime}</td>
                        <td>\${service.tasks}</td>
                    </tr>
                \`).join('');
                
            } catch (error) {
                console.error('Error loading metrics:', error);
            }
        }
        
        // Load metrics on page load
        loadMetrics();
        
        // Auto-refresh every 5 seconds
        setInterval(loadMetrics, 5000);
    </script>
</body>
</html>
`;

serve({
  port: process.env.WEB_DASHBOARD_PORT || 8080,
  fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === '/api/metrics') {
      const services = getMetrics();
      const running = services.filter(s => s.active === 'active').length;
      const totalMemory = services.reduce((sum, s) => {
        if (s.memory !== '-') {
          const match = s.memory.match(/([\d.]+)(B|KB|MB|GB)/);
          if (match) {
            const [, value, unit] = match;
            const bytes = Number(value) * Math.pow(1024, ['B', 'KB', 'MB', 'GB'].indexOf(unit));
            return sum + bytes;
          }
        }
        return sum;
      }, 0);
      
      const data = {
        services,
        total: services.length,
        running,
        totalMemory: formatMemory(totalMemory),
        lastUpdate: new Date().toLocaleTimeString(),
      };
      
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/') {
      return new Response(HTML_TEMPLATE, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`🌐 BS9 Web Dashboard running on http://localhost:${process.env.WEB_DASHBOARD_PORT || 8080}`);
