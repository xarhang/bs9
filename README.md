# BS9 (Bun Sentinel 9)

[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![Version](https://img.shields.io/badge/version-1.6.10-blue.svg)](https://github.com/xarhang/bs9)
[![Security](https://img.shields.io/badge/security-hardened-green.svg)](SECURITY.md)
[![Tests](https://img.shields.io/badge/tests-328%20passing-brightgreen.svg)](https://github.com/xarhang/bs9/actions)
[![Cross-Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/xarhang/bs9)

**Self-healing process manager for Bun with zero-downtime clustering, real-time dashboards, TypeScript build support, and durable same-host state.**

Works on Windows, macOS, and Linux.

---

## Quick Start

### Install Globally

```bash
# Recommended: Install via Bun
bun add -g bs9

# Or install via npm
npm install -g bs9
```

### Verified Installer & Manual Setup

```bash
# Verified installer (installs Bun + BS9)
curl -fsSLO https://github.com/xarhang/bs9/releases/download/v1.6.10/setup.sh
sha256sum setup.sh && bash setup.sh

# Or manual install from source
git clone https://github.com/xarhang/bs9.git
cd bs9
bun install
bun link
```

### For macOS PATH configuration:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
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
- **Commands**: All 40 commands available

#### 🍎 macOS  
- **Service Manager**: Launchd
- **Features**: Native macOS integration, automatic recovery
- **Commands**: All commands work automatically on macOS

#### 🪟 Windows
- **Service Manager**: Windows Services / Dedicated Background Watchdog
- **Features**: Event log integration, non-admin background watchdog, exponential backoff recovery
- **Commands**: All commands work automatically on Windows (including save/resurrect all)

```bash
# Check your platform (auto-detected)
bs9 --help                    # Shows platform info in help

# Platform-specific service management (auto-detected)
bs9 start app.js             # Works on Linux, macOS, Windows
bs9 deploy app.js            # Works on all platforms
```

### Zero-Config Service Deployment

**One command configures and starts a managed service:**

```bash
# Deploy managed service
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
```

**What `bs9 deploy` does automatically:**
- ✅ Creates systemd service with security hardening
- ✅ Enables user services persistence (linger)
- ✅ Validates application-provided `/healthz` and `/metrics` endpoints
- ✅ Configures OpenTelemetry service/exporter environment variables
- ✅ Configures smart restart policies
- ✅ Performs health validation
- ✅ Shows management commands and access URLs

**Hot reload capabilities:**
```bash
# Update configuration without downtime
bs9 deploy app.ts --reload --env NEW_CONFIG=value
---

## 🛡️ High-Availability Self-Healing Runtime & State Hub

BS9 provides a **self-healing, same-host application runtime** for Bun. See the [High-Availability Runtime Guide](docs/HA_RUNTIME.md) for the exact guarantees, verification workflow, and single-host boundaries.

### 1. Primary UX: Zero-Code Stateless HA
```bash
bs9 start app.ts -i max
```
For supported Bun web workloads (`Bun.serve`, Hono, Elysia, Express on Bun), BS9 provides a tested continuous-availability path:
- **Kernel-Level Port Sharing (`SO_REUSEPORT`)**: Traffic flows directly to worker sockets via OS kernel load balancing. The BS9 lifecycle controller is **strictly out of the HTTP data path**—if the controller restarts, workers continue serving traffic without interruption.
- **Replace-First Rolling Reload**: `bs9 reload <app>` spawns replacement worker generation $g_{\text{next}}$, waits for an authenticated `READY` lifecycle signal, initiates a non-destructive 2-phase drain (`DRAIN_REQUEST` $\to$ `DRAINED`) on $g_{\text{curr}}$, and only stops the old worker once the new worker is actively serving.
- **Violent Crash Resilience**: If a worker suffers an unhandled crash or violent termination (`kill -9`), sibling workers on the shared socket continue accepting connections while BS9 resurrects the missing slot. Use `bs9 verify-ha` to measure dropped requests for the actual workload and environment.

### 2. Same-Host State Hub & Typed Client (`bs9/runtime`)
To prevent state loss when workers restart, BS9 includes a low-latency, local IPC State Hub:
- **Streaming Length-Prefixed IPC**: Big-endian 4-byte framing over Unix Domain Sockets or Windows Named Pipes with HMAC-SHA256 authentication.
- **In-Memory KV Engine**: TTL eviction, Compare-And-Swap (`cas`), and atomic counter increments (`incr`).
- **Distributed Leases**: Mutex and cron coordination with strictly monotonic fencing tokens and TTL automatic failover.
- **Durable Queues**: FIFO work queues with visibility timeouts, redelivery, and ack/nack semantics.
- **Write-Ahead Log (WAL)**: Append-only durability with CRC32 integrity verification and atomic snapshot compaction.

#### Using the Typed Runtime Client:
```typescript
import { State, Lease, Queue } from "bs9/runtime";

// Synchronized state across cluster workers
const state = new State();
await state.set("cart:user-123", { items: ["book", "coffee"] }, { ttlMs: 3600_000 });
const cart = await state.get("cart:user-123");

// Singleton cron job (runOnce callback receives no arguments)
const lease = new Lease();
const executed = await lease.runOnce(
  "nightly-reconciliation",
  async () => reconcileNightly(),
  { ttlMs: 60_000 },
);

// Durable FIFO work queue
const queue = new Queue();
await queue.push("email-jobs", { to: "user@example.com", template: "welcome" });
const job = await queue.pop("email-jobs", { timeoutMs: 5000 });
```

#### Strict Fallback Policy
- **Standalone Mode**: If your application runs outside BS9 (e.g. locally in dev via `bun run app.ts`), `bs9/runtime` gracefully falls back to local in-memory execution without throwing errors.
- **Cluster Strictness**: When running inside BS9 (`BS9_CLUSTER_NAME`), if the State Hub is unreachable, operations fail loudly with actionable diagnostics to prevent silent split-brain state. (Opt-in degraded local fallback is available via `BS9_ALLOW_DEGRADED_LOCAL=true`).

### 3. Zero-Code Compatibility Adapters (`express-session`)
For existing Express and Connect applications running on Bun, BS9 automatically intercepts `express-session`:
- **Tested Version Matrix**: `1.17.x` - `1.18.x`.
- **Zero Configuration**: Calling `session({ secret: "..." })` without an explicit store automatically mounts `Bs9SessionStore`, backed by the State Hub KV engine. Sessions persist seamlessly across worker reloads and crashes.
- **Standalone Safety**: Automatically falls back to native `MemoryStore` when executed outside BS9.

### 4. Verification & Diagnostic Tooling
BS9 provides built-in tools to inspect and prove high availability before deploying to production:

#### Static Analysis: `bs9 inspect-ha`
```bash
bs9 inspect-ha src/app.ts
```
Scans your entry file and dependencies to classify your app into HA readiness tiers:
- **Tier 1 (Stateless HA Ready)**: No unsafe state pattern was detected by static inspection; confirm behavior with `bs9 verify-ha` before production.
- **Tier 2 (Managed HA Ready)**: Utilizes `bs9/runtime` for coordinated state, leases, and queues.
- **Tier 3 (In-Memory State Warning)**: Highlights unsafe module-level mutable variables (`let`, `Map`, `Set`) that risk data loss on worker restart, with suggested refactors.

#### Dynamic Fault-Injection: `bs9 verify-ha`
```bash
bs9 verify-ha src/app.ts
```
- Spawns an isolated sandbox cluster on an ephemeral port without touching production.
- Generates concurrent HTTP traffic across cluster slots.
- Executes automated rolling reload and violent worker crash (`kill -9`).
- Quantifies availability (%), dropped requests, and latency percentiles (p50, p95, p99).

### 5. Clear Product Boundaries & Guarantees
- **No Arbitrary Heap Replication**: BS9 does not pretend arbitrary JavaScript variables (`let x = 1`) can be magically synced across isolated OS processes. Use `bs9/runtime` (`State`) for shared state.
- **No Global Monkey-Patching**: BS9 never alters Web-standard `BroadcastChannel` or injects polluted globals like `globalThis.shared`.
- **Zero-Code Scope**: Zero-code HA is strictly guaranteed for supported stateless HTTP entry points and tested adapters. Custom in-memory caches and state machines require explicit `bs9/runtime` constructs.

---

## 📋 Complete CLI Commands

### Service Management
```bash
# Start service with flexible host and protocol options
bs9 start app.js                                    # Default: localhost:3000, HTTP
bs9 start app.js --host 0.0.0.0 --port 8080        # Custom host and port
bs9 start app.js --host 192.168.1.100 --https      # Custom host with HTTPS
bs9 start app.ts --build --name myapp --port 8080 --env NODE_ENV=production --host 0.0.0.0 --https

# Bun-Native Zero-Downtime Clustering (NEW!)
bs9 start app.ts -i 4 --port 3000                  # Spawn 4 workers on same port (reusePort)
bs9 start app.ts -i max --name my-api              # Spawn workers matching CPU count

# 🐍 Polyglot Multi-Runtime (Python, Go, Binaries, Shell)
bs9 start worker.py                                 # Auto-detected Python runtime
bs9 start main.go                                   # Auto-detected Go runtime
bs9 start api.exe                                   # Native Windows/Linux binary
bs9 start script.sh                                 # Bash / Shell script
bs9 start app.rb --interpreter ruby                 # Custom runtime interpreter

# 🔄 Import common ecosystem configuration fields
bs9 start ecosystem.config.js                      # Load supported ecosystem fields
bs9 start bs9.config.json                          # Load multi-app config

# 🆕 Multi-Service Management (NEW!)
bs9 start [app1, app2, app3]                       # Start multiple services
bs9 start [app-*]                                   # Start services matching pattern
bs9 start all                                      # Start all services
bs9 stop [app1, app2]                              # Stop multiple services
bs9 stop [web-*]                                   # Stop services matching pattern
bs9 stop svc1 svc2 svc3                            # Stop specific list (space separated)
bs9 stop all                                       # Stop all services (with confirmation)
bs9 restart [app1, app2, app3]                     # Restart multiple services
bs9 restart [*-prod]                               # Restart services matching pattern
bs9 restart all                                    # Restart all services (with confirmation)
bs9 delete [test-*]                                # Delete services matching pattern
bs9 delete all                                     # Delete all services (with confirmation)
bs9 status [app1, app2, app3]                      # Status of multiple services
bs9 status [web-*]                                 # Status of services matching pattern
bs9 status all                                     # Status of all services

# Stop service
bs9 stop myapp

# Restart service
bs9 restart myapp

# 🔄 Zero-Downtime Reload
bs9 reload myapp                                   # Rolling reload across cluster workers

# 📈 Dynamic Cluster Scaling
bs9 scale myapp 6                                  # Scale to exactly 6 workers
bs9 scale myapp +2                                 # Scale up by 2 workers
bs9 scale myapp -1                                 # Scale down by 1 worker

# 🔄 Reset Crash History & Counters
bs9 reset myapp                                    # Reset circuit breaker & crash history
bs9 reset all                                      # Reset all services

# 📡 Send OS Signal
bs9 sendSignal SIGUSR2 myapp                       # Send SIGUSR2 to app process
bs9 sendSignal SIGINT myapp                        # Graceful interrupt

# 🏓 Ping Daemon
bs9 ping                                           # Verify BS9 daemon responsiveness

# 📋 Generate Ecosystem Config
bs9 init                                           # Generate ecosystem.config.js
bs9 ecosystem --ts                                 # Generate ecosystem.config.ts
bs9 ecosystem --json                               # Generate bs9.config.json

# System Boot Startup
bs9 startup                                        # Configure auto-resurrect on OS reboot
bs9 unstartup                                      # Remove auto-resurrect on reboot

# 🌐 Inspect Environment Variables
bs9 env myapp                                      # Dump configured environment variables

# 🤖 Native Model Context Protocol (MCP) for AI Assistants (Claude, Cursor)
bs9 mcp                                            # Launch stdio MCP server
bs9 mcp --install                                  # Output JSON snippet for Claude Desktop / Cursor

# 🐛 Issue & Exception Tracker Dashboard
bs9 issues                                         # Aggregated exceptions & crash traces across all services
bs9 issues myapp                                   # Inspect issues for specific service
bs9 issues myapp --lines 200                       # Inspect deeper error logs
bs9 issues --json                                  # Machine-readable output for monitoring pipelines
bs9 issues --clear                                 # Clear error logs and reset crash state

# 🔍 Describe / Show details
bs9 show myapp                                     # Inspect PIDs, paths, logs, self-healing status
bs9 describe myapp                                 # Alias for show

# 🧹 Flush / Empty logs
bs9 flush                                          # Flush all service logs
bs9 flush myapp                                    # Flush logs for specific service

# Enhanced status display with visual indicators
bs9 status                                         # Show all services
bs9 status --json                                  # Output JSON array
bs9 list                                           # Alias for status
bs9 ls                                             # Short alias for status
bs9 ps                                             # UNIX alias for status
bs9 status myapp                                   # Show specific service

# View logs (combined or per-service)
bs9 logs                                           # Combined logs for ALL services
bs9 logs myapp                                     # Show logs for specific service
bs9 logs myapp --follow                            # Follow logs in real-time
bs9 logs myapp --lines 50                          # Show last 50 lines

# Delete services
bs9 delete myapp                                   # Delete specific service
bs9 delete myapp --remove                          # Delete and remove config files
bs9 delete --all                                   # Delete all services
bs9 delete --all --force                           # Force delete all services

# 🛡️ High-Availability Diagnostics & Verification (NEW!)
bs9 inspect-ha app.ts                               # Static analysis of HA readiness (Tier 1/2/3)
bs9 inspect-ha app.ts --json                        # Machine-readable report for CI/CD
bs9 verify-ha app.ts                                # Ephemeral traffic test with rolling reload & crash injection
bs9 verify-ha app.ts --json                         # Verification metrics and latency percentiles

# ⚙️ Persistent Controller & Hub Daemon
bs9 daemon status                                  # Check daemon status and controller PID
bs9 daemon start                                   # Ensure daemon is running in background
bs9 daemon stop                                    # Stop persistent daemon
bs9 daemon start --foreground                      # Run daemon in foreground (for systemd/launchd)

# Deploy applications (KILLER FEATURE)
bs9 deploy app.ts                                  # Zero-config deployment
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
bs9 deploy app.ts --reload --env NEW_CONFIG=value   # Hot reload with new config
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
```

---

## 🎯 Key Features

### ✅ **Zero-Config Deployment**: One-command setup with `bs9 deploy`
- **One-Command Setup**: `bs9 deploy app.ts` does everything automatically
- **Hardened Defaults**: Security sandboxing, health checks, metrics enabled
- **Hot Reload**: Update configurations without downtime
- **Port Detection**: Automatic service discovery and access URLs
- **Environment Management**: Easy environment variable updates

### **Bun-Native Zero-Downtime Clustering** with `SO_REUSEPORT`
- **Kernel Load Balancing**: Multiple Bun processes bind the exact same port transparently
- **Preload Hook**: Automatic injection of `reusePort: true` into `Bun.serve(...)`
- **High Concurrency**: Exploit all CPU cores with `bs9 start app.ts -i max`

### 🔄 **Ecosystem Configuration Import**:
- **Familiar Format**: Run `bs9 start ecosystem.config.js` directly
- **Supported Fields**: Maps `script`, `instances`, `env`, `port`, `cwd`, and `args`; unsupported PM2-specific behavior is not implied

### 🛡️ **Smart Self-Healing & Exponential Backoff**:
- **Crash Loop Circuit Breaker**: Halts infinite restart storms (5 crashes / 60s trigger)
- **Exponential Backoff**: Delays restarts smoothly (1s → 2s → 4s → 8s → 16s → 60s)
- **Dedicated Watchdog**: Non-admin background supervisor on Windows persists after CLI exits

### 🌐 **Modern Web Dashboard**: Real-time Glassmorphism UI
- **WebSocket Streaming**: Live metric push every 2 seconds without HTTP polling overhead
- **Control Actions**: Start, stop, and restart directly from the browser with Bearer token authentication
- **Dark Glassmorphism Design**: High-contrast, responsive metrics layout

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

### 🛡️ Security & Sandboxing
- **Pre-start Audit**: Scan for eval(), child_process.exec(), etc.
- **User-mode Systemd**: Zero root operation required
- **Systemd Hardening**: PrivateTmp, ProtectSystem, NoNewPrivileges
- **Resource Limits**: CPU, memory, file descriptor limits
- **Port Warnings**: Alert for privileged ports (< 1024)

### ⚡ TypeScript Runtime & Build Support
- **Direct Mode**: Run `.ts` files with Bun (default)
- **Build Mode**: Bundle and minify TypeScript to JavaScript before starting (`--build`)
- **Build Directory**: `.bs9-build/` for generated artifacts

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

BS9 offers familiar lifecycle commands for PM2 users, but it is not a drop-in replacement. Verify service-manager behavior, ecosystem fields, clustering, and observability in your target environment before migrating.

| PM2 command | Closest BS9 command | Notes |
|-------------|---------------------|-------|
| `pm2 start app.js` | `bs9 start app.js` | Runs through the native service manager for the current OS |
| `pm2 stop app` | `bs9 stop app` | Stops the managed service |
| `pm2 restart app` | `bs9 restart app` | Restarts the managed service |
| `pm2 list` | `bs9 status` | Supports table, watch, and JSON output |
| `pm2 logs app` | `bs9 logs app` | Reads service-specific output and error logs |
| `pm2 monit` | `bs9 monit` | Opens the terminal dashboard |

Common ecosystem fields currently mapped by BS9 include `script`, `instances`, `env`, `port`, `cwd`, and `args`. Review the generated service configuration when migrating.

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
│   └── bs9                     # CLI entry point
├── src/
│   ├── commands/               # CLI command implementations
│   │   ├── start.ts            # Start single or clustered workloads
│   │   ├── reload.ts           # Replace-first rolling reload
│   │   ├── scale.ts            # Cluster scaling
│   │   ├── daemon.ts           # Supervisor daemon command
│   │   ├── inspect-ha.ts       # Static HA compatibility checks
│   │   └── verify-ha.ts        # Bounded live HA verification
│   ├── cluster/                # Worker lifecycle and control clients
│   ├── daemon/                 # Topology reconciliation and recovery
│   ├── hub/                    # State Hub, WAL, leases, and queues
│   ├── runtime/                # Typed bs9/runtime client APIs
│   ├── platform/               # Cross-platform detection and paths
│   ├── alerting/               # Alert configuration
│   ├── database/               # Database monitoring helpers
│   ├── discovery/              # Service discovery
│   ├── loadbalancer/           # Load-balancer integration
│   ├── monitoring/             # Metrics and process monitoring
│   ├── storage/                # Metrics persistence
│   ├── injectors/              # Runtime auto-injection
│   ├── mcp/                    # MCP integration
│   ├── web/                    # Web dashboard
│   ├── windows/                # Windows service support
│   ├── macos/                  # launchd support
│   ├── docker/                 # Container assets
│   ├── k8s/                    # Kubernetes manifests
│   ├── utils/                  # Shared utilities
│   └── index.ts                # Package exports
├── tests/                  # Unit, integration, lifecycle, and HA tests
├── docs/                   # Command, API, and HA runtime guides
├── examples/               # Runnable example applications
├── configs/                # Service configuration templates
├── scripts/                # Build, release, and verification tooling
├── setup.sh                # One-click installer
├── docker-compose.yml      # Docker stack
├── package.json            # Package metadata and scripts
├── ARCHITECTURE.md         # System architecture
├── PRODUCTION.md           # Production operations guide
└── README.md               # Project overview
```

---

## Production Deployment

### System Requirements & Health Check
```bash
# Check BS9 installation and system compatibility
bs9 doctor                    # Basic health check
bs9 doctor --verbose          # Detailed system information
bs9 doctor --check platform   # Check platform-specific setup
bs9 -V                        # Show BS9 version

# System inspection
bs9 inspect                    # Basic inspection
bs9 inspect --full              # Complete system inspection
bs9 inspect --security         # Security inspection only
bs9 inspect --performance      # Performance inspection only
bs9 inspect --configuration    # Configuration inspection only
bs9 inspect --compliance       # Compliance inspection only
bs9 inspect --report json       # Export inspection report
```

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

BS9 is licensed under the **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)**. See [LICENSE](LICENSE) for the complete terms.

You may use, study, modify, and redistribute BS9 under the AGPL. If you modify BS9 and make the modified program available to users over a network, you must offer those users the corresponding source as required by AGPL section 13. Releases previously published under the MIT License remain available under the terms that applied to those releases.

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
- **Security**: [Security Policy](SECURITY.md)

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

# The pre-start security pattern audit runs automatically
bs9 start app.js

# Secure web dashboard
bs9 web --port 8080  # Generates secure session token
```

### Security Documentation
- **[Security Policy](SECURITY.md)** - Complete security documentation
- **[Production Security Guide](PRODUCTION.md#security-hardening)** - Production security hardening

### Security Checklist
- [ ] Review service configurations
- [ ] Review and resolve pre-start security audit findings
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
