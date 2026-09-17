# BS9 Architecture

## Overview

BS9 (Bun Sentinel 9) is a mission-critical process manager CLI designed to replace PM2 with enhanced security, observability, and real-time monitoring capabilities. Built on Bun runtime with systemd user mode integration.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        User Space (user@host)                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  BS9 CLI (bs9)                                              │  │
│  │  ├── Commands (start, stop, restart, status, logs, monit, web, alert, export)     │  │
│  │  ├── Monitoring (real-time dashboard, web dashboard, historical storage)     │  │
│  │  ├── Alerting (thresholds, webhooks, notifications)                     │  │
│  │  └── Storage (metrics persistence, historical data)                           │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │
│  │  │  Systemd User Services (bs9-managed)                              │  │
│  │  │  ├── myapp.service                                                │  │
│  │  │  ├── api.service                                                  │  │
│  │  │  └── webapp.service                                               │  │
│  │  │                                                               │  │
│  │  └─────────────────────────────────────────────────────────────┘  │
│  │                                                               │
│  │  ┌─────────────────────────────────────────────────────────────┐  │
│  │  │  Applications (Bun processes)                                      │  │
│  │  │  ├── myapp (TypeScript/JavaScript)                                     │  │
│  │  │  ├── api (Node.js)                                                   │  │
│  │  │  └── webapp (Bun)                                                    │  │
│  │  │                                                               │ │
│  │  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. CLI Interface (`bin/bs9`)
- **Entry point**: Main CLI executable
- **Command Router**: Uses Commander.js for command parsing
- **Commands**:
  - `start`: Service management with security audit
  - `stop/restart`: Service lifecycle management
  - `status`: SRE metrics dashboard
  - `logs`: Log viewing via journalctl
  - `monit`: Real-time terminal dashboard
  - `web`: Web-based monitoring dashboard
  - `alert`: Alert configuration
  - `export`: Historical data export

### 2. Command Modules (`src/commands/`)
- **start.ts**: Service startup with TypeScript JIT/AOT, Bun-native clustering (`-i max`), and `ecosystem.config.js` loader
- **stop.ts**: Service termination
- **restart.ts**: Service restart
- **status.ts**: Status and SRE metrics
- **logs.ts**: Log streaming
- **monit.ts**: Terminal dashboard
- **web.ts**: Web dashboard server with WebSocket live streaming and action endpoints
- **alert.ts**: Alert management
- **export.ts**: Data export functionality

### 3. Core Engine & Resilience Utilities (`src/utils/`)
- **cluster-preload.ts**: Runtime hook injecting `reusePort: true` into `Bun.serve(...)` for zero-downtime clustering
- **ecosystem-config.ts**: Parser translating PM2 config files (`ecosystem.config.js`, `bs9.config.json`) into BS9 execution plans
- **crash-tracker.ts**: Crash loop detector and exponential backoff calculator (1s → 2s → 4s → 8s → 16s → 60s)
- **watchdog-agent.ts**: Non-admin Windows background supervisor maintaining independent service persistence

### 4. Monitoring System

#### Terminal Dashboard (`src/commands/monit.ts`)
- **Real-time Updates**: Configurable refresh intervals
- **Service Metrics**: CPU, Memory, Uptime, Tasks
- **Health Checks**: Automatic endpoint monitoring
- **Alert Integration**: Visual alert notifications
- **Color Coding**: Status indicators

#### Web Dashboard (`src/web/dashboard.ts`)
- **Browser Interface**: Modern Glassmorphism dark UI
- **WebSocket Streaming**: 2-second real-time telemetry push
- **Control Actions**: Start, stop, and restart directly with Bearer token authentication
- **Cluster Hierarchy**: Worker group visualization

#### Metrics Storage (`src/storage/metrics.ts`)
- **Local Storage**: JSON-based persistence
- **Time-series Data**: Timestamped metric snapshots
- **Data Export**: JSON and CSV formats
- **Automatic Cleanup**: Retention policies
- **Aggregation**: CPU/Memory averages

### 4. Alert System (`src/alerting/config.ts`)
- **Threshold Management**: CPU, Memory, Error Rate, Uptime
- **Webhook Support**: HTTP notification delivery
- **Service-specific**: Per-service alert configuration
- **Cooldown Period**: Prevent alert spam
- **Alert Testing**: Connectivity validation

### 5. Auto-injection (`src/injectors/otel.ts`)
- **OpenTelemetry**: Distributed tracing
- **Prometheus**: Metrics collection
- **Health Endpoints**: `/healthz`, `/readyz`, `/metrics`

## Data Flow

### Service Startup Flow
```
1. User runs: `bs9 start app.ts --name myapp`
2. Security Audit: Scan file for dangerous patterns
3. TypeScript Handling:
   - JIT: Run `.ts` directly
   - AOT: Compile to optimized JS with `--build`
4. Systemd Unit Generation:
   - Create hardened user service unit
   - Apply security hardening
   - Set environment variables
5. Service Registration:
   - Enable and start via `systemctl --user`
   - Begin monitoring and alerting
```

### Monitoring Data Flow
```
1. Metrics Collection:
   - Systemd service status polling
   - Health endpoint checking
   - Resource usage tracking
2. Data Storage:
   - Store snapshots in `~/.config/bs9/metrics/`
   - Automatic cleanup based on retention policy
3. Alert Processing:
   - Threshold comparison
   - Webhook notification
   - Cooldown enforcement
4. Dashboard Updates:
   - Terminal UI refresh
   - Web API polling
   - Real-time status updates
---

## 🛡️ High-Availability (HA) Self-Healing Runtime Architecture

BS9 separates high-availability into two orthogonal tiers. The normative operational boundaries are documented in the [High-Availability Runtime Guide](docs/HA_RUNTIME.md).
1. **Stateless HTTP Workloads (Zero-Code)**: Supported web apps achieve continuous uptime during reloads and worker crashes without application code modifications.
2. **Coordinated Stateful Workloads (Managed State)**: Stateful applications use the same-host State Hub via `bs9/runtime` to eliminate in-memory split-brain or data loss.

### 1. Data Path vs Control Path Separation

```
         Incoming HTTP Requests (:3000)
                     │
        ┌────────────┴────────────┐  (OS Kernel Socket Load Balancing - SO_REUSEPORT)
        ▼                         ▼
┌─────────────────┐       ┌─────────────────┐
│ Worker Slot 0   │       │ Worker Slot 1   │
│ (Bun.serve)     │       │ (Bun.serve)     │
└────────┬────────┘       └────────┬────────┘
         │ (IPC Channel)           │ (IPC Channel)
         │                         │
         └────────────┬────────────┘
                      ▼
        ┌───────────────────────────┐
        │  BS9 Lifecycle Controller │ (Out of HTTP Data Path)
        │  & Same-Host State Hub    │
        └───────────────────────────┘
```

- **Zero Data-Path Overhead**: HTTP traffic is handled directly by Bun worker processes.
- **Controller Crash Immunity**: If the BS9 controller or State Hub restarts, worker HTTP traffic continues serving uninterrupted.

### 2. Logical Slots vs Physical Generations

To guarantee zero dropped requests during rolling upgrades, BS9 decouples logical cluster slots from physical service units:
- **Logical Slot**: `<cluster>-<slot>` (e.g. `api-0`, `api-1`)
- **Physical Unit**: `<cluster>-<slot>-g<gen>` (e.g. `api-0-g1`, `api-0-g2`)

#### Replace-First Rolling Reload Flow:
```
Time ──►

Slot 0: [ g1 Running ] ─────────────► [ 2-Phase Drain ] ──► [ Stopped ]
              │                               ▲
              ▼                               │
        [ Spawn g2 ] ──► [ Authenticated READY ]
                               │
Slot 0:                        ▼
                         [ g2 Running ] ────────────────────────►
```
1. **Spawn Replacement**: BS9 spawns physical unit $g_{\text{next}}$ while $g_{\text{curr}}$ continues serving traffic.
2. **Readiness Verification**: $g_{\text{next}}$ completes bootstrap, binds its port (`reusePort`), and sends an authenticated `READY` lifecycle signal to the controller.
3. **Two-Phase Graceful Drain**: The controller sends `DRAIN_REQUEST` to $g_{\text{curr}}$. $g_{\text{curr}}$ closes its listening socket, awaits active in-flight HTTP requests, and responds with `DRAINED`.
4. **Physical Unit Teardown**: BS9 stops and unregisters the old physical unit $g_{\text{curr}}$.
5. **Atomic Rollback**: If $g_{\text{next}}$ crashes or fails readiness within timeout, $g_{\text{curr}}$ remains active and the upgrade aborts safely.

### 3. Same-Host State Hub & WAL Persistence

The State Hub provides high-speed, local coordination across cluster workers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BS9 State Hub Engine                            │
├────────────────────────────────────────────────────────────────────────┤
│ ┌───────────────────┐ ┌───────────────────┐ ┌────────────────────────┐ │
│ │  In-Memory KV     │ │ Distributed Lease │ │ Durable Queues         │ │
│ │  - TTL Eviction   │ │ - Fencing Tokens  │ │ - Visibility Timeout   │ │
│ │  - CAS & Incr     │ │ - TTL Auto-Fail   │ │ - Redelivery & Ack/Nack│ │
│ └─────────┬─────────┘ └─────────┬─────────┘ └───────────┬────────────┘ │
│           └─────────────────────┼───────────────────────┘              │
│                                 ▼                                      │
│           ┌──────────────────────────────────────────────┐             │
│           │ Write-Ahead Log (WAL) & Snapshot Compactor    │             │
│           │ - Append-only wal.log with CRC32 checksums   │             │
│           │ - Atomic snapshot.json via tempfile rename   │             │
│           └──────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────────────────┘
```

- **Wire Protocol**: 4-byte unsigned big-endian length prefix framing with streaming defragmentation (`StreamingFrameDecoder`).
- **Mutual Authentication**: Nonce challenge-response handshake signed with HMAC-SHA256 using an unreadable `0600` token file.
- **Lease Fencing**: Guarantees strictly monotonic fencing tokens ($1, 2, 3\dots$) across leadership handovers to prevent split-brain zombies.
- **Queue Semantics**: FIFO queuing with redelivery upon worker crash or visibility timeout expiration.

### 4. Typed Client (`bs9/runtime`) & Fallback Matrix

The `bs9/runtime` package exposes `State`, `Lease`, `Queue`, and `Events`:
- **Standalone Mode (Outside BS9)**: Runs purely in-memory with zero dependencies and no errors.
- **Cluster Mode (Inside BS9)**: Connects to local State Hub IPC. If Hub is unavailable, fails loudly by default to prevent silent inconsistency (or degraded in-memory if `allowDegradedLocal: true`).

### 5. Compatibility Adapters (`express-session`)
- Zero-code interceptor wraps `express-session` when `options.store` is omitted inside a BS9 cluster.
- Tested and verified against express-session versions `1.17.x` - `1.18.x`.
- Persists session state transparently in State Hub KV with automatic cookie TTL synchronization.

### 6. Verification & Diagnostic Engine (`inspect-ha` & `verify-ha`)
- `bs9 inspect-ha <file>`: Static AST/code analysis identifying framework entry points, in-memory mutable variables (`let`, `Map`, `Set`), and classifying workloads into Tier 1, 2, or 3.
- `bs9 verify-ha <file>`: Spawns an isolated sandbox cluster on an ephemeral port, generates concurrent HTTP traffic, triggers rolling reloads and violent worker termination, and reports measured availability, dropped requests, and latency. A passing run applies to the tested workload and environment.

---

## Security Architecture

### Process Management Model
- **Linux**: Systemd User Services (`systemd --user`)
- **macOS**: Launchd Agents (`~/Library/LaunchAgents`)
- **Windows**: Background Processes with Registry Persistence
- **Common Features**:
  - **Isolation**: Services run as non-root user
  - **Persistence**: Platform-native autostart
  - **Resource Limits**: Memory, CPU, file descriptors
  - **Sandboxing**: Platform-specific hardening

### Pre-start Security Audit
```typescript
interface SecurityAuditResult {
  critical: string[];
  warning: string[];
}

// Dangerous patterns to block
const dangerousPatterns = [
  { pattern: /eval\s*\(/, msg: "Use of eval() detected" },
  { pattern: /Function\s*\(/, msg: "Dynamic function construction" },
  { pattern: /child_process\.exec\s*\(/, msg: "Unsafe child_process.exec()" },
  { pattern: /require\s*\(\s*["']fs["']\s*\)/, msg: "Direct fs module usage" },
  { pattern: /process\.env\.\w+\s*\+\s*["']/, msg: "Potential command injection" },
];
```

### Systemd Hardening
```ini
[Service]
Type=simple
Restart=on-failure
RestartSec=2s
TimeoutStartSec=30s
TimeoutStopSec=30s
WorkingDirectory=/path/to/app
ExecStart=/path/to/bun run /path/to/app

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
```

## Performance Considerations

### JIT vs AOT Compilation
- **JIT Mode**:
  - Faster startup time
  - Development-friendly
  - Direct TypeScript execution
- **AOT Mode**:
  - Optimized runtime performance
  - Smaller memory footprint
  - Production-ready

### Resource Efficiency
- **Memory Usage**: ~512MB base + per-service allocation
- **CPU Overhead**: < 1% for monitoring
- **Storage**: JSON-based with automatic cleanup
- **Network**: Minimal HTTP overhead for health checks

### Scalability
- **Service Limit**: 1000+ services per user
- **Metrics Retention**: 1000 snapshots (configurable)
- **Alert Rate**: 1 alert per service per cooldown period
- **Concurrent Users**: Multi-user support via systemd

## Container Architecture

### Docker Implementation
```dockerfile
FROM oven/bun:1.3.6-alpine

# Security
RUN adduser -u 1000 -s /bin/sh
RUN chmod +x /bin/sh

# Application
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY bin/ ./bin/
COPY src/ ./src/

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3
CMD curl -f http://localhost:8080/ || exit 1
```

### Kubernetes Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bs9-manager
  namespace: bs9-system
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: bs9-manager
        image: bs9:latest
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          readOnlyRootFilesystem: true
```

## Integration Points

### External Systems
- **Systemd User Mode**: Service lifecycle management
- **Journalctl**: Log aggregation and streaming
- **OpenTelemetry**: Distributed tracing to external collectors
- **Prometheus**: Metrics collection via scraping
- **Webhooks**: Alert notifications to external systems

### Configuration Files
- **`~/.config/bs9/config.toml`**: Main configuration
- **`~/.config/bs9/alerts.json`**: Alert configuration
- **`~/.config/systemd/user/*.service`**: Generated service units
- **`~/.config/bs9/metrics/*.json`**: Historical metrics

### Environment Variables
- `NODE_ENV`: Application environment
- `PORT`: Service port override
- `SERVICE_NAME`: Service identification
- `OTEL_SERVICE_NAME`: OpenTelemetry service name
- `WEB_DASHBOARD_PORT`: Web dashboard port

## Deployment Patterns

### Development Workflow
```bash
# Local development
bs9 start app.ts --name dev-app --env NODE_ENV=development
bs9 monit --refresh 1
bs9 web --detach

# Testing
bs9 export --format json --hours 1
bs9 alert --test
```

### Production Deployment
```bash
# Production service
bs9 start app.ts --build --name prod-app --env NODE_ENV=production
bs9 alert --cpu 90 --memory 90 --webhook https://hooks.company.com/alerts
bs9 web --detach --port 8080

# Monitoring
bs9 monit --refresh 5
bs9 export --format csv --hours 24
```

### Container Orchestration
```bash
# Docker
docker-compose up -d
kubectl apply -f src/k8s/bs9-deployment.yaml
```

## Extensibility

### Plugin Architecture
BS9 is designed with extensibility in mind:
- **Custom Commands**: Add new CLI commands
- **Custom Injectors**: Add new auto-injection modules
- **Custom Storage**: Implement alternative backends
- **Custom Alerts**: Add new notification channels

### Configuration Schema
- **TOML-based**: Human-readable configuration
- **JSON Schema**: Alert configuration
- **Environment Variables**: Runtime overrides
- **CLI Flags**: Command-line options

### API Integration
- **REST API**: Web dashboard provides `/api/metrics` endpoint
- **WebSocket**: Real-time updates for web dashboard
- **File System**: Local metrics storage access
- **Systemd D-Bus**: Service state changes

## Monitoring and Observability

### Metrics Collection
- **Service State**: Active, inactive, failed, activating
- **Resource Usage**: CPU time, memory consumption
- **Health Status**: HTTP endpoint responses
- **Uptime Tracking**: Service availability
- **Task Count**: Number of processes/threads

### Alert Types
- **Threshold Alerts**: CPU, Memory, Error Rate, Uptime
- **Health Alerts**: Service health check failures
- **System Alerts**: Systemd service failures
- **Custom Alerts**: User-defined alert conditions

### Data Visualization
- **Terminal Dashboard**: Real-time ASCII/ANSI charts
- **Web Dashboard**: Modern web interface with charts
- **Historical Trends**: Time-series data visualization
- **Service Dependencies**: Visual service relationships

## Reliability Features

### Fault Tolerance
- **Auto-restart**: Automatic recovery from crashes
- **Health Monitoring**: Continuous health checking
- **Alert Escalation**: Multi-level notification
- **Graceful Degradation**: Performance under load

### Data Persistence
- **Metrics Retention**: Configurable data retention
- **Backup Support**: Export capabilities
- **Recovery**: Service state restoration
- **Audit Trail**: Complete action logging

### High Availability
- **Process Isolation**: User-mode systemd services
- **Load Distribution**: Multiple services per user
- **Resource Management**: Prevent resource exhaustion
- **Service Discovery**: Automatic service detection

BS9's architecture is designed for enterprise-grade reliability while maintaining simplicity and ease of use. The modular design allows for easy extension and customization based on specific organizational needs.
