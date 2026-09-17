# Video 3: First Application

## 📹 Video Information

**Title:** First Application  
**Duration:** 10 minutes  
**Format:** MP4 (1080p)  
**Level:** Beginner  
**Release Date:** January 2022026-01-25

## 🎯 Video Description

This video demonstrates creating and managing your first BS9 application from scratch. Viewers will learn the complete workflow from creating a simple application to deploying it with BS9. This hands-on tutorial covers service creation, configuration, monitoring, and basic operations.

## 🎯 Application Development Workflow

### 🛠️ Step-by-Step Process

#### 1. Create Application File
- Basic Bun server setup
- HTTP server configuration
- Health check endpoints
- Error handling

#### 2. Start with BS9
- Starting the service
- Configuration options
- Environment variables
- Service naming

#### 3. Monitor the Service
- Real-time status checking
- Log viewing
- Performance metrics
- Health checks

#### 4. Service Management
- Restarting services
- Stopping services
- Configuration updates
- Resource management

#### 5. Production Considerations
- Environment variables
- Security settings
- Resource limits
- Logging configuration

## 📋 Code Examples

### 📄 Simple Application (examples/simple-app.js)
```javascript
#!/usr/bin/env bun

import { serve } from "bun";

serve({
  port: process.env.PORT || 3000,
  fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === "/") {
      return new Response("Hello from BS9-managed app!");
    }
    
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    
    if (url.pathname === "/readyz") {
      return new Response("ready");
    }
    
    if (url.pathname === "/metrics") {
      return new Response(JSON.stringify({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        requests: Math.floor(Math.random() * 1000),
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response("404 Not Found");
  },
});
```

### 📄 Start with BS9
```bash
# Start the application
bs9 start examples/simple-app.js --name hello-world

# Check status
bs9 status hello-world

# View logs
bs9 logs hello-world
```

### 📊 Advanced Configuration
```javascript
// With environment variables
bs9 start examples/simple-app.js \
  --name hello-world \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --instances 2 \
  --restart always \
  --memory 256M
```

## 🎯 Common Operations

### 🔍 Service Status
```bash
# Check all services
bs9 status

# Check specific service
bs9 status hello-world

# Detailed status
bs9 status hello-world --detailed
```

### 📊 Log Management
```bash
# View all logs
bs9 logs

# Follow logs in real-time
bs9 logs hello-world --follow

# Filter logs by level
bs9 logs hello-world --level error

# Export logs to file
bs9 logs hello-world --export logs.txt
```

### 🔄 Service Control
```bash
# Restart service
bs9 restart hello-world

# Stop service
bs9 stop hello-world

# Force stop
bs9 stop hello-world --force

# Delete service
bs9 stop hello-world --remove
```

## 📊 Monitoring and Metrics

### 📊 Real-time Monitoring
```bash
# Start monitoring dashboard
bs9 monit

# Monitor specific service
bs9 monit --service hello-world

# Set refresh interval
bs9 monit --refresh 1

# Show only metrics
bs9 monit --metrics-only
```

### 📊 Performance Metrics
```bash
# View resource usage
bs9 status --resources

# View SRE metrics
bs9 status --sre

# View uptime information
bs9 status --uptime
```

## 🔧 Configuration Examples

### 🌍 Environment Variables
```bash
# Set environment variables
bs9 start examples/simple-app.js \
  --name hello-world \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env DB_HOST=localhost \
  --env API_URL=https://api.example.com
```

### 🔧 Resource Limits
```bash
# Set memory limit
bs9 start examples/simple-app.js \
  --name hello-world \
  --memory 512M \
  --cpu 0.5
```

### 🔄 Restart Policies
```bash
# Always restart on failure
bs9 start examples/simple-app.js \
  --name hello-world \
  --restart always

# Restart only on failure
bs9 start examples/simple-app.js \
  --name hello-world \
  --restart on-failure

# Never restart
bs9 start examples/simple-app.js \
  --name hello-world \
  --restart never
```

## 🛡 Security Features

### 🔒 Security Audit (Default)
```bash
# Security audit is enabled by default
bs9 start examples/simple-app.js --name hello-world

# Skip security audit (not recommended)
bs9 start examples/simple-app.js --name hello-world --no-security-audit
```

### 🔒 Path Validation
```bash
# BS9 automatically validates paths to prevent:
# - Path traversal attacks
- Command injection attempts
- Invalid file access
```

### 🔒 Port Validation
```bash
# BS9 validates port numbers (1-65535)
bs9 start examples/simple-app.js --name hello-world --port 3000
```

## 📊 Production Deployment

### 🚀 Production Configuration
```bash
# Production deployment
bs9 start examples/simple-app.js \
  --name hello-world \
  --env NODE_ENV=production \
  --instances 3 \
  --restart always \
  --memory 512M \
  --cpu 0.5 \
  --log-level info \
  --log-file /var/log/bs9/hello-world.log
```

### 🔍 Health Checks
```bash
# Health check
curl http://localhost:3000/healthz

# Ready check
curl http://localhost:3000/readyz

# Metrics endpoint
curl http://localhost:3000/metrics
```

## 🎯 Best Practices

### 📋 Application Structure
```
BS9/
├── bin/
│   └── bs9                     # CLI entry point
├── src/
│   ├── commands/               # CLI commands, including HA operations
│   ├── cluster/                # Worker lifecycle control
│   ├── daemon/                 # Self-healing topology reconciler
│   ├── hub/                    # Same-host state coordination
│   ├── runtime/                # Typed bs9/runtime APIs
│   └── platform/               # Cross-platform support
├── tests/                  # Unit, integration, and HA tests
├── examples/
│   ├── simple-app.js
│   ├── express-app.js
│   ├── websocket-app.js
│   ├── database-app.js
│   └── microservices-app.js
├── docs/
│   ├── COMMANDS.md
│   ├── API.md
│   └── HA_RUNTIME.md
├── setup.sh
├── package.json
└── README.md
```

### 📝 Configuration Management
```bash
# Use environment variables for configuration
export NODE_ENV=production
export PORT=3000
export DB_HOST=localhost
export API_URL=https://api.example.com

# Start with configuration
bs9 start examples/simple-app.js --name hello-world
```

### 🔧 Logging Strategy
```bash
# Set log level
bs9 start examples/simple-app.js --log-level info

# Log to file
bs9 start examples/simple-app.js --log-file /var/log/bs9/hello-world.log

# Follow logs in real-time
bs9 logs hello-world --follow
```

## 🎯 Troubleshooting

### 🚨 Common Issues

#### Service Won't Start
```bash
# Check logs
bs9 logs hello-world

# Check configuration
bs9 status hello-world --detailed

# Run health check
bs9 doctor
```

#### Port Conflicts
```bash
# Check what's using the port
lsof -i :3000

# Use different port
bs9 start examples/simple-app.js --name hello-world --port 3001
```

#### Permission Issues
```bash
# Check permissions
ls -la examples/simple-app.js

# Fix permissions
chmod +x examples/simple-app.js

# Use sudo if needed
sudo bs9 start examples/simple-app.js --name hello-world
```

## 🎯 Next Steps

After completing this video, viewers should continue with:
- **Video 4**: Service Management
- **Video 5**: Monitoring and Metrics
- **Video 6**: Advanced Configuration
- **Video 7**: Security Best Practices

---

*Video production in progress. Coming soon!*
