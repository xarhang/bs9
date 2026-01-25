# Production Deployment Guide

## Overview

BS9 is designed for production-ready, mission-critical deployments across all major platforms - Windows, macOS, and Linux - with enterprise-grade security, monitoring, and reliability features.

## System Requirements

### Minimum Requirements
- **OS**: Linux (Ubuntu 20.04+, RHEL 8+, Debian 11+), macOS (10.15+), or Windows (10+)
- **Memory**: 2GB RAM
- **Storage**: 10GB available space
- **Network**: Internet connectivity for monitoring
- **User**: Standard user account (Administrator/root optional for some features)

### Recommended Requirements
- **OS**: Ubuntu 22.04 LTS, macOS 12+, or Windows 11
- **Memory**: 4GB+ RAM
- **Storage**: 50GB+ SSD
- **CPU**: 2+ cores
- **Network**: Dedicated network interface

## Platform-Specific Installation

### Linux Installation

```bash
# Install BS9
curl -fsSL https://bs9.dev/install.sh | sudo bash

# Verify installation
bs9 --version

# Enable user services (required for non-root operation)
loginctl enable-linger $USER
```

### macOS Installation

```bash
# Install BS9
curl -fsSL https://bs9.dev/install.sh | bash

# Verify installation
bs9 --version

# Check platform support
bs9 platform
```

### Windows Installation

```powersShell
# Install BS9 (PowerShell as Administrator)
iwr -useb https://bs9.dev/install.ps1 | iex

# Verify installation
bs9 --version

# Check platform support
bs9 platform
```

## Configuration

### Environment Setup

```bash
# Create BS9 configuration directory
mkdir -p ~/.config/bs9
mkdir -p ~/.local/share/bs9/logs
mkdir -p ~/.local/share/bs9/metrics

# Set environment variables
cat >> ~/.bashrc << 'EOF'
export BS9_CONFIG_DIR="$HOME/.config/bs9"
export BS9_LOG_DIR="$HOME/.local/share/bs9/logs"
export BS9_METRICS_DIR="$HOME/.local/share/bs9/metrics"
EOF

source ~/.bashrc
```

### Production Configuration

Create `~/.config/bs9/config.json`:

```json
{
  "logLevel": "info",
  "metricsRetention": "30d",
  "alertWebhook": "https://your-webhook.example.com/bs9-alerts",
  "defaultPort": 3000,
  "security": {
    "auditEnabled": true,
    "blockDangerousPatterns": true,
    "requireHttps": true
  },
  "monitoring": {
    "otelEnabled": true,
    "prometheusEnabled": true,
    "jaegerEndpoint": "http://localhost:14268/api/traces"
  },
  "resources": {
    "maxMemoryPerService": "1G",
    "maxCpuPerService": "100%",
    "maxFileDescriptors": 65536
  }
}
```

## Service Deployment

### Deploying a Node.js Application

```bash
# Start with production optimizations
bs9 start app.js \
  --name my-api-service \
  --port 3000 \
  --build \
  --env NODE_ENV=production \
  --env LOG_LEVEL=info \
  --otel \
  --prometheus

# Monitor the service
bs9 status
bs9 logs my-api-service
bs9 monit
```

### Deploying a TypeScript Application

```bash
# Build and deploy TypeScript
bs9 start src/index.ts \
  --name my-typescript-service \
  --port 3001 \
  --build \
  --env NODE_ENV=production

# The --build flag creates optimized JavaScript
```

### Environment Variables

```bash
# Production environment variables
bs9 start app.js \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env DATABASE_URL=postgresql://user:pass@localhost:5432/db \
  --env REDIS_URL=redis://localhost:6379 \
  --env JWT_SECRET=$(openssl rand -base64 32) \
  --env API_KEY=$(openssl rand -hex 32)
```

## Security Hardening

### Built-in Security Features

BS9 includes comprehensive security hardening out of the box:

#### Input Validation & Sanitization
- **Path Traversal Protection**: File paths restricted to allowed directories
- **Command Injection Prevention**: All user inputs sanitized before shell execution
- **Host Validation**: Only valid hostnames and IP addresses accepted
- **Port Validation**: Port numbers validated (1-65535 range)
- **Service Name Sanitization**: Limited to alphanumeric, hyphens, underscores

#### Runtime Security
- **Process Isolation**: Each service runs in isolated process space
- **Resource Limits**: CPU, memory, and file descriptor limits enforced
- **Environment Sanitization**: All environment variables validated
- **Security Auditing**: Pre-start security scans for dangerous patterns

#### Platform-Specific Security

**Linux (Systemd)**:
```ini
# Security hardening directives
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/path/to/app
UMask=0022
LimitNOFILE=65536
LimitNPROC=4096
```

**macOS (Launchd)**:
- Native macOS security model
- Process isolation and resource control
- Automatic service recovery with security policies

**Windows (Services)**:
- Windows service security integration
- PowerShell parameter validation
- Service recovery policies

### Security Configuration

#### Environment Variables
```bash
# Production security settings
NODE_ENV=production
BS9_SECURITY_LEVEL=high
BS9_AUDIT_LOGGING=true
WEB_SESSION_TOKEN=<cryptographically-secure-token>
```

#### Security Levels
- **Standard**: Basic security features
- **High**: Enhanced monitoring and validation
- **Maximum**: All security features, strict validation

### Network Security

#### Firewall Configuration
```bash
# Linux (UFW)
sudo ufw allow 3000/tcp
sudo ufw allow 8080/tcp
sudo ufw enable

# macOS (pfctl)
sudo pfctl -f /etc/pf.conf

# Windows (Advanced Firewall)
New-NetFirewallRule -DisplayName "BS9" -Direction Inbound -Port 3000 -Protocol TCP -Action Allow
```

#### SSL/TLS Configuration
```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Use with BS9
bs9 start app.js --https --host 0.0.0.0 --port 8443
```

### Access Control

#### User Permissions
```bash
# Create dedicated BS9 user
sudo useradd -r -s /bin/false bs9
sudo usermod -L bs9  # Lock account

# Set proper ownership
sudo chown -R bs9:bs9 /opt/bs9
sudo chmod 750 /opt/bs9
```

#### Service Isolation
```bash
# Linux: Create service-specific user
sudo useradd -r -s /bin/false myapp-service

# macOS: Use launchd with UserName key
# Windows: Run as specific service account
```

### Monitoring & Logging

#### Security Logging
```bash
# Enable security audit logging
export BS9_AUDIT_LOGGING=true

# View security logs
bs9 logs --security

# Monitor security events
tail -f ~/.local/share/bs9/logs/security.log
```

#### Intrusion Detection
```bash
# Monitor for suspicious activity
bs9 monit --security-alerts

# Set up alert thresholds
bs9 alert --enable --cpu-threshold 80 --memory-threshold 90
```

### Backup Security

#### Secure Backup Strategy
```bash
# Encrypt service configurations
tar -czf - ~/.config/bs9 | gpg --symmetric --cipher-algo AES256 -o bs9-backup.tar.gz.gpg

# Backup with proper permissions
sudo cp -r /etc/systemd/user/bs9-* /secure/backup/
sudo chmod 600 /secure/backup/bs9-*
```

#### Recovery Procedures
```bash
# Restore from encrypted backup
gpg --decrypt bs9-backup.tar.gz.gpg | tar -xzf -

# Verify service integrity
bs9 status --verify
bs9 security-audit
```

### Compliance & Auditing

#### Security Compliance Check
```bash
# Run security compliance check
bs9 security-compliance --standard SOC2

# Generate security report
bs9 security-report --format pdf --output security-report.pdf
```

#### Audit Trail
```bash
# Enable comprehensive audit logging
export BS9_AUDIT_LEVEL=comprehensive

# Review audit trail
bs9 audit-trail --service myapp --last 7d
```

### System Security

```bash
# Create dedicated user for services
sudo useradd -r -s /bin/false bs9-service
sudo usermod -L bs9-service  # Lock password

# Set proper permissions
sudo chown -R bs9-service:bs9-service /opt/bs9-apps
sudo chmod 750 /opt/bs9-apps

# Configure firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow from 10.0.0.0/8 to any port 3000
```

### Application Security

```bash
# Enable security audit
bs9 start app.js --security-audit

# Check security status
bs9 security-check my-service

# Generate security report
bs9 security-report --output security-report.json
```

### SSL/TLS Configuration

```bash
# Generate SSL certificates
sudo certbot --nginx -d your-domain.com

# Configure HTTPS redirect
bs9 start app.js \
  --env HTTPS=true \
  --env SSL_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem \
  --env SSL_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem
```

## Monitoring and Observability

### OpenTelemetry Integration

```bash
# Start with OpenTelemetry
bs9 start app.js \
  --otel \
  --env OTEL_SERVICE_NAME=my-service \
  --env OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \
  --env OTEL_RESOURCE_ATTRIBUTES=service.version=1.0.0
```

### Prometheus Metrics

```bash
# Enable Prometheus metrics
bs9 start app.js --prometheus

# Metrics available at: http://localhost:3000/metrics
curl http://localhost:3000/metrics
```

### Web Dashboard

```bash
# Start web monitoring dashboard
bs9 web --port 8080 --detach

# Access at: http://localhost:8080
```

### Alert Configuration

```bash
# Configure alerts
bs9 alert enable \
  --webhook https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK \
  --cpu-threshold 80 \
  --memory-threshold 85 \
  --error-rate-threshold 5 \
  --uptime-threshold 99.9

# Test alert configuration
bs9 alert test
```

## Load Balancing

### Basic Load Balancer

```bash
# Start load balancer
bs9 loadbalancer start \
  --port 80 \
  --backends localhost:3000,localhost:3001,localhost:3002 \
  --algorithm round-robin \
  --health-check

# Load balancer API
curl http://localhost/api/stats
curl http://localhost/api/backends
```

### Advanced Configuration

```bash
# Weighted load balancing
bs9 loadbalancer start \
  --port 80 \
  --backends localhost:3000:3,localhost:3001:2,localhost:3002:1 \
  --algorithm weighted-round-robin \
  --health-path /healthz \
  --health-interval 5000
```

## Database Connection Pooling

### PostgreSQL Pool

```bash
# Start database pool
bs9 dbpool start \
  --host localhost \
  --port 5432 \
  --database myapp \
  --username appuser \
  --password $(cat ~/.secrets/db_password) \
  --max-connections 20 \
  --min-connections 5

# Test pool performance
bs9 dbpool test --concurrency 50 --iterations 1000

# Monitor pool statistics
bs9 dbpool stats
```

## Performance Optimization

### Build Optimization

```bash
# Production build with optimizations
bs9 start app.ts \
  --build \
  --env NODE_ENV=production \
  --env BUN_FEATURE_FLAG_JIT=0

# The build process:
# - Minifies code
# - Tree-shakes unused imports
# - Optimizes for production runtime
```

### Resource Limits

```bash
# Set resource limits
bs9 start app.js \
  --env MEMORY_LIMIT=512m \
  --env CPU_LIMIT=50 \
  --env MAX_CONNECTIONS=1000

# Monitor resource usage
bs9 profile my-service --duration 60 --interval 1000
```

### Dependency Management

```bash
# Audit dependencies for vulnerabilities
bun audit

# Update to latest secure versions
bun update

# Lock dependencies for production
bun install --production --frozen-lockfile
```

## Backup and Recovery

### Configuration Backup

```bash
# Backup BS9 configuration
tar -czf bs9-config-$(date +%Y%m%d).tar.gz ~/.config/bs9

# Backup service data
tar -czf bs9-data-$(date +%Y%m%d).tar.gz ~/.local/share/bs9
```

### Service Backup

```bash
# Export service configuration
bs9 export --format json --output services-backup.json

# Backup specific service
bs9 export --service my-service --output my-service-backup.json
```

### Recovery Procedures

```bash
# Restore configuration
tar -xzf bs9-config-20240125.tar.gz -C ~/

# Restore services
bs9 import --file services-backup.json

# Restart all services
bs9 restart --all
```

## Scaling

### Horizontal Scaling

```bash
# Deploy multiple instances
for i in {1..3}; do
  bs9 start app.js \
    --name "my-service-$i" \
    --port $((3000 + i)) \
    --env INSTANCE_ID=$i \
    --env NODE_ENV=production &
done

# Set up load balancer
bs9 loadbalancer start \
  --port 80 \
  --backends "localhost:3001,localhost:3002,localhost:3003"
```

### Vertical Scaling

```bash
# Increase resources for high-traffic service
bs9 start app.js \
  --env MEMORY_LIMIT=2G \
  --env CPU_LIMIT=200 \
  --env MAX_FILE_DESCRIPTORS=65536
```

## Troubleshooting

### Common Issues

```bash
# Service won't start
bs9 status --verbose
bs9 logs my-service --since 1h

# High memory usage
bs9 profile my-service --duration 300
bs9 export --service my-service --format csv

# Network issues
bs9 deps --format dot | dot -Tpng -o deps.png
bs9 loadbalancer status
```

### Debug Mode

```bash
# Enable debug logging
bs9 start app.js --env DEBUG=bs9:*

# Debug specific service
bs9 debug my-service
```

### Health Checks

```bash
# Check service health
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
curl http://localhost:3000/metrics

# System health
bs9 health-check
```

## Maintenance

### Regular Tasks

```bash
# Daily: Check service status
bs9 status --format json | jq '.services[] | select(.status != "running")'

# Weekly: Update dependencies
bun audit && bun update

# Monthly: Clean old metrics
find ~/.local/share/bs9/metrics -name "*.json" -mtime +30 -delete

# Quarterly: Security audit
bs9 security-audit --all-services
```

### Log Rotation

```bash
# Configure log rotation
cat > ~/.config/bs9/logrotate.conf << 'EOF'
~/.local/share/bs9/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 $USER $USER
}
EOF

# Install logrotate
sudo cp ~/.config/bs9/logrotate.conf /etc/logrotate.d/bs9-$USER
```

## Compliance and Auditing

### Audit Logging

```bash
# Enable comprehensive audit logging
bs9 start app.js \
  --env AUDIT_ENABLED=true \
  --env AUDIT_LOG_PATH=~/.local/share/bs9/audit.log

# Generate audit report
bs9 audit-report --start-date "2024-01-01" --end-date "2024-01-31"
```

### Compliance Checks

```bash
# SOC 2 compliance check
bs9 compliance-check --standard soc2

# Generate compliance report
bs9 compliance-report --output compliance-report.json
```

## Support

### Getting Help

- **Documentation**: https://bs9.dev/docs
- **Issues**: https://github.com/bs9/bs9/issues
- **Discussions**: https://github.com/bs9/bs9/discussions
- **Security**: security@bs9.dev

### Enterprise Support

For enterprise support, SLAs, and custom deployments:
- **Email**: enterprise@bs9.dev
- **Phone**: +1-555-BS9-HELP
- **Chat**: https://bs9.dev/chat

---

For additional questions or support requests, please refer to the [documentation](https://bs9.dev/docs) or open an issue on GitHub.
