# BS9 Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.5] - 2026-01-25

### ✨ New Features
- Fixed
- status
- command
- to
- show
- all
- services
- including
- stopped
- ones

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

## [1.5.4] - 2026-01-25

### ✨ New Features
- Fixed
- setup.sh
- URL
- references
- in
- documentation

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

## [1.5.3] - 2026-01-25

### ✨ New Features
- Testing
- version
- management
- without
- npm
- publish

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

## [1.5.2] - 2026-01-25

### ✨ New Features
- Test
- automated
- version
- management
- system

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

## [1.5.1] - 2026-01-25

### ✨ New Features
- Added automated version management system

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

## [1.5.0] - 2026-01-25

### 🚀 Major Features
- **Multi-Service Management**: Added comprehensive multi-service operations support
- **Array Syntax**: Support for `[app1, app2, app3]` syntax for batch operations
- **Pattern Matching**: Support for `[app-*]` and `[*-prod]` wildcard patterns
- **Batch Operations**: Start, stop, restart, delete, and status for multiple services
- **Safety Confirmations**: Interactive confirmations for destructive bulk operations
- **Batch Results**: Detailed success/failure reporting with percentages

### ✨ New Commands
- `bs9 start [app1, app2, app3]` - Start multiple services
- `bs9 start [app-*]` - Start services matching pattern
- `bs9 start all` - Start all services
- `bs9 stop [app1, app2]` - Stop multiple services
- `bs9 stop [web-*]` - Stop services matching pattern
- `bs9 stop all` - Stop all services (with confirmation)
- `bs9 restart [app1, app2, app3]` - Restart multiple services
- `bs9 restart [*-prod]` - Restart services matching pattern
- `bs9 restart all` - Restart all services (with confirmation)
- `bs9 delete [test-*]` - Delete services matching pattern
- `bs9 delete all` - Delete all services (with confirmation)
- `bs9 status [app1, app2, app3]` - Status of multiple services
- `bs9 status [web-*]` - Status of services matching pattern
- `bs9 status all` - Status of all services

### 🔧 Technical Improvements
- **Array Parser Utility**: New utility for parsing service arrays and patterns
- **Service Discovery**: Enhanced service file discovery for multi-service operations
- **Error Handling**: Improved error handling for batch operations
- **Progress Reporting**: Real-time batch operation progress and results
- **CLI Arguments**: Updated CLI to support variable-length arguments

### 📊 Enhanced Features
- **Batch Results Display**: Comprehensive success/failure summaries
- **Pattern Expansion**: Intelligent pattern matching and service discovery
- **Confirmation Prompts**: Interactive safety confirmations for bulk operations
- **Multi-Service Status**: Enhanced status display for multiple services

### 🛡️ Security
- **Input Validation**: Enhanced validation for multi-service inputs
- **Safe Operations**: Confirmation prompts for destructive operations
- **Pattern Security**: Secure pattern matching to prevent injection

### 📚 Documentation
- **Multi-Service Examples**: Added comprehensive examples in README
- **Pattern Documentation**: Detailed pattern matching documentation
- **Safety Guidelines**: Updated safety and usage guidelines

## [1.4.6] - 2026-01-25

### Fixed
- **Version Management System**
  - Implemented automatic version synchronization between package.json and bin/bs9
  - Added build:version script for automated version updates
  - Created scripts/update-version.js for version management
  - Resolved version mismatch issues in NPM packages

### Changed
- **Build Process**
  - Enhanced build workflow with version synchronization
  - Improved package.json scripts for better development experience
  - Streamlined version update process

### Fixed
- **Installation Issues**
  - Resolved setup.sh version mismatch problems
  - Fixed Bun cache issues with version updates
  - Improved error handling in installation scripts
  - Enhanced fallback mechanisms for failed installations

## [1.4.5] - 2026-01-25

### Fixed
- **Peer Dependency Warnings**
  - Downgraded @opentelemetry/api from ^1.9.0 to ^1.8.0
  - Resolved Bun v1.3.6 compatibility issues
  - Clean installation without dependency warnings

### Changed
- **Dependencies**
  - Updated OpenTelemetry API version for Bun compatibility
  - Maintained full functionality while fixing warnings

## [1.4.4] - 2026-01-25

### Fixed
- **Setup Script Improvements**
  - Fixed repository URL from your-org/bsn to xarhang/bs9
  - Updated all references from BSN to BS9
  - Enhanced installation with npm/bun preference
  - Added installation verification and error handling

### Added
- **Configuration Updates**
  - Enhanced configuration with v1.3.0 features
  - Added host and protocol settings
  - Service discovery configuration
  - Update management settings
  - Advanced monitoring options

### Changed
- **Installation Process**
  - Preferred npm global installation
  - Fallback to bun installation
  - Source installation as last resort
  - Better PATH management

## [1.4.3] - 2026-01-25

### Added
- **Advanced Monitoring Dashboards**
  - Custom widgets and multi-tenant support
  - Historical trending and anomaly detection
  - Alert correlation and root cause analysis
  - Performance baselines and automated learning

## [1.0.0] - 2026-01-25

### ✅ Implemented Features

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
  - `bs9 deps` - Visualize service dependencies
  - `bs9 profile` - Performance profiling for services
  - `bs9 loadbalancer` - Load balancer management
  - `bs9 dbpool` - Database connection pool management

#### Service Dependency Visualization
- **Dependency Analysis**: Automatic detection of service dependencies
- **Graph Generation**: DOT and JSON format support
- **Visual Display**: Terminal-based dependency graphs
- **Health Integration**: Service health status in dependency view
- **Port Detection**: Automatic port discovery for services

#### Performance Profiling
- **Real-time Metrics**: CPU, Memory, Event Loop monitoring
- **Historical Analysis**: Time-based performance data collection
- **Export Capabilities**: JSON export for analysis
- **Service-specific**: Per-service profiling with detailed insights
- **Performance Recommendations**: Automated optimization suggestions

#### Load Balancer Management
- **Multiple Algorithms**: Round-robin, least-connections, weighted round-robin
- **Health Checking**: Automatic backend health monitoring
- **Real-time Statistics**: Connection tracking and performance metrics
- **API Integration**: RESTful API for monitoring and configuration
- **Dynamic Configuration**: Runtime load balancer adjustments

#### Database Connection Pool
- **Connection Management**: Efficient database connection pooling
- **Performance Optimization**: Connection reuse and lifecycle management
- **Monitoring**: Real-time pool statistics and health metrics
- **Transaction Support**: Database transaction management
- **Testing Tools**: Built-in performance testing and benchmarking

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
- Service dependency visualization
- Performance profiling capabilities

### Performance
- TypeScript JIT for development speed
- AOT compilation for production optimization
- Minimal resource footprint
- Fast startup times
- Real-time monitoring with low overhead
- Load balancer optimization
- Database connection pooling

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

## [1.3.3] - 2026-01-25

### Fixed
- **Version Management System**
  - Implemented automatic version synchronization between package.json and bin/bs9
  - Added build:version script for automated version updates
  - Created scripts/update-version.js for version management
  - Resolved version mismatch issues in NPM packages

### Changed
- **Build Process**
  - Enhanced build workflow with version synchronization
  - Improved package.json scripts for better development experience
  - Streamlined version update process

### Fixed
- **Installation Issues**
  - Resolved setup.sh version mismatch problems
  - Fixed Bun cache issues with version updates
  - Improved error handling in installation scripts
  - Enhanced fallback mechanisms for failed installations

---

## [1.3.2] - 2026-01-25

### Fixed
- **Peer Dependency Warnings**
  - Downgraded @opentelemetry/api from ^1.9.0 to ^1.8.0
  - Resolved Bun v1.3.6 compatibility issues
  - Clean installation without dependency warnings

### Changed
- **Dependencies**
  - Updated OpenTelemetry API version for Bun compatibility
  - Maintained full functionality while fixing warnings

---

## [1.3.1] - 2026-01-25

### Fixed
- **Setup Script Improvements**
  - Fixed repository URL from your-org/bsn to xarhang/bs9
  - Updated all references from BSN to BS9
  - Enhanced installation with npm/bun preference
  - Added installation verification and error handling

### Added
- **Configuration Updates**
  - Enhanced configuration with v1.3.0 features
  - Added host and protocol settings
  - Service discovery configuration
  - Update management settings
  - Advanced monitoring options

### Changed
- **Installation Process**
  - Preferred npm global installation
  - Fallback to bun installation
  - Source installation as last resort
  - Better PATH management

---

## [1.3.0] - 2026-01-25

### Added
- **Advanced Monitoring Dashboards**
  - Custom widgets and multi-tenant support
  - Historical trending and anomaly detection
  - Alert correlation and root cause analysis
  - Performance baselines and automated learning

- **Service Discovery Integration**
  - Consul integration with automatic registration
  - Kubernetes service discovery support
  - DNS-based discovery protocols
  - Service mesh support (Istio, Linkerd)

- **Multi-Region Deployment Support**
  - Cross-region service coordination
  - Geographic load balancing
  - Regional failover and disaster recovery
  - Multi-region configuration management

- **Advanced Security Policies**
  - Role-based access control (RBAC)
  - Zero-trust network policies
  - Advanced threat detection
  - Compliance automation (SOC2, GDPR, HIPAA)

- **External Monitoring Integration**
  - Prometheus federation support
  - Grafana dashboard templates
- **Advanced Features**
  - Load balancer management
  - Database connection pool
  - Dependency visualization
  - Service lifecycle management

### Changed
- Complete rewrite with enterprise-grade security
- Cross-platform compatibility
- Enhanced monitoring capabilities
- Production-ready deployment features

### Fixed
- All security vulnerabilities
- Cross-platform compatibility issues
- Performance bottlenecks
- Documentation gaps

## [1.0.0] - 2026-01-25

### Added
- Initial BS9 release
- Basic process management
- Simple monitoring
- Linux systemd support
