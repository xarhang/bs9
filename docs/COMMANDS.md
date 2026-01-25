# BS9 CLI Commands Documentation

## Overview

BS9 provides 19 powerful CLI commands for managing Bun applications. All commands are designed to be intuitive, secure, and production-ready.

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
# Restore development environment
bs9 resurrect --all

# Restore specific service with custom settings
bs9 resurrect my-app --config production-config.json

# Quick restore after system reboot
bs9 resurrect --all --force
```

### 9. `bs9 status` - Check Service Status

Displays detailed status information about services.

```bash
# Show all services
bs9 status

# Show specific service
bs9 status my-app

# Show detailed information
bs9 status --detailed

# Show JSON output
bs9 status --json

# Show only running services
bs9 status --running

# Show only failed services
bs9 status --failed

# Show resource usage
bs9 status --resources

# Show uptime information
bs9 status --uptime

# Show SRE metrics
bs9 status --sre
```

**Options:**
- `--detailed, -d`: Show detailed information
- `--json, -j`: JSON output format
- `--running, -r`: Show only running services
- `--failed, -f`: Show only failed services
- `--resources`: Show resource usage
- `--uptime, -u`: Show uptime information
- `--sre`: Show SRE metrics

**Output Fields:**
- Service name and status
- Process ID (PID)
- Uptime and restart count
- Memory and CPU usage
- Port binding information
- Last restart reason
- Health check status

## 📊 Monitoring Commands

### 10. `bs9 monit` - Real-time Monitoring Dashboard

Launches a real-time monitoring dashboard in the terminal.

```bash
# Start monitoring dashboard
bs9 monit

# Monitor specific service
bs9 monit --service my-app

# Monitor multiple services
bs9 monit --service my-app --service another-app

# Set refresh interval (default: 2 seconds)
bs9 monit --refresh 1

# Show only metrics
bs9 monit --metrics-only

# Show only logs
bs9 monit --logs-only

# Enable sound alerts
bs9 monit --alert

# Export metrics to file
bs9 monit --export metrics.json

# Custom dashboard layout
bs9 monit --layout compact
```

**Options:**
- `--service, -s`: Specific service to monitor
- `--refresh, -r`: Refresh interval in seconds
- `--metrics-only`: Show only metrics
- `--logs-only`: Show only logs
- `--alert, -a`: Enable sound alerts
- `--export, -e`: Export metrics to file
- `--layout, -l`: Dashboard layout (compact|expanded)

**Dashboard Features:**
- Real-time CPU and memory usage
- Request/response rates
- Error rates and alerts
- Service health status
- Log streaming
- Performance metrics

### 11. `bs9 logs` - View Application Logs

Displays and filters application logs.

```bash
# Show logs for specific service
bs9 logs my-app

# Show logs for all services
bs9 logs --all

# Show last 100 lines
bs9 logs my-app --tail 100

# Follow logs in real-time
bs9 logs my-app --follow

# Filter by log level
bs9 logs my-app --level error

# Show logs from last hour
bs9 logs my-app --since 1h

# Show logs with timestamps
bs9 logs my-app --timestamps

# Search logs for specific text
bs9 logs my-app --search "error"

# Export logs to file
bs9 logs my-app --export logs.txt

# Show system logs
bs9 logs --system
```

**Options:**
- `--all, -a`: Show logs for all services
- `--tail, -t`: Number of lines to show
- `--follow, -f`: Follow logs in real-time
- `--level, -l`: Filter by log level (debug|info|warn|error)
- `--since, -s`: Show logs since time period
- `--timestamps`: Show timestamps
- `--search`: Search for specific text
- `--export, -e`: Export logs to file
- `--system`: Show system logs

### 12. `bs9 web` - Web Dashboard

Launches a web-based monitoring dashboard.

```bash
# Start web dashboard
bs9 web

# Start on specific port
bs9 web --port 8080

# Start in background
bs9 web --detach

# Bind to specific host
bs9 web --host 0.0.0.0

# Enable authentication
bs9 web --auth username:password

# Use custom session token
bs9 web --token your-secret-token

# Enable HTTPS
bs9 web --https --cert /path/to/cert.pem --key /path/to/key.pem

# Custom dashboard title
bs9 web --title "My BS9 Dashboard"

# Enable API endpoints
bs9 web --api
```

**Options:**
- `--port, -p`: Port to bind (default: 3000)
- `--host, -h`: Host to bind (default: localhost)
- `--detach, -d`: Run in background
- `--auth, -a`: Basic authentication (user:pass)
- `--token, -t`: Session token for authentication
- `--https`: Enable HTTPS
- `--cert`: SSL certificate file
- `--key`: SSL private key file
- `--title`: Dashboard title
- `--api`: Enable REST API endpoints

**Web Features:**
- Interactive service management
- Real-time metrics visualization
- Historical data charts
- Log viewer with search
- Configuration management
- Alert management
- API documentation

## 🔧 Management Commands

### 13. `bs9 update` - Update BS9

Updates BS9 to the latest version or specific version.

```bash
# Check for updates
bs9 update --check

# Update to latest version
bs9 update

# Update to specific version
bs9 update --version 1.3.4

# Force update
bs9 update --force

# Update with backup
bs9 update --backup

# Rollback to previous version
bs9 update --rollback

# List available versions
bs9 update --list

# Update from specific registry
bs9 update --registry https://registry.npmjs.org
```

**Options:**
- `--check, -c`: Check for updates only
- `--version, -v`: Update to specific version
- `--force, -f`: Force update
- `--backup, -b`: Create backup before update
- `--rollback, -r`: Rollback to previous version
- `--list, -l`: List available versions
- `--registry`: Custom npm registry

**Update Process:**
1. Check current version
2. Fetch latest version from npm
3. Create backup of current installation
4. Download and install new version
5. Verify installation
6. Update configuration if needed

### 14. `bs9 profile` - Performance Profiling

Profiles application performance and identifies bottlenecks.

```bash
# Profile specific service
bs9 profile my-app

# Profile for 30 seconds
bs9 profile my-app --duration 30

# Profile with CPU sampling
bs9 profile my-app --cpu

# Profile with memory sampling
bs9 profile my-app --memory

# Generate flame graph
bs9 profile my-app --flamegraph

# Export profile data
bs9 profile my-app --export profile.json

# Profile with custom sampling rate
bs9 profile my-app --sampling 1000

# Show top functions
bs9 profile my-app --top 10
```

**Options:**
- `--duration, -d`: Profile duration in seconds
- `--cpu, -c`: Enable CPU profiling
- `--memory, -m`: Enable memory profiling
- `--flamegraph, -f`: Generate flame graph
- `--export, -e`: Export profile data
- `--sampling, -s`: Sampling rate in Hz
- `--top, -t`: Show top N functions

**Profile Data:**
- CPU usage by function
- Memory allocation patterns
- Function call counts
- Execution time analysis
- Performance bottlenecks

### 15. `bs9 deps` - Dependency Management

Manages and analyzes application dependencies.

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
