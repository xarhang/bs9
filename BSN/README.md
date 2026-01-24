# BS9 (Bun Sentinel 9)

> Mission-critical process manager CLI with real-time monitoring dashboard, historical metrics storage, alert system, container support, and enterprise-grade security.

---

## 🚀 Quick Start

```bash
# One-click installer (installs Bun + BS9)
curl -fsSL https://raw.githubusercontent.com/your-org/bsn/main/setup.sh | bash

# Or manual install
git clone https://github.com/your-org/bsn.git
cd bsn
bun install
cp bin/bs9 ~/.local/bin/bs9
chmod +x ~/.local/bin/bs9
```

---

## 📋 Complete CLI Commands

### Service Management
```bash
# Start service with TypeScript JIT/AOT support
bs9 start app.js                    # JavaScript app
bs9 start app.ts --build          # TypeScript AOT compilation
bs9 start app.ts --name myapp --port 8080 --env NODE_ENV=production

# Service lifecycle
bs9 stop myapp
bs9 restart myapp
bs9 status                         # SRE metrics dashboard
bs9 logs myapp --follow
```

### Monitoring & Observability
```bash
# Real-time terminal dashboard
bs9 monit                         # 2s refresh default
bs9 monit --refresh 5              # Custom refresh interval

# Web-based dashboard
bs9 web --port 8080               # Start web dashboard
bs9 web --detach --port 8080       # Run in background

# Alert management
bs9 alert --list                   # Show alert configuration
bs9 alert --cpu 80 --memory 85      # Set thresholds
bs9 alert --webhook https://hooks.slack.com/...
bs9 alert --test                   # Test webhook

# Historical data
bs9 export --format json --hours 24 # Export metrics
bs9 export --service myapp --format csv
```

---

## 🎯 Key Features

### 🔍 Real-time Monitoring
- **Terminal Dashboard**: Live terminal UI with color-coded status
- **Web Dashboard**: Browser-based monitoring with auto-refresh
- **Health Checks**: Automatic `/healthz`, `/readyz`, `/metrics` endpoints
- **SRE Metrics**: CPU, Memory, Uptime, Task tracking

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
kubectl get pods -n bs9-system
kubectl get services -n bs9-system
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
git clone https://github.com/xarhang/bsn.git
cd bsn
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
```bash
# One-click install
curl -fsSL https://raw.githubusercontent.com/bsn/bsn/main/setup.sh | bash

# Manual install
git clone https://github.com/xarhang/bsn.git
cd bsn
bun install
cp bin/bs9 ~/.local/bin/bs9
chmod +x ~/.local/bin/bs9
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

MIT License - see LICENSE file for details.

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

---

## 🔗 Links

- **GitHub**: https://github.com/xarhang/bsn
- **Issues**: https://github.com/xarhang/bsn/issues
- **Documentation**: https://github.com/xarhang/bsn/wiki
- **Discussions**: https://github.com/xarhang/bsn/discussions
