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

// Configuration
const SERVICES = {
  api: {
    port: process.env.API_PORT || 3010,
    name: 'api-service'
  },
  auth: {
    port: process.env.AUTH_PORT || 3011,
    name: 'auth-service'
  },
  notification: {
    port: process.env.NOTIFICATION_PORT || 3012,
    name: 'notification-service'
  },
  gateway: {
    port: process.env.GATEWAY_PORT || 3000,
    name: 'gateway-service'
  }
};

// Service Registry
class ServiceRegistry {
  constructor() {
    this.services = new Map();
    this.healthChecks = new Map();
  }
  
  register(name, url, port) {
    this.services.set(name, {
      name,
      url,
      port,
      status: 'healthy',
      lastCheck: new Date().toISOString(),
      uptime: 0
    });
    
    console.log(`Service registered: ${name} at ${url}:${port}`);
  }
  
  getServices() {
    return Array.from(this.services.values());
  }
  
  getService(name) {
    return this.services.get(name);
  }
  
  updateHealth(name, status) {
    const service = this.services.get(name);
    if (service) {
      service.status = status;
      service.lastCheck = new Date().toISOString();
    }
  }
}

const registry = new ServiceRegistry();

// API Service
function createApiService() {
  const { port, name } = SERVICES.api;
  
  const server = serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          service: name,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          port,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // API endpoints
      if (url.pathname === '/api/users') {
        return new Response(JSON.stringify({
          users: [
            { id: 1, name: 'John Doe', email: 'john@example.com' },
            { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
          ],
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === '/api/products') {
        return new Response(JSON.stringify({
          products: [
            { id: 1, name: 'Laptop', price: 999.99 },
            { id: 2, name: 'Mouse', price: 29.99 }
          ],
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(`${name} API Service`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
  
  // Register with registry
  registry.register(name, 'http://localhost', port);
  
  return server;
}

// Auth Service
function createAuthService() {
  const { port, name } = SERVICES.auth;
  
  const server = serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          service: name,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          port,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Auth endpoints
      if (url.pathname === '/auth/login' && req.method === 'POST') {
        // Mock authentication
        return new Response(JSON.stringify({
          token: 'mock-jwt-token',
          user: { id: 1, name: 'John Doe', email: 'john@example.com' },
          expires: new Date(Date.now() + 3600000).toISOString(),
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === '/auth/verify') {
        return new Response(JSON.stringify({
          valid: true,
          user: { id: 1, name: 'John Doe' },
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(`${name} Auth Service`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
  
  // Register with registry
  registry.register(name, 'http://localhost', port);
  
  return server;
}

// Notification Service
function createNotificationService() {
  const { port, name } = SERVICES.notification;
  
  const server = serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          service: name,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          port,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Notification endpoints
      if (url.pathname === '/notifications/send' && req.method === 'POST') {
        // Mock notification sending
        return new Response(JSON.stringify({
          id: Math.floor(Math.random() * 1000),
          status: 'sent',
          message: 'Notification sent successfully',
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (url.pathname === '/notifications') {
        return new Response(JSON.stringify({
          notifications: [
            {
              id: 1,
              type: 'info',
              message: 'Welcome to BS9 microservices!',
              timestamp: new Date().toISOString()
            }
          ],
          service: name,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(`${name} Notification Service`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
  
  // Register with registry
  registry.register(name, 'http://localhost', port);
  
  return server;
}

// API Gateway
function createGatewayService() {
  const { port, name } = SERVICES.gateway;
  
  const server = serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          service: name,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          port,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          services: registry.getServices()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Service registry endpoint
      if (url.pathname === '/services') {
        return new Response(JSON.stringify({
          services: registry.getServices(),
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Proxy to API service
      if (url.pathname.startsWith('/api/')) {
        try {
          const apiService = registry.getService('api-service');
          if (apiService && apiService.status === 'healthy') {
            const apiUrl = `http://localhost:${apiService.port}${url.pathname}${url.search}`;
            const response = await fetch(apiUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body
            });
            
            const responseData = await response.text();
            return new Response(responseData, {
              status: response.status,
              headers: response.headers
            });
          }
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'API Service unavailable',
            timestamp: new Date().toISOString()
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Proxy to Auth service
      if (url.pathname.startsWith('/auth/')) {
        try {
          const authService = registry.getService('auth-service');
          if (authService && authService.status === 'healthy') {
            const authUrl = `http://localhost:${authService.port}${url.pathname}${url.search}`;
            const response = await fetch(authUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body
            });
            
            const responseData = await response.text();
            return new Response(responseData, {
              status: response.status,
              headers: response.headers
            });
          }
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Auth Service unavailable',
            timestamp: new Date().toISOString()
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Proxy to Notification service
      if (url.pathname.startsWith('/notifications/')) {
        try {
          const notificationService = registry.getService('notification-service');
          if (notificationService && notificationService.status === 'healthy') {
            const notificationUrl = `http://localhost:${notificationService.port}${url.pathname}${url.search}`;
            const response = await fetch(notificationUrl, {
              method: req.method,
              headers: req.headers,
              body: req.body
            });
            
            const responseData = await response.text();
            return new Response(responseData, {
              status: response.status,
              headers: response.headers
            });
          }
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Notification Service unavailable',
            timestamp: new Date().toISOString()
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Root endpoint
      if (url.pathname === '/') {
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>BS9 Microservices Example</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; }
              .container { max-width: 800px; margin: 0 auto; }
              .service { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
              .healthy { border-left: 4px solid #28a745; }
              .unhealthy { border-left: 4px solid #dc3545; }
              .endpoint { background: #e9ecef; padding: 10px; margin: 5px 0; border-radius: 3px; font-family: monospace; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>BS9 Microservices Example</h1>
              <p>A microservices architecture example with API Gateway, managed by BS9.</p>
              
              <h2>Services:</h2>
              <div id="services"></div>
              
              <h2>Available Endpoints:</h2>
              <div class="endpoint">GET /services - List all services</div>
              <div class="endpoint">GET /api/users - Proxy to API service</div>
              <div class="endpoint">GET /api/products - Proxy to API service</div>
              <div class="endpoint">POST /auth/login - Proxy to Auth service</div>
              <div class="endpoint">GET /auth/verify - Proxy to Auth service</div>
              <div class="endpoint">GET /notifications - Proxy to Notification service</div>
              <div class="endpoint">POST /notifications/send - Proxy to Notification service</div>
              
              <h2>Service Health:</h2>
              <div id="health"></div>
            </div>
            
            <script>
              // Fetch services and health status
              async function fetchServices() {
                try {
                  const response = await fetch('/services');
                  const data = await response.json();
                  const servicesDiv = document.getElementById('services');
                  const healthDiv = document.getElementById('health');
                  
                  servicesDiv.innerHTML = data.services.map(service => 
                    \`<div class="service \${service.status === 'healthy' ? 'healthy' : 'unhealthy'}">
                      <strong>\${service.name}</strong>
                      <br>Port: \${service.port}
                      <br>Status: \${service.status}
                      <br>Last Check: \${service.lastCheck}
                    </div>\`
                  ).join('');
                  
                  healthDiv.innerHTML = \`<div class="service healthy">
                    <strong>Gateway Status:</strong> \${data.services.filter(s => s.status === 'healthy').length}/\${data.services.length} services healthy
                  </div>\`;
                } catch (error) {
                  console.error('Error fetching services:', error);
                }
              }
              
              // Initial load
              fetchServices();
              
              // Refresh every 10 seconds
              setInterval(fetchServices, 10000);
            </script>
          </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      return new Response(`${name} Gateway Service`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
  
  // Register with registry
  registry.register(name, 'http://localhost', port);
  
  return server;
}

// Health check loop
function startHealthChecks() {
  setInterval(async () => {
    const services = registry.getServices();
    
    for (const service of services) {
      try {
        const response = await fetch(`http://localhost:${service.port}/health`);
        const data = await response.json();
        
        if (data.status === 'healthy') {
          registry.updateHealth(service.name, 'healthy');
        } else {
          registry.updateHealth(service.name, 'unhealthy');
        }
      } catch (error) {
        registry.updateHealth(service.name, 'unhealthy');
      }
    }
  }, 5000); // Check every 5 seconds
}

// Start all services
console.log('Starting BS9 Microservices Example...');

const apiServer = createApiService();
const authServer = createAuthService();
const notificationServer = createNotificationService();
const gatewayServer = createGatewayService();

// Start health checks
startHealthChecks();

console.log('All services started!');
console.log('Gateway: http://localhost:3000');
console.log('API Service: http://localhost:3010');
console.log('Auth Service: http://localhost:3011');
console.log('Notification Service: http://localhost:3012');
console.log(`Process ID: ${process.pid}`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  apiServer.stop();
  authServer.stop();
  notificationServer.stop();
  gatewayServer.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
