---
layout: default
title: CLI Commands
description: Complete command reference for managing services with BS9.
permalink: /commands/
---

# BS9 CLI Commands Documentation

## Overview

BS9 (Bun Sentinel 9) provides 39 powerful CLI commands for managing Bun and polyglot applications. All commands are designed to be intuitive, secure, and production-ready with automatic platform detection (Linux systemd, macOS launchd, and Windows services/watchdog) and zero-configuration setup.

---

## 📑 Command Categories

- [Core Process Lifecycle](#-core-process-lifecycle)
  - [`bs9 start`](#1-bs9-start---start-applications)
  - [`bs9 stop`](#2-bs9-stop---stop-applications)
  - [`bs9 restart`](#3-bs9-restart---restart-applications)
  - [`bs9 reload`](#4-bs9-reload---zero-downtime-rolling-reload)
  - [`bs9 delete`](#5-bs9-delete---delete-services)
  - [`bs9 scale`](#6-bs9-scale---dynamic-cluster-scaling)
  - [`bs9 reset`](#7-bs9-reset---reset-restart-counters--circuit-breaker)
  - [`bs9 sendSignal`](#8-bs9-sendsignal---send-os-signals)
  - [`bs9 ping`](#9-bs9-ping---daemon-healthcheck)
- [Status, Inspection & Observability](#-status-inspection--observability)
  - [`bs9 status` / `list` / `ls` / `ps`](#10-bs9-status--list--ls--ps---process-status-dashboard)
  - [`bs9 show` / `describe`](#11-bs9-show--describe---detailed-process-inspection)
  - [`bs9 logs`](#12-bs9-logs---view-application-logs)
  - [`bs9 flush`](#13-bs9-flush---empty-and-truncate-logs)
  - [`bs9 issues`](#14-bs9-issues---runtime-error--exception-tracker)
  - [`bs9 monit`](#15-bs9-monit---terminal-dashboard)
  - [`bs9 web`](#16-bs9-web---browser-monitoring-dashboard)
  - [`bs9 advanced`](#17-bs9-advanced---advanced-monitoring-dashboard)
  - [`bs9 env`](#18-bs9-env---dump-configured-environment-variables)
  - [`bs9 profile`](#19-bs9-profile---cpu-and-memory-profiling)
  - [`bs9 deps`](#20-bs9-deps---dependency-visualization--audit)
  - [`bs9 export`](#21-bs9-export---export-historical-metrics)
- [High Availability, State & Self-Healing](#-high-availability-state--self-healing)
  - [`bs9 inspect-ha`](#22-bs9-inspect-ha---static-ha-readiness-inspection)
  - [`bs9 verify-ha`](#23-bs9-verify-ha---isolated-ha-verification--fault-injection)
  - [`bs9 daemon`](#24-bs9-daemon---controller--hub-daemon-management)
- [Production, Configuration & Automation](#-production-configuration--automation)
  - [`bs9 deploy`](#25-bs9-deploy---zero-config-production-deployment)
  - [`bs9 init` / `ecosystem`](#26-bs9-init--ecosystem---generate-configuration-templates)
  - [`bs9 save`](#27-bs9-save---save-service-configuration-backup)
  - [`bs9 resurrect`](#28-bs9-resurrect---restore-services-from-backup)
  - [`bs9 startup` & `unstartup`](#29-bs9-startup--unstartup---os-boot-resurrection)
  - [`bs9 alert`](#30-bs9-alert---alert-thresholds--webhooks)
  - [`bs9 loadbalancer`](#31-bs9-loadbalancer---built-in-reverse-proxy--load-balancer)
  - [`bs9 dbpool`](#32-bs9-dbpool---database-connection-pool-testing)
  - [`bs9 mcp`](#33-bs9-mcp---native-model-context-protocol-server)
  - [`bs9 update`](#34-bs9-update---self-update-bs9)
  - [`bs9 doctor`](#35-bs9-doctor---installation-health-check)
  - [`bs9 inspect`](#36-bs9-inspect---deep-system-audit--security-scan)
  - [`bs9 windows`](#37-bs9-windows---windows-service-management)
  - [`bs9 macos`](#38-bs9-macos---macos-launchd-service-management)
  - [`bs9 consul`](#39-bs9-consul---consul-service-discovery)

---

## 🚀 Core Process Lifecycle

### 1. `bs9 start` - Start Applications

Starts single-process or clustered services with built-in security auditing, monitoring instrumentation, and automatic process supervision.

```bash
# Basic start (defaults to localhost:3000, HTTP)
bs9 start app.ts

# Cluster Mode (Bun reusePort kernel load balancing)
bs9 start app.ts -i 4 --port 3000
bs9 start app.ts -i max --name api-service

# Polyglot Multi-Runtime: Python, Go, Binaries, Shell scripts
bs9 start worker.py                                 # Auto-detected Python runtime
bs9 start main.go                                   # Auto-detected Go runtime
bs9 start service.exe                               # Native executable binary
bs9 start task.sh                                   # Shell script
bs9 start app.rb --interpreter ruby                 # Explicit custom runtime

# PM2 ecosystem configuration parity
bs9 start ecosystem.config.js
bs9 start bs9.config.json

# Multi-service batch starts
bs9 start [app1, app2, app3]
bs9 start [worker-*]
bs9 start all

# Production features: memory limits, file watching, auto-restart
bs9 start app.ts --watch --max-memory-restart 500M --time
bs9 start app.ts --cron "0 4 * * *"                 # Daily restart at 4 AM
```

**Options:**
- `-n, --name <name>`: Custom service name.
- `-p, --port <port>`: Port number (default: `3000`).
- `-h, --host <host>`: Host address (default: `localhost`).
- `--https`: Use HTTPS protocol.
- `-e, --env <env>`: Environment variables (`KEY=val`, repeatable).
- `-i, --instances <n>`: Worker instance count (number or `'max'` for CPU count).
- `-w, --watch`: Watch application directory and restart on file changes.
- `--max-memory-restart <size>`: Auto-restart when memory exceeds limit (e.g., `250M`, `1G`).
- `--restart-delay <ms>`: Delay in ms before auto-restarting.
- `--no-autorestart`: Disable automatic restart on process exit.
- `--time`: Prefix logs with ISO timestamps.
- `--cron <pattern>`: Cron pattern for scheduled forced restarts.
- `--interpreter <bin>`: Custom interpreter binary (e.g., `python3`, `go`, `node`, `none`).
- `--otel`: Enable OpenTelemetry instrumentation (default: `true`).
- `--prometheus`: Enable Prometheus metrics endpoint (default: `true`).
- `--build`: Build TypeScript before starting.

---

### 2. `bs9 stop` - Stop Applications

Stops running services gracefully with bounded drain timeouts or forceful termination.

```bash
# Stop a specific service
bs9 stop my-app

# Stop multiple services
bs9 stop [app1, app2]
bs9 stop [worker-*]
bs9 stop app1 app2 app3

# Stop all managed services
bs9 stop all

# Force immediate termination
bs9 stop my-app --force
```

**Options:**
- `-f, --force`: Force immediate termination without confirmation prompts.

---

### 3. `bs9 restart` - Restart Applications

Restarts running services while preserving configuration and runtime metadata.

```bash
# Restart a specific service
bs9 restart my-app

# Restart multiple services or patterns
bs9 restart [web-1, web-2]
bs9 restart [api-*]
bs9 restart all

# Force restart without confirmation
bs9 restart my-app --force
```

**Options:**
- `-f, --force`: Force restart without confirmation prompt.

---

### 4. `bs9 reload` - Zero-Downtime Rolling Reload

Performs a replace-first, zero-downtime rolling reload across all worker slots in a cluster (PM2 reload parity).

```bash
# Reload a clustered service with zero downtime
bs9 reload my-api

# Reload all clustered services
bs9 reload all

# Force reload
bs9 reload my-api --force
```

**Guarantees:**
- Spawns generation `N+1` worker before touching generation `N`.
- Waits for authenticated `READY` lifecycle signal from `N+1`.
- Initiates two-phase graceful connection drain (`DRAIN_REQUEST` $\to$ `DRAINED`) on `N`.
- Terminates `N` only after `N+1` is actively accepting incoming traffic.
- Preserves kernel socket availability throughout reload.

---

### 5. `bs9 delete` - Delete Services

Removes managed services from supervision and optionally purges configuration files.

```bash
# Delete a specific service
bs9 delete my-app

# Delete and clean up configuration files
bs9 delete my-app --remove

# Batch deletion with patterns
bs9 delete [test-*]
bs9 delete all --force

# Custom graceful shutdown timeout before SIGKILL
bs9 delete my-app --timeout 60
```

**Options:**
- `-a, --all`: Delete all services.
- `-f, --force`: Force deletion without confirmation.
- `-r, --remove`: Remove service configuration files from disk.
- `-t, --timeout <seconds>`: Timeout for graceful shutdown (default: `30`).

---

### 6. `bs9 scale` - Dynamic Cluster Scaling

Scales the number of worker instances in an active cluster up or down without service downtime.

```bash
# Scale to a fixed target worker count
bs9 scale my-api 8

# Scale up by 2 workers
bs9 scale my-api +2

# Scale down by 1 worker
bs9 scale my-api -1
```

---

### 7. `bs9 reset` - Reset Restart Counters & Circuit Breaker

Resets restart attempt counters, exponential backoff delays, and crash loop circuit breaker states.

```bash
# Reset a specific service
bs9 reset my-app

# Reset all services
bs9 reset all
```

---

### 8. `bs9 sendSignal` - Send OS Signals

Sends POSIX signals directly to application processes across platforms.

```bash
# Send SIGUSR2 for user reload
bs9 sendSignal SIGUSR2 my-app

# Graceful interrupt
bs9 sendSignal SIGINT my-app

# Force termination
bs9 sendSignal SIGKILL my-app
```

---

### 9. `bs9 ping` - Daemon Healthcheck

Verifies the responsiveness of the persistent BS9 Controller & Hub daemon.

```bash
bs9 ping
# Outputs:
# 🏓 Pong! BS9 Controller & Hub daemon is alive and operational.
# Platform: Linux (systemd user supervisor)
# Socket: /run/user/1000/bs9/ctrl.sock
```

---

## 📊 Status, Inspection & Observability

### 10. `bs9 status` / `list` / `ls` / `ps` - Process Status Dashboard

Displays real-time status, PIDs, memory, CPU, uptime, and health indicators across services.

```bash
# Display all running services
bs9 status
bs9 ls
bs9 ps

# Filter specific services or patterns
bs9 status [web-*]
bs9 status my-app

# Continuous live refresh mode (refreshes every 2s)
bs9 status --watch

# Machine-readable JSON output (PM2 jlist parity)
bs9 status --json
bs9 status --raw
```

**Visual Indicators:**
- `✅ running`: Active and healthy.
- `🔄 reloading` / `restarting`: In-flight rolling reload or self-healing resurrection.
- `❌ errored`: Stopped due to unhandled crash or exception.
- `⚠️ degraded`: Active with high memory, elevated error rate, or missing workers.
- `⏸️ stopped`: Intentionally stopped by user.

---

### 11. `bs9 show` / `describe` - Detailed Process Inspection

Displays comprehensive runtime metadata, filesystem paths, PIDs, generations, environment variables, and memory statistics.

```bash
bs9 show my-app
bs9 describe my-app
```

---

### 12. `bs9 logs` - View Application Logs

Views real-time aggregated or service-specific stdout and stderr streams.

```bash
# Combined real-time logs across all services
bs9 logs

# Logs for a specific service
bs9 logs my-app

# Stream logs continuously
bs9 logs my-app --follow

# Fetch specific number of lines
bs9 logs my-app --lines 100
```

---

### 13. `bs9 flush` - Empty and Truncate Logs

Empties stdout and stderr log files on disk without stopping the process.

```bash
# Flush logs for a specific service
bs9 flush my-app

# Flush logs for all services
bs9 flush
```

---

### 14. `bs9 issues` - Runtime Error & Exception Tracker

Aggregates runtime exceptions, unhandled rejections, stack traces, and crash histories across services. (PM2 Plus parity — 100% free in BS9).

```bash
# View aggregated issues across all services
bs9 issues

# View issues for a specific service
bs9 issues my-app

# Scan deeper log history
bs9 issues my-app --lines 200

# JSON output for monitoring pipelines
bs9 issues --json

# Clear issue logs and reset error state
bs9 issues --clear
```

**Features:**
- Automatic categorization (TypeError, SyntaxError, Go panic, Python Traceback).
- Pinpoints offending line number and file path.
- Automated diagnostic hints for common failure causes (`ECONNREFUSED`, `EADDRINUSE`, missing dependencies).

---

### 15. `bs9 monit` - Terminal Dashboard

Interactive full-terminal dashboard displaying CPU and memory usage graphs, active PIDs, and live logs.

```bash
# Launch terminal monitor
bs9 monit

# Custom refresh interval
bs9 monit --refresh 5
```

---

### 16. `bs9 web` - Browser Monitoring Dashboard

Launches a dark glassmorphism web dashboard with WebSocket live streaming and Bearer authentication.

```bash
# Start web dashboard on port 8080
bs9 web

# Custom port and detached background mode
bs9 web --port 9000 --detach
```

---

### 17. `bs9 advanced` - Advanced Monitoring Dashboard

Launches the advanced Prometheus and SRE diagnostic interface.

```bash
bs9 advanced --port 8090
```

---

### 18. `bs9 env` - Dump Configured Environment Variables

Displays the environment variables injected into the running service.

```bash
bs9 env my-app
```

---

### 19. `bs9 profile` - CPU and Memory Profiling

Profiles runtime performance and generates sampling summaries or flamegraphs.

```bash
# 60-second sampling profile
bs9 profile --service my-app --duration 60

# Generate flamegraph artifact
bs9 profile --service my-app --flamegraph --output flame.svg

# Inspect top N CPU-heavy functions
bs9 profile --service my-app --top 15
```

---

### 20. `bs9 deps` - Dependency Visualization & Audit

Visualizes service dependencies and audits packages for security vulnerabilities.

```bash
# Visualize dependency tree
bs9 deps my-app

# Export dependency graph as Graphviz DOT or JSON
bs9 deps my-app --format dot --output deps.dot
bs9 deps my-app --format json
```

---

### 21. `bs9 export` - Export Historical Metrics

Exports persisted metrics (CPU, memory, latency, requests) to JSON or CSV.

```bash
# Export last 24 hours of metrics to JSON
bs9 export --format json --hours 24 --output metrics.json

# Export specific service metrics to CSV
bs9 export --service my-app --format csv --output app-metrics.csv
```

---

## 🛡️ High Availability, State & Self-Healing

### 22. `bs9 inspect-ha` - Static HA Readiness Inspection

Performs advisory AST static analysis on entry files and imports to detect unsafe in-memory state.

```bash
# Inspect application entry file
bs9 inspect-ha src/app.ts

# Machine-readable JSON output for CI pipelines
bs9 inspect-ha src/app.ts --json
```

**Tiers Evaluated:**
- **Tier 1 (Stateless HA Ready)**: Pure stateless HTTP handler; safe for automatic `SO_REUSEPORT` clustering.
- **Tier 2 (Managed HA Ready)**: Uses `bs9/runtime` (`State`, `Lease`, `Queue`) for coordinated state.
- **Tier 3 (In-Memory State Warning)**: Detected module-level mutable variables (`let`, `Map`, `Set`) that risk data loss on worker restart.

---

### 23. `bs9 verify-ha` - Isolated HA Verification & Fault Injection

Exercises rolling reloads and violent worker crash recovery under concurrent HTTP load.

```bash
# Ephemeral test on high port (default, isolated)
bs9 verify-ha src/app.ts

# High concurrency and worker count
bs9 verify-ha src/app.ts --instances 4 --concurrency 20 --json

# Test against an active running production cluster (Caution)
bs9 verify-ha my-production-service --live
```

**Options:**
- `--live`: Target an existing live cluster instead of spawning an ephemeral sandbox.
- `-p, --port <port>`: Port for verification traffic.
- `-c, --concurrency <number>`: Concurrent HTTP request worker threads (default: `5`).
- `-i, --instances <number>`: Cluster worker count (default: `2`).
- `--ready-timeout <ms>`: Worker readiness timeout in ms (default: `15000`).
- `--drain-timeout <ms>`: Worker connection drain timeout in ms (default: `5000`).
- `--json`: Output full availability and latency percentiles (p50, p95, p99) as JSON.

---

### 24. `bs9 daemon` - Controller & Hub Daemon Management

Manages the background supervisor that owns topology reconciliation, cluster locks, and the durable same-host State Hub.

```bash
# Check daemon status and PID
bs9 daemon status

# Start daemon in background
bs9 daemon start

# Stop daemon
bs9 daemon stop

# Run in foreground (for systemd or Docker container supervision)
bs9 daemon start --foreground
```

---

## ⚙️ Production, Configuration & Automation

### 25. `bs9 deploy` - Zero-Config Production Deployment

Single-command production deployment with OS security sandboxing, systemd lingering, metrics, and health validation.

```bash
# Deploy with production configuration
bs9 deploy app.ts --name prod-api --port 8080 --env NODE_ENV=production

# Hot reload existing deployment with new settings
bs9 deploy app.ts --reload --env NEW_KEY=new_val
```

---

### 26. `bs9 init` / `ecosystem` - Generate Configuration Templates

Generates template configuration files compatible with BS9 and PM2.

```bash
# Generate JavaScript template (ecosystem.config.js)
bs9 init

# Generate TypeScript template (ecosystem.config.ts)
bs9 init --ts

# Generate JSON template (bs9.config.json)
bs9 init --json
```

---

### 27. `bs9 save` - Save Service Configuration Backup

Saves running service configurations and topologies to persistent JSON backups.

```bash
# Save specific service
bs9 save my-app

# Save all services
bs9 save --all

# Create timestamped versioned backup
bs9 save --all --backup
```

---

### 28. `bs9 resurrect` - Restore Services from Backup

Restores saved services and starts them after system maintenance or migration.

```bash
# Restore a specific service
bs9 resurrect my-app

# Restore all saved services
bs9 resurrect --all

# Restore from a specific backup file
bs9 resurrect --all --config backup-2026-09-17.json
```

---

### 29. `bs9 startup` & `unstartup` - OS Boot Resurrection

Configures system boot hooks (systemd user linger, macOS LaunchDaemons, Windows Task Scheduler/Services) to resurrect BS9 services on system boot.

```bash
# Enable auto-resurrect on OS reboot
bs9 startup

# Disable auto-resurrect on boot
bs9 unstartup
```

---

### 30. `bs9 alert` - Alert Thresholds & Webhooks

Configures alerting rules for CPU, memory, uptime, and error rate thresholds with Slack or custom webhooks.

```bash
# View active alert configuration
bs9 alert --list

# Configure thresholds and Slack webhook
bs9 alert --enable --cpu 85 --memory 90 --webhook https://hooks.slack.com/services/...

# Test webhook delivery
bs9 alert --test
```

---

### 31. `bs9 loadbalancer` - Built-in Reverse Proxy & Load Balancer

Configures a built-in reverse proxy with round-robin, least-connections, or IP-hash algorithms and health checks.

```bash
# Start load balancer on port 8080 forwarding to multiple backends
bs9 loadbalancer start --port 8080 --algorithm round-robin --backends 127.0.0.1:3001,127.0.0.1:3002
```

---

### 32. `bs9 dbpool` - Database Connection Pool Testing

Tests and benchmarks database connection pools under concurrent query stress.

```bash
bs9 dbpool test --host localhost --port 5432 --database prod --username app --max-connections 20
```

---

### 33. `bs9 mcp` - Native Model Context Protocol Server

Starts the Model Context Protocol (MCP) server over stdio for AI assistants (Claude Desktop, Cursor, Antigravity).

```bash
# Start MCP server
bs9 mcp

# Output configuration JSON for Claude Desktop / Cursor
bs9 mcp --install
```

---

### 34. `bs9 update` - Self-Update BS9

Checks for new releases and updates BS9 to the latest or specific version.

```bash
# Check for updates
bs9 update --check

# Upgrade to latest
bs9 update

# Rollback to previous version
bs9 update --rollback
```

---

### 35. `bs9 doctor` - Installation Health Check

Performs diagnostics on permissions, sockets, systemd/launchd supervisors, and Bun runtime environments.

```bash
# Run comprehensive health check
bs9 doctor

# Verbose system diagnostic report
bs9 doctor --verbose
```

---

### 36. `bs9 inspect` - Deep System Audit & Security Scan

Audits application security, static source risks (`eval`, `child_process.exec`), resource limits, and compliance.

```bash
# Complete system and security audit
bs9 inspect --full

# Deep analysis with JSON report
bs9 inspect --deep --report json
```

---

### 37. `bs9 windows` - Windows Service Management

Direct Windows service manager actions (`create`, `start`, `stop`, `restart`, `delete`, `status`).

```bash
bs9 windows create --name MyService --file C:\apps\app.ts
bs9 windows status --name MyService
```

---

### 38. `bs9 macos` - macOS launchd Service Management

Direct macOS launchd daemon actions (`create`, `start`, `stop`, `restart`, `delete`, `status`).

```bash
bs9 macos create --name com.myorg.app --file /Users/admin/apps/app.ts
bs9 macos status --name com.myorg.app
```

---

### 39. `bs9 consul` - Consul Service Discovery

Registers or deregisters BS9 services with HashiCorp Consul.

```bash
bs9 consul register --name api-service --address 127.0.0.1 --port 3000 --health-check http://localhost:3000/healthz
```

---

## 📝 Exit Codes

- `0`: Success
- `1`: General error
- `2`: Invalid usage / CLI arguments
- `3`: Service not found
- `4`: Permission denied
- `5`: Configuration error
- `6`: Network / Socket connection error
- `7`: Dependency error
- `8`: System / Supervisor error

---

## 🔗 Related Documentation

- [Quick Start Guide](../README.md#-quick-start)
- [High-Availability Runtime Guide](HA_RUNTIME.md)
- [REST & SDK API Reference](API.md)
- [Architecture Guide](../ARCHITECTURE.md)
- [Production Guide](../PRODUCTION.md)
- [Security Policy](../SECURITY.md)

---

*Last Updated: September 17, 2026*  
*BS9 Version: 1.6.3*
