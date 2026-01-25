# BS9 (Bun Sentinel 9) 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.4.3-blue.svg)](https://github.com/xarhang/bs9)
[![Security](https://img.shields.io/badge/security-Enterprise-green.svg)](SECURITY.md)
[![Production Ready](https://img.shields.io/badge/production-Ready-brightgreen.svg)](PRODUCTION.md)
[![Cross-Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/bs9/bs9)

**Enterprise-grade, mission-critical process manager for Bun applications with built-in security, monitoring, and observability. Works on Windows, macOS, and Linux.**

---

## 🚀 Quick Start

```bash
# One-click installer (installs Bun + BS9)
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash

# Or manual install
git clone https://github.com/xarhang/bs9.git
cd bs9
bun install
cp bin/bs9 ~/.local/bin/bs9
chmod +x ~/.local/bin/bs9
```

---

### 🌐 Platform Support
- **✅ Auto-Detection**: Automatically detects platform and creates directories
- **✅ Zero-Configuration**: No manual setup required
- **✅ Lightweight**: Minimal dependencies, zero database required for core functionality
- **✅ Cross-Platform**: Same commands work on all platforms

#### 🐧 Linux
- **Service Manager**: Systemd (user-mode)
- **Features**: Advanced security hardening, resource limits, sandboxing
- **Commands**: All 22 commands available

#### 🍎 macOS  
- **Service Manager**: Launchd
- **Features**: Native macOS integration, automatic recovery
- **Commands**: All commands + `bs9 macos` for launchd management

#### 🪟 Windows
- **Service Manager**: Windows Services
- **Features**: PowerShell automation, event log integration
- **Commands**: All commands + `bs9 windows` for service management

```bash
# Check your platform
bs9 platform

# Platform-specific service management
bs9 macos create --name my-app --file app.js  # macOS
bs9 windows create --name my-app --file app.js # Windows
```

### 🚀 Killer Feature: Zero-Config Deployment

**Why choose BS9 over PM2 or systemd?**  
**One command does everything:**

```bash
# Deploy with production-ready setup
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
```

**What `bs9 deploy` does automatically:**
- ✅ Creates systemd service with security hardening
- ✅ Enables user services persistence (linger)
- ✅ Sets up health checks (`/healthz`, `/metrics`)
- ✅ Enables OpenTelemetry and Prometheus metrics
- ✅ Configures smart restart policies
- ✅ Performs health validation
- ✅ Shows management commands and access URLs

**Hot reload capabilities:**
```bash
# Update configuration without downtime
bs9 deploy app.ts --reload --env NEW_CONFIG=value
```

## 📋 Complete CLI Commands

### Service Management
```bash
# Start service with flexible host and protocol options
bs9 start app.js                                    # Default: localhost:3000, HTTP
bs9 start app.js --host 0.0.0.0 --port 8080        # Custom host and port
bs9 start app.js --host 192.168.1.100 --https      # Custom host with HTTPS
bs9 start app.ts --build --name myapp --port 8080 --env NODE_ENV=production --host 0.0.0.0 --https

# Stop service
bs9 stop myapp

# Restart service
bs9 restart myapp

# Enhanced status display with visual indicators
bs9 status                                         # Show all services
bs9 status myapp                                  # Show specific service

# View logs
bs9 logs myapp                                    # Show logs
bs9 logs myapp --follow                           # Follow logs
bs9 logs myapp --tail 50                          # Show last 50 lines

# Delete services
bs9 delete myapp                                  # Delete specific service
bs9 delete myapp --remove                         # Delete and remove config files
bs9 delete --all                                  # Delete all services
bs9 delete --all --force                          # Force delete all services

# Deploy applications (KILLER FEATURE)
bs9 deploy app.ts                                 # Zero-config deployment
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
bs9 deploy app.ts --reload --env NEW_CONFIG=value  # Hot reload with new config
```

### Backup & Recovery
```bash
# Save service configurations
bs9 save myapp                                    # Save specific service
bs9 save --all                                    # Save all services
bs9 save myapp --backup                           # Save with timestamped backup

# Restore services from backup
bs9 resurrect myapp                               # Restore specific service
bs9 resurrect --all                               # Restore all services
bs9 resurrect myapp --config custom.json         # Restore with custom config
```

### Monitoring & Observability
```bash
# Real-time terminal dashboard
bs9 monit                         # 2s refresh default
bs9 monit --refresh 5              # Custom refresh interval

# Web-based dashboard
bs9 web --port 8080               # Start web dashboard
bs9 web --detach --port 8080       # Run in background

# Advanced monitoring
bs9 advanced --port 8090

# Performance profiling
bs9 profile --service myapp --duration 60
bs9 profile --service myapp --duration 60 --output profile.json

# Alert management
bs9 alert --list                   # Show alert configuration
bs9 alert --cpu 80 --memory 85      # Set thresholds
bs9 alert --webhook https://hooks.slack.com/...
bs9 alert --test                   # Test webhook

# Historical data
bs9 export --format json --hours 24 # Export metrics
bs9 export --service myapp --format csv --hours 24
bs9 export --service myapp --format csv

# Service management
bs9 delete myapp                    # Delete specific service
bs9 delete myapp --remove           # Delete and remove config files
bs9 delete --all                    # Delete all services
bs9 delete --all --force           # Force delete all services
bs9 delete myapp --timeout 60      # Custom graceful shutdown timeout

# Deploy applications (KILLER FEATURE)
bs9 deploy app.ts                                 # Zero-config deployment
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
bs9 deploy app.ts --reload --env NEW_CONFIG=value  # Hot reload with new config

# Backup and restore
bs9 save myapp                     # Save service configuration
bs9 save --all                     # Save all services
bs9 save myapp --backup            # Save with timestamped backup
bs9 resurrect myapp                # Restore from backup
bs9 resurrect --all               # Restore all services
```

---

## 🎯 Key Features

### ✅ **Zero-Config Deployment**: One-command production setup with `bs9 deploy`
- **One-Command Setup**: `bs9 deploy app.ts` does everything automatically
- **Production Ready**: Security hardening, health checks, metrics enabled
- **Hot Reload**: Update configurations without downtime
- **Port Detection**: Automatic service discovery and access URLs
- **Environment Management**: Easy environment variable updates

### ✅ **Enhanced Status Display**: Visual indicators (✅🔄❌⚠️⏸️) with detailed metrics
- **Visual Indicators**: ✅🔄❌⚠️⏸️ for instant health assessment
- **Perfect Alignment**: All columns properly aligned with accurate data
- **Detailed Metrics**: CPU, Memory, Uptime, Tasks, Port information
- **Troubleshooting Hints**: Actionable commands for common issues
- **Service Sections**: Running, Restarting, Failed services clearly separated

### 🔍 **Real-time Monitoring**: Live terminal UI with color-coded status
- **Terminal Dashboard**: Live terminal UI with color-coded status
- **Web Dashboard**: Browser-based monitoring with auto-refresh
- **Health Checks**: Automatic `/healthz`, `/readyz`, `/metrics` endpoints
- **SRE Metrics**: CPU, Memory, Uptime, Task tracking

### 💾 **Backup & Recovery System**: Complete JSON-based backup system
- **Service Configuration Backup**: Complete JSON-based backup system
- **Timestamped Backups**: Version control for service configurations
- **Bulk Operations**: Save and restore all services at once
- **Cross-Platform**: Works on Linux, macOS, Windows
- **Disaster Recovery**: Quick system restoration from backups

### 📊 Historical Metrics Storage
- **Local Storage**: JSON-based metrics storage in `~/.config/bs9/metrics/`
- **Data Export**: JSON and CSV export formats
- **Time-based Queries**: Filter by hours/days
- **Aggregated Analytics**: CPU/Memory averages, uptime calculations

### 🔔 Advanced Alert System
- **Configurable Thresholds**: CPU, Memory, Error Rate, Uptime
- **Webhook Notifications**: HTTP webhook support for alerts
- **Service-specific Configs**: Per-service alert settings
- **Cooldown Period**: Prevent alert spam
- **Alert Testing**: Webhook connectivity validation

### 🗑️ Service Deletion & Cleanup
- **Individual Service Deletion**: Delete specific services by name
- **Bulk Deletion**: Remove all BS9 services at once
- **Configuration Cleanup**: Remove service configuration files
- **Force Deletion**: Ignore errors during deletion
- **Graceful Shutdown**: Configurable timeout for clean termination
- **Cross-Platform Support**: Works on Linux, macOS, and Windows

### 💾 Backup & Restore System
- **Service Configuration Backup**: Save service configurations to JSON
- **Bulk Backup**: Save all services at once
- **Timestamped Backups**: Create multiple backup versions
- **Service Resurrection**: Restore services from backup
- **Configuration Management**: Manage service configurations
- **Disaster Recovery**: Quick service restoration

### 🐳 Container & Orchestration
- **Docker Support**: Complete Dockerfile and docker-compose setup
- **Kubernetes**: Full K8s deployment with ServiceMonitor
- **Health Checks**: Container health endpoints
- **Resource Limits**: Memory and CPU constraints
- **Security Policies**: PodSecurityPolicy, RBAC

### 🛡️ Enterprise Security
- **Pre-start Audit**: Scan for eval(), child_process.exec(), etc.
- **User-mode Systemd**: Zero root operation required
- **Systemd Hardening**: PrivateTmp, ProtectSystem, NoNewPrivileges
- **Resource Limits**: CPU, memory, file descriptor limits
- **Port Warnings**: Alert for privileged ports (< 1024)

### ⚡ TypeScript JIT/AOT Support
- **JIT Mode**: Run `.ts` files directly (default)
- **AOT Mode**: Compile to optimized JS for production (`--build`)
- **Performance**: Faster startup vs runtime optimization
- **Build Directory**: `.bs9-build/` for compiled artifacts

---

## 📊 Monitoring Dashboards

### Terminal Dashboard (`bs9 monit`)
```
🔍 BS9 Real-time Monitoring Dashboard
========================================================================================================================
Refresh: 2s | Last update: 12:23:45 AM | Press Ctrl+C to exit

SERVICE              STATE           HEALTH    CPU       MEMORY     UPTIME      TASKS   DESCRIPTION
------------------------------------------------------------------------------------------------------------------------
myapp                active/running   ✅ OK      12.3ms    45.2MB     2h 15m      3       BS9 Service: myapp
api                  active/running   ✅ OK      8.1ms     32.1MB     1h 42m      2       BS9 Service: api
webapp               failed/failed    ❌ FAIL    -         -          -           -       BS9 Service: webapp

========================================================================================================================
📊 Summary: 2/3 services running | Total Memory: 77.3MB | Services: 3

⚠️  ALERTS:
   Failed services: webapp
   Unhealthy services: webapp
```

### Web Dashboard (`bs9 web`)
- **Modern UI**: Responsive web interface
- **Real-time Updates**: Auto-refresh every 5 seconds
- **Service Cards**: Visual status indicators
- **Metrics Charts**: CPU, Memory, Uptime graphs
- **Historical Data**: View trends over time
- **Alert Status**: Current alert configuration

---

## 🔧 Alert Configuration

### Global Alert Settings
```bash
# Configure global thresholds
bs9 alert --cpu 80 --memory 85 --errorRate 5 --uptime 95
bs9 alert --webhook https://hooks.slack.com/services/...
bs9 alert --cooldown 300  # 5 minutes cooldown
```

### Service-specific Alerts
```bash
# Configure alerts for specific service
bs9 alert --service myapp --cpu 90 --memory 90
bs9 alert --service critical-app --enable
bs9 alert --service test-app --disable
```

### Alert Management
```bash
# View current configuration
bs9 alert --list

# Test webhook connectivity
bs9 alert --test

# Enable/disable alerts
bs9 alert --enable
bs9 alert --disable
```

---

## 📈 Historical Metrics

### Data Storage
- **Location**: `~/.config/bs9/metrics/`
- **Format**: JSON files with timestamp naming
- **Retention**: Automatic cleanup (1000 snapshots)
- **Compression**: Efficient JSON storage

### Export Options
```bash
# Export all metrics (last 24 hours)
bs9 export --format json --hours 24

# Export specific service
bs9 export --service myapp --format csv --hours 48

# Custom output file
bs9 export --format json --output my-metrics.json
```

### Data Analysis
```bash
# Get aggregated metrics
const storage = new MetricsStorage();
const metrics = storage.getAggregatedMetrics(24); // Last 24 hours
console.log(`Average CPU: ${metrics.avgCpu}ms`);
console.log(`Average Memory: ${metrics.avgMemory}B`);
console.log(`Uptime: ${metrics.uptime}%`);
```

---

## 🐳 Docker Deployment

### Quick Start
```bash
# Build and run with Docker Compose
docker-compose up -d

# Access services
# Web Dashboard: http://localhost:8080
# Grafana: http://localhost:3001
# Prometheus: http://localhost:9090
```

### Dockerfile Features
- **Multi-stage**: Optimized production builds
- **Security**: Non-root user, read-only filesystem
- **Health Checks**: Built-in health endpoints
- **Resource Limits**: Memory and CPU constraints

### Docker Compose Stack
- **BS9 Manager**: Main process manager
- **Prometheus**: Metrics collection
- **Grafana**: Visualization dashboard
- **Persistent Storage**: Data volumes for metrics

---

## ☸️ Kubernetes Deployment

### Quick Deploy
```bash
# Deploy to Kubernetes
kubectl apply -f src/k8s/bs9-deployment.yaml

# Check deployment
kubectl get deployments -n bs9-system
kubectl get pods -n bs9-system
```

### K8s Features
- **Namespace Isolation**: `bs9-system` namespace
- **Service Monitor**: Prometheus integration
- **Security**: PodSecurityPolicy, RBAC
- **Health Checks**: Liveness and readiness probes
- **Resource Limits**: Memory and CPU constraints

---

## 🔄 Migration from PM2

| PM2 Command | BS9 Equivalent | Enhanced Features |
|-------------|----------------|------------------|
| `pm2 start app.js` | `bs9 start app.js` | Security audit, systemd hardening |
| `pm2 stop app` | `bs9 stop app` | User-mode operation |
| `pm2 restart app` | `bs9 restart app` | Health monitoring |
| `pm2 list` | `bs9 status` | SRE metrics dashboard |
| `pm2 logs app` | `bs9 logs app` | Journalctl integration |
| `pm2 monit` | `bs9 monit` | Enhanced terminal dashboard |
| - | `bs9 web` | Web-based dashboard |
| - | `bs9 alert` | Alert system with webhooks |
| - | `bs9 export` | Historical metrics |
| - | `bs9 delete` | Service deletion and cleanup |
| - | `bs9 save` | Service configuration backup |
| - | `bs9 resurrect` | Service restoration from backup |

---

## 🛠️ Configuration

### BS9 Config (`~/.config/bs9/config.toml`)
```toml
[default]
port = 3000
otel_enabled = true
prometheus_enabled = true
environment = "production"

[security]
security_audit = true
block_eval = true
block_child_process_exec = true
block_fs_access = true

[monitoring]
refresh_interval = 2
health_check_timeout = 1000

[logging]
level = "info"
structured = true
```

### Alert Config (`~/.config/bs9/alerts.json`)
```json
{
  "enabled": true,
  "webhookUrl": "https://hooks.slack.com/services/...",
  "thresholds": {
    "cpu": 80,
    "memory": 85,
    "errorRate": 5,
    "uptime": 95
  },
  "cooldown": 300,
  "services": {
    "myapp": {
      "enabled": true,
      "customThresholds": {
        "cpu": 90
      }
    }
  }
}
```

---

## 📚 Examples

### Simple JavaScript App
```javascript
// examples/simple-app.js
import { serve } from "bun";

serve({
  port: process.env.PORT || 3000,
  fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/readyz") return new Response("ready");
    if (url.pathname === "/metrics") {
      return new Response(JSON.stringify({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response("Hello from BS9!");
  },
});
```

### TypeScript App with AOT
```typescript
// examples/typescript-app.ts
import { serve } from "bun";

interface RequestMetrics {
  method: string;
  route: string;
  timestamp: number;
}

const metrics: RequestMetrics[] = [];

serve({
  port: Number(process.env.PORT) || 3000,
  fetch(req: Request) {
    const url = new URL(req.url);
    const method = req.method;
    const route = url.pathname;
    
    // Record metrics
    metrics.push({
      method,
      route,
      timestamp: Date.now(),
    });
    
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/readyz") return new Response("ready");
    
    return new Response(`Hello from TypeScript BS9 app!\nMethod: ${method}\nRoute: ${route}`);
  },
});
```

---

## 🔧 Development

### Setup
```bash
# Clone and install
git clone https://github.com/xarhang/bs9.git
cd bs9
bun install

# Run CLI in development
bun run bin/bs9 --help

# Build for distribution
bun run build
```

### Project Structure
```
BS9/
├── bin/
│   └── bs9                 # CLI entry point
├── src/
│   ├── commands/           # CLI commands
│   │   ├── start.ts        # Service management
│   │   ├── stop.ts         # Stop services
│   │   ├── restart.ts      # Restart services
│   │   ├── status.ts       # Status dashboard
│   │   ├── logs.ts         # Log viewing
│   │   ├── monit.ts        # Terminal dashboard
│   │   ├── web.ts          # Web dashboard
│   │   ├── alert.ts        # Alert management
│   │   ├── delete.ts       # Service deletion
│   │   ├── save.ts         # Service backup
│   │   ├── resurrect.ts    # Service restoration
│   │   └── export.ts       # Data export
│   ├── web/                # Web dashboard
│   │   └── dashboard.ts    # Web server
│   ├── storage/            # Metrics storage
│   │   └── metrics.ts       # Historical data
│   ├── alerting/           # Alert system
│   │   └── config.ts       # Alert management
│   ├── injectors/          # Auto-injection
│   │   └── otel.ts         # OpenTelemetry
│   ├── docker/             # Docker files
│   │   └── Dockerfile       # Container setup
│   └── k8s/                # Kubernetes manifests
│       └── bs9-deployment.yaml
├── examples/               # Example apps
├── configs/                # Configuration templates
├── setup.sh               # One-click installer
├── docker-compose.yml      # Docker stack
└── README.md
```

---

## 🚀 Production Deployment

### System Requirements
- **OS**: Linux (systemd user mode)
- **Runtime**: Bun 1.3.6+
- **Memory**: 512MB minimum per service
- **Disk**: 1GB for metrics storage

### Installation
#### One-Click Install (Recommended)
```bash
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/main/setup.sh | bash
```

#### Manual Install
```bash
# Clone the repository
git clone https://github.com/xarhang/bs9.git
cd bs9

# Install dependencies
bun install

# Install globally
npm install -g .

# Or install from npm directly
npm install -g bs9
```

### Production Setup
```bash
# Enable user services persistence
loginctl enable-linger $USER

# Start first service
bs9 start examples/simple-app.js --name production-app

# Verify monitoring
bs9 status
bs9 monit
bs9 web --detach

# Configure alerts
bs9 alert --cpu 80 --memory 85 --webhook https://hooks.slack.com/...
```

---

## 🐛 Troubleshooting

### Service Issues
```bash 
# Check service status
systemctl --user status myservice

# View logs
bs9 logs myservice --follow

# Check systemd unit
systemctl --user daemon-reload
```

### Monitoring Issues
```bash
# Check web dashboard
curl http://localhost:8080/api/metrics

# Test alerts
bs9 alert --test

# Export metrics for analysis
bs9 export --format json --hours 1
```

### Performance Issues
```bash
# Check resource usage
bs9 status

# Monitor with terminal dashboard
bs9 monit --refresh 1

# Export historical data
bs9 export --service myapp --hours 24
```

---

## 📄 License

**MIT License** - see [LICENSE](LICENSE) file for details.

BS9 is 100% open source and free for everyone - no restrictions, no enterprise features, no paid tiers. All features are available to everyone under the MIT license.

### 🤝 Support Open Source
If you find BS9 useful, please consider:
- ⭐ Starring this repository
- 🐛 Reporting issues and feature requests
- 💬 Contributing code or documentation
- 🎯 Sponsoring the project (GitHub Sponsors)
- 📢 Sharing with your community

**BS9 is community-driven and will always remain free and open source.**

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

---

## 🔗 Links

- **GitHub**: https://github.com/xarhang/bs9
- **Issues**: https://github.com/xarhang/bs9/issues
- **Discussions**: https://github.com/xarhang/bs9/discussions
- **Security**: security@bs9.dev
- **Enterprise**: enterprise@bs9.dev

## 🔒 Security

BS9 is built with security as a primary concern:

### Built-in Security Features
- **Input Validation**: Path traversal protection, command injection prevention
- **Runtime Security**: Process isolation, resource limits, security auditing
- **Platform Hardening**: Native security integration (systemd, launchd, Windows services)
- **Web Security**: Session token authentication, XSS protection
- **Database Security**: SQL injection prevention, connection validation
- **Network Security**: Header sanitization, rate limiting

### Security Best Practices
```bash
# Use secure service names
bs9 start app.js --name my-secure-app

# Bind to specific interfaces
bs9 start app.js --host 127.0.0.1 --port 3000

# Use HTTPS in production
bs9 start app.js --https --host 0.0.0.0 --port 8443

# Enable security auditing
export BS9_AUDIT_LOGGING=true
bs9 start app.js

# Secure web dashboard
bs9 web --port 8080  # Generates secure session token
```

### Security Documentation
- **[Security Policy](SECURITY.md)** - Complete security documentation
- **[Production Security Guide](PRODUCTION.md#security-hardening)** - Production security hardening

### Security Checklist
- [ ] Review service configurations
- [ ] Enable security audit logging
- [ ] Use proper file permissions
- [ ] Configure network firewalls
- [ ] Monitor security logs
- [ ] Regular security updates

## 📚 Documentation

- **[README.md](README.md)** - Complete getting started guide
- **[FAQ.md](FAQ.md)** - Frequently asked questions and answers
- **[COMMANDS.md](docs/COMMANDS.md)** - REST API documentation
- **[SECURITY.md](SECURITY.md)** - Security policies and reporting
- **[PRODUCTION.md](PRODUCTION.md)** - Production deployment guide
- **[CHANGELOG.md](CHANGELOG.md)** - Version history and updates
