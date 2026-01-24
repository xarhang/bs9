# Changelog

All notable changes to BS9 (Bun Sentinel 9) will be documented in this file.

## [1.0.0] - 2026-01-25

### Implemented Features

#### Core BS9 CLI
- **Real-time Monitoring Dashboard**: `bs9 monit` command with live terminal UI
- **Web-based Dashboard**: `bs9 web` command with browser interface
- **Enhanced Security**: Systemd hardening with `PrivateTmp=true`, `ProtectSystem=strict`
- **Advanced Monitoring**: Health endpoint checking, alert notifications
- **Color-coded Status**: Visual indicators for service states
- **Configurable Refresh**: Adjustable dashboard refresh intervals
- **TypeScript JIT/AOT Support**: 
  - Default JIT mode for fast development
  - AOT compilation with `--build` flag for production performance
- **Security Audit**: Pre-start scanning for dangerous patterns (eval, child_process.exec, etc.)
- **CLI Commands**:
  - `bs9 start` - Start services with hardened systemd units
  - `bs9 stop` - Stop managed services
  - `bs9 restart` - Restart managed services
  - `bs9 status` - Show SRE metrics dashboard
  - `bs9 logs` - View service logs via journalctl
  - `bs9 monit` - Real-time monitoring dashboard
  - `bs9 web` - Web-based monitoring dashboard
  - `bs9 alert` - Configure alert thresholds and webhooks
  - `bs9 export` - Export historical metrics data

#### Alert System
- **Configurable Thresholds**: CPU, Memory, Error Rate, Uptime
- **Webhook Notifications**: HTTP webhook support for alerts
- **Service-specific Configs**: Per-service alert settings
- **Cooldown Period**: Prevent alert spam
- **Alert Testing**: Test webhook connectivity

#### Historical Metrics Storage
- **Metrics Storage**: Local JSON storage with automatic cleanup
- **Data Export**: JSON and CSV export formats
- **Historical Analysis**: Time-based data retrieval
- **Aggregated Metrics**: CPU, Memory, Uptime averages

#### Container Support
- **Docker Integration**: Complete Dockerfile and docker-compose setup
- **Kubernetes Support**: Full K8s deployment manifests
- **Health Checks**: Container health endpoints
- **Resource Limits**: Memory and CPU constraints

#### Auto-injection
- **OpenTelemetry tracing**
- **Prometheus metrics**
- **Health endpoints** (`/healthz`, `/readyz`, `/metrics`)

#### Port Handling
- **Privileged Port Warnings**: Alert for ports < 1024
- **Port Forwarding Guidance**: Production recommendations

#### Persistence
- **PM2-like behavior**: `loginctl enable-linger` integration
- **Auto-restart**: Automatic recovery from crashes
- **User Services**: Run without root privileges

### Security
- User-mode isolation (no root required)
- Pre-start security audit blocking dangerous patterns
- Enhanced systemd sandboxing
- Resource limits and sandboxing
- Port warnings for privileged ports

### Observability
- OpenTelemetry auto-injection
- Prometheus metrics auto-injection
- Real-time monitoring dashboard
- Historical metrics storage
- Alert system with webhooks
- Structured JSON logging

### Performance
- TypeScript JIT for development speed
- AOT compilation for production optimization
- Minimal resource footprint
- Fast startup times
- Real-time monitoring with low overhead

### Documentation
- Complete README with examples
- Migration guide from PM2
- Troubleshooting section
- File structure documentation
- Contributing guidelines
- Installation guide
- Architecture documentation

### Breaking Changes
- Moved from system systemd to user systemd
- Changed service storage from `/etc/systemd/system/` to `~/.config/systemd/user/`
- Removed root requirements for all operations

---

## [Unreleased]

### Planned
- [ ] Service dependency visualization
- [ ] Performance profiling integration
- [ ] Windows Service support
- [ ] Advanced monitoring dashboards
- [ ] Load balancing support
- [ ] Database connection pooling
