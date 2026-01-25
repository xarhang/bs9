# BS9 CLI Commands Documentation

## Overview

BS9 provides 21 powerful CLI commands for managing Bun applications. All commands are designed to be intuitive, secure, and production-ready with automatic platform detection and zero-configuration setup.

## 🚀 Core Commands

### 1. `bs9 start` - Start Applications

Starts a Bun application as a managed service with built-in security and monitoring.

```bash
# Basic usage
bs9 start app.js

# With service name
bs9 start app.js --name my-app

# With environment variables
bs9 start app.js --name my-app --env NODE_ENV=production --env PORT=3000

# With multiple instances
bs9 start app.js --name my-app --instances 4

# With custom working directory
bs9 start app.js --name my-app --cwd /path/to/app

# With restart policy
bs9 start app.js --name my-app --restart always

# With port binding
bs9 start app.js --name my-app --port 3000

# With logging configuration
bs9 start app.js --name my-app --log-level info --log-file my-app.log

# With resource limits
bs9 start app.js --name my-app --memory 512M --cpu 0.5

# With security audit (default)
bs9 start app.js --name my-app --security-audit

# Skip security audit (not recommended)
bs9 start app.js --name my-app --no-security-audit
```

**Options:**
- `--name, -n`: Service name (required)
- `--env, -e`: Environment variables (multiple)
- `--instances, -i`: Number of instances (default: 1)
- `--cwd, -c`: Working directory
- `--restart, -r`: Restart policy (always|on-failure|never)
- `--port, -p`: Port to bind
- `--log-level`: Log level (debug|info|warn|error)
- `--log-file`: Log file path
- `--memory`: Memory limit (e.g., 512M)
- `--cpu`: CPU limit (0.1-1.0)
- `--security-audit`: Enable security audit (default: true)
- `--no-security-audit`: Skip security audit

**Security Features:**
- Path traversal protection
- Command injection prevention
- Host validation
- Port validation
- Service name sanitization
- Resource limit enforcement

### 2. `bs9 stop` - Stop Applications

Stops running services gracefully or forcefully.

```bash
# Stop specific service
bs9 stop my-app

# Stop multiple services
bs9 stop my-app another-app

# Stop all services
bs9 stop --all

# Force stop (immediate termination)
bs9 stop my-app --force

# Stop with timeout (default: 30 seconds)
bs9 stop my-app --timeout 60

# Stop and remove configuration
bs9 stop my-app --remove
```

**Options:**
- `--all`: Stop all services
- `--force, -f`: Force immediate termination
- `--timeout, -t`: Graceful shutdown timeout in seconds
- `--remove, -r`: Remove service configuration

### 3. `bs9 restart` - Restart Applications

Restarts running services with zero downtime where possible.

```bash
# Restart specific service
bs9 restart my-app

# Restart multiple services
bs9 restart my-app another-app

# Restart all services
bs9 restart --all

# Restart with zero downtime
bs9 restart my-app --zero-downtime

# Restart with new configuration
bs9 restart my-app --env NODE_ENV=production

# Force restart
bs9 restart my-app --force
```

**Options:**
- `--all`: Restart all services
- `--zero-downtime, -z`: Zero downtime restart
- `--force, -f`: Force restart
- `--env, -e`: Update environment variables

### 4. `bs9 delete` - Delete Services

Deletes managed services and optionally removes configuration files.

```bash
# Delete specific service
bs9 delete my-app

# Delete service and remove configuration files
bs9 delete my-app --remove

# Delete all services
bs9 delete --all

# Delete all services and remove configuration files
bs9 delete --all --remove

# Force delete (ignore errors)
bs9 delete my-app --force
bs9 delete --all --force

# Delete with custom graceful shutdown timeout
bs9 delete my-app --timeout 60

# Delete service with confirmation prompt
bs9 delete my-app --confirm
```

**Options:**
- `--all`: Delete all services
- `--force, -f`: Force deletion without errors
- `--remove, -r`: Remove service configuration files
- `--timeout, -t`: Graceful shutdown timeout in seconds (default: 30)
- `--confirm, -c`: Show confirmation prompt before deletion

**Security Features:**
- Service name validation and sanitization
- Path traversal protection
- Command injection prevention
- Safe file operations
- Cross-platform compatibility

**Examples:**
```bash
# Clean up a development service
bs9 delete dev-app --remove --force

# Remove all test services
bs9 delete --all --remove --force

# Graceful shutdown with extended timeout
bs9 delete production-app --timeout 120
```

### 6. `bs9 delete` - Delete Services

Deletes managed services and optionally removes configuration files.

```bash
# Delete specific service
bs9 delete my-app

# Delete service and remove configuration files
bs9 delete my-app --remove

# Delete all services
bs9 delete --all

# Delete all services and remove configuration files
bs9 delete --all --remove

# Force delete (ignore errors)
bs9 delete my-app --force
bs9 delete --all --force

# Delete with custom graceful shutdown timeout
bs9 delete my-app --timeout 60

# Delete service with confirmation prompt
bs9 delete my-app --confirm
```

**Options:**
- `--all`: Delete all services
- `--force, -f`: Force deletion without errors
- `--remove, -r`: Remove service configuration files
- `--timeout, -t`: Graceful shutdown timeout in seconds (default: 30)
- `--confirm, -c`: Show confirmation prompt before deletion

**Security Features:**
- Service name validation and sanitization
- Path traversal protection
- Command injection prevention
- Safe file operations
- Cross-platform compatibility

**Examples:**
```bash
# Clean up a development service
bs9 delete dev-app --remove --force

# Remove all test services
bs9 delete --all --remove --force

# Graceful shutdown with extended timeout
bs9 delete production-app --timeout 120
```

### 7. `bs9 save` - Save Service Configurations

Saves service configurations to backup files for later restoration.

```bash
# Save specific service
bs9 save my-app

# Save all services
bs9 save --all

# Save with timestamped backup
bs9 save my-app --backup

# Force save (ignore errors)
bs9 save my-app --force
```

**Options:**
- `--all, -a`: Save all services
- `--force, -f`: Force save without errors
- `--backup, -b`: Create timestamped backup

**Backup Location:**
- Linux: `~/.config/bs9/backups/`
- macOS: `~/Library/Application Support/BS9/backups/`
- Windows: `%APPDATA%/BS9/backups/`

**Backup Format:**
```json
{
  "name": "my-app",
  "file": "/path/to/app.js",
  "port": 3000,
  "host": "localhost",
  "env": ["NODE_ENV=production"],
  "otel": true,
  "prometheus": true,
  "build": false,
  "https": false,
  "savedAt": "2026-01-25T12:00:00.000Z",
  "platform": "linux"
}
```

### 8. `bs9 resurrect` - Restore Services from Backup

Restores services from previously saved backup configurations.

```bash
# Restore specific service
bs9 resurrect my-app

# Restore all services
bs9 resurrect --all

# Force restore (ignore errors)
bs9 resurrect my-app --force

# Restore with custom configuration
bs9 resurrect my-app --config custom-config.json
```

**Options:**
- `--all, -a`: Restore all services
- `--force, -f`: Force restoration without errors
- `--config, -c`: Custom configuration file to use

**Restoration Process:**
1. Load backup configuration
2. Validate service file exists
3. Start service with saved parameters
4. Verify service is running

**Examples:**
```bash
# BS9 CLI Commands Documentation

## Overview

BS9 provides 22 powerful CLI commands for managing Bun applications. All commands are designed to be intuitive, secure, and production-ready with automatic platform detection and zero-configuration setup.

## 🚀 Core Commands

### 1. `bs9 start` - Start Applications

Starts a Bun application as a managed service with built-in security and monitoring.

```bash
# Basic usage
bs9 start app.js

# Deploy with production settings (KILLER FEATURE)
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production
```

### 2. `bs9 deploy` - Zero-Config Deployment (KILLER FEATURE)

Deploy applications with zero-config production setup.

```bash
# Basic deployment
bs9 deploy app.js

# Deploy with custom configuration
bs9 deploy app.ts --name my-api --port 8080 --env NODE_ENV=production

# Hot reload existing service
bs9 deploy app.js --reload --env NEW_CONFIG=value
```

**What `bs9 deploy` does automatically:**
- ✅ Creates systemd service with security hardening
- ✅ Enables user services persistence (linger)
- ✅ Sets up health checks (`/healthz`, `/metrics`)
- ✅ Enables OpenTelemetry and Prometheus metrics
- ✅ Configures smart restart policies
- ✅ Performs health validation

### 3. `bs9 status` - Enhanced Status Display

Shows service status with visual indicators and detailed metrics.

```bash
# Show all services
bs9 status

# Sample Output:
SERVICE            STATUS          CPU        MEMORY       UPTIME       TASKS    DESCRIPTION
────────────────────────────────────────────────────────────────────────────────────────────────────
myapp              ✅ running       52.3ms     8.5MB        2m 15s       1        BS9 Service: myapp

📊 Service Summary:
  📈 Status: 1 running, 0 failed, 0 restarting
  📦 Total: 1/1 services running
  💾 Memory: 8.5MB
```

### 4. `bs9 delete` - Delete Services

Deletes managed services with cleanup options.

```bash
# Delete all services
bs9 delete --all --force
```

### 5. `bs9 save` - Service Configuration Backup

Saves service configurations to backup files.

```bash
# Save all services
bs9 save --all
```

### 6. `bs9 resurrect` - Service Restoration

Restores services from saved backup configurations.

```bash
# Restore all services
bs9 resurrect --all
```

---

## 🎯 Key Features

### 🚀 Zero-Config Deployment (KILLER FEATURE)
- **One-Command Setup**: `bs9 deploy app.ts` does everything automatically
- **Production Ready**: Security hardening, health checks, metrics enabled
- **Hot Reload**: Update configurations without downtime

### 📊 Enhanced Status Display
- **Visual Indicators**: ✅🔄❌⚠️⏸️ for instant health assessment
- **Perfect Alignment**: All columns properly aligned with accurate data
- **Detailed Metrics**: CPU, Memory, Uptime, Tasks, Port information

### 💾 Backup & Recovery System
- **Complete JSON-based backup system**
- **Cross-Platform**: Works on Linux, macOS, Windows
- **Disaster Recovery**: Quick system restoration

---

## 🌟 Why Choose BS9?

### vs PM2
| Feature | PM2 | BS9 |
|--------|-----|-----|
| **Setup** | `pm2 start app.js` | `bs9 deploy app.js` |
| **Systemd** | Manual setup | ✅ Auto-configured |
| **Health Checks** | Manual setup | ✅ Built-in |
| **Zero-Config** | ❌ | ✅ |

---

## 📚 Complete Command List

1. `bs9 start` - Start applications
2. `bs9 deploy` - **KILLER FEATURE** - Zero-config deployment
3. `bs9 status` - Enhanced status display with visual indicators
4. `bs9 stop` - Stop services
5. `bs9 restart` - Restart services
6. `bs9 delete` - Delete services
7. `bs9 logs` - View application logs
8. `bs9 monit` - Terminal dashboard
9. `bs9 web` - Web dashboard
10. `bs9 alert` - Alert management
11. `bs9 export` - Data export
12. `bs9 deps` - Dependency management
13. `bs9 profile` - Performance profiling
14. `bs9 update` - Update BS9
15. `bs9 doctor` - Health check
16. `bs9 windows` - Windows services
17. `bs9 macos` - macOS services
18. `bs9 advanced` - Advanced monitoring
19. `bs9 consul` - Service discovery
20. `bs9 save` - Service backup
21. `bs9 resurrect` - Service restoration
22. `bs9 version` - Version information

---

*Last Updated: January 25, 2026*
*Version: 1.4.2*
*Commands: 22 total*.

```bash
# Show all dependencies
bs9 deps my-app

# Show only production dependencies
bs9 deps my-app --production

# Check for security vulnerabilities
bs9 deps my-app --audit

# Update dependencies
bs9 deps my-app --update

# Show dependency tree
bs9 deps my-app --tree

# Show outdated packages
bs9 deps my-app --outdated

# Generate dependency report
bs9 deps my-app --report

# Lock dependencies
bs9 deps my-app --lock
```

**Options:**
- `--production, -p`: Show only production dependencies
- `--audit, -a`: Check for vulnerabilities
- `--update, -u`: Update dependencies
- `--tree, -t`: Show dependency tree
- `--outdated, -o`: Show outdated packages
- `--report, -r`: Generate dependency report
- `--lock, -l`: Lock dependencies

## 🔍 Advanced Commands

### 16. `bs9 alert` - Alert Management

Manages alerting rules and notifications.

```bash
# Show all alerts
bs9 alert

# Show active alerts
bs9 alert --active

# Show alert history
bs9 alert --history

# Create alert rule
bs9 alert create --name "High CPU" --condition "cpu > 80" --action "notify"

# Delete alert rule
bs9 alert delete --name "High CPU"

# Test alert notification
bs9 alert test --name "High CPU"

# List alert channels
bs9 alert --channels

# Configure Slack webhook
bs9 alert config --slack https://hooks.slack.com/...

# Configure email alerts
bs9 alert config --email admin@example.com
```

**Options:**
- `--active, -a`: Show active alerts
- `--history, -h`: Show alert history
- `--create`: Create new alert rule
- `--delete`: Delete alert rule
- `--test`: Test alert notification
- `--channels`: List alert channels
- `--config`: Configure alert settings

### 17. `bs9 export` - Data Export

Exports metrics, logs, and configuration data.

```bash
# Export all data
bs9 export

# Export metrics only
bs9 export --metrics

# Export logs only
bs9 export --logs

# Export configuration
bs9 export --config

# Export specific time range
bs9 export --from "2024-01-01" --to "2024-01-31"

# Export to specific format
bs9 export --format json

# Export to file
bs9 export --output export.json

# Export specific service
bs9 export --service my-app

# Compress export
bs9 export --compress
```

**Options:**
- `--metrics, -m`: Export metrics data
- `--logs, -l`: Export log data
- `--config, -c`: Export configuration
- `--from`: Start date/time
- `--to`: End date/time
- `--format, -f`: Export format (json|csv|xml)
- `--output, -o`: Output file
- `--service, -s`: Specific service
- `--compress, -z`: Compress output

## 🌐 Platform-Specific Commands

### 18. `bs9 windows` - Windows Service Management

Manages BS9 as Windows services.

```bash
# Create Windows service
bs9 windows create --name MyBS9Service --file C:\app\index.js

# Start Windows service
bs9 windows start --name MyBS9Service

# Stop Windows service
bs9 windows stop --name MyBS9Service

# Restart Windows service
bs9 windows restart --name MyBS9Service

# Delete Windows service
bs9 windows delete --name MyBS9Service

# Show service status
bs9 windows status --name MyBS9Service

# List all services
bs9 windows list

# Enable auto-start
bs9 windows enable --name MyBS9Service

# Disable auto-start
bs9 windows disable --name MyBS9Service
```

**Options:**
- `--name, -n`: Service name
- `--file, -f`: Application file path
- `--display-name`: Service display name
- `--description`: Service description
- `--start-type`: Start type (auto|manual|disabled)
- `--working-dir`: Working directory
- `--env`: Environment variables

### 19. `bs9 macos` - macOS Service Management

Manages BS9 as macOS LaunchDaemons/LaunchAgents.

```bash
# Create macOS service
bs9 macos create --name MyBS9Service --file /Users/user/app/index.js

# Start macOS service
bs9 macos start --name MyBS9Service

# Stop macOS service
bs9 macos stop --name MyBS9Service

# Restart macOS service
bs9 macos restart --name MyBS9Service

# Delete macOS service
bs9 macos delete --name MyBS9Service

# Show service status
bs9 macos status --name MyBS9Service

# List all services
bs9 macos list

# Enable auto-start
bs9 macos enable --name MyBS9Service

# Disable auto-start
bs9 macos disable --name MyBS9Service
```

**Options:**
- `--name, -n`: Service name
- `--file, -f`: Application file path
- `--label`: Service label
- `--user`: Run as specific user
- `--group`: Run as specific group
- `--working-dir`: Working directory
- `--env`: Environment variables

## 🔧 Utility Commands

### 20. `bs9 doctor` - Health Check

Performs comprehensive health checks on BS9 installation.

```bash
# Run full health check
bs9 doctor

# Check specific components
bs9 doctor --check dependencies
bs9 doctor --check configuration
bs9 doctor --check permissions
bs9 doctor --check network

# Fix detected issues
bs9 doctor --fix

# Generate health report
bs9 doctor --report

# Check system compatibility
bs9 doctor --compatibility

# Verbose output
bs9 doctor --verbose
```

**Options:**
- `--check, -c`: Check specific component
- `--fix, -f`: Attempt to fix issues
- `--report, -r`: Generate health report
- `--compatibility`: Check system compatibility
- `--verbose, -v`: Verbose output

**Health Checks:**
- BS9 installation integrity
- Dependency versions
- File permissions
- Network connectivity
- System resources
- Configuration validity

### 21. `bs9 version` - Version Information

Displays BS9 version and system information.

```bash
# Show BS9 version
bs9 version

# Show detailed version info
bs9 version --detailed

# Show system information
bs9 version --system

# Show dependency versions
bs9 version --dependencies

# Show build information
bs9 version --build

# Check for updates
bs9 version --check-updates

# JSON output
bs9 version --json
```

**Options:**
- `--detailed, -d`: Show detailed version information
- `--system, -s`: Show system information
- `--dependencies, -d`: Show dependency versions
- `--build, -b`: Show build information
- `--check-updates, -c`: Check for updates
- `--json, -j`: JSON output format

## 🎯 Global Options

All BS9 commands support these global options:

```bash
# Show help
bs9 --help
bs9 <command> --help

# Show version
bs9 --version
bs9 -V

# Verbose output
bs9 <command> --verbose
bs9 <command> -v

# Quiet mode
bs9 <command> --quiet
bs9 <command> -q

# Configuration file
bs9 <command> --config /path/to/config.json

# Log level
bs9 <command> --log-level debug

# Dry run (show what would be done)
bs9 <command> --dry-run

# Force operation
bs9 <command> --force
bs9 <command> -f
```

## 📝 Exit Codes

- `0`: Success
- `1`: General error
- `2`: Invalid usage
- `3`: Service not found
- `4`: Permission denied
- `5`: Configuration error
- `6`: Network error
- `7`: Dependency error
- `8`: System error

## 🔗 Related Documentation

- [Installation Guide](../README.md#-quick-start)
- [Configuration Guide](../README.md#-configuration)
- [Security Best Practices](../SECURITY.md)
- [Troubleshooting](../SUPPORT.md)
- [API Documentation](API.md)
- [Contributing Guide](../CONTRIBUTING.md)

---

*Last Updated: January 25, 2026*
*BS9 Version: 1.3.5*
