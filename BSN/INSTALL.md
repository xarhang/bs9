# BS9 Installation Guide

## Quick Install

### One-click Installer (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/main/setup.sh | bash
```

This installer will:
- Install Bun runtime if not present
- Install BS9 CLI to `~/.local/bin/bs9`
- Set up systemd user mode persistence
- Create default configuration

### Manual Install

#### Prerequisites
- Bun runtime 1.3.6 or later
- Linux system with systemd user mode support
- Git

#### Installation Steps

```bash
# Clone the repository
git clone https://github.com/xarhang/bs9.git
cd bs9

# Install dependencies
bun install

# Install BS9 CLI
cp bin/bs9 ~/.local/bin/bs9
chmod +x ~/.local/bin/bs9

# Add to PATH if not already there
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc" 2>/dev/null || true
  echo "📝 Added ~/.local/bin to PATH in shell config"
fi

# Enable user services persistence
loginctl enable-linger $USER

# Verify installation
bs9 --version
```

## System Requirements

### Minimum Requirements
- **OS**: Linux (Ubuntu 18.04+, CentOS 7+, RHEL 8+)
- **Systemd**: User mode support
- **Memory**: 512MB minimum
- **Disk**: 1GB for metrics storage

### Recommended Requirements
- **CPU**: 2+ cores for better performance
- **Memory**: 2GB+ for multiple services
- **Disk**: 5GB+ for extended metrics storage

## Docker Installation

### Using Docker Compose (Recommended)

```bash
# Clone and run with Docker Compose
git clone https://github.com/xarhang/bs9.git
cd bs9
docker-compose up -d

# Access services
# Web Dashboard: http://localhost:8080
# Grafana: http://localhost:3001
# Prometheus: http://localhost:9090
```

### Using Docker Directly

```bash
# Pull the image
docker pull bs9:latest

# Run BS9 container
docker run -d \
  --name bs9-manager \
  -p 8080:8080 \
  -v ~/.config/bs9:/app/.config/bs9 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  bs9:latest
```

## Kubernetes Installation

### Prerequisites
- Kubernetes cluster 1.20+
- kubectl configured
- Helm 3.0+ (optional)

### Installation Steps

```bash
# Apply Kubernetes manifests
kubectl apply -f src/k8s/bs9-deployment.yaml

# Check deployment status
kubectl get pods -n bs9-system
kubectl get services -n bs9-system

# Port-forward to access services
kubectl port-forward service/bs9-manager-service 8080 -n bs9-system
```

## Verification

### Test Installation

```bash
# Check BS9 version
bs9 --version

# List available commands
bs9 --help

# Test with example app
bs9 start examples/simple-app.js --name test-app
bs9 status
bs9 monit

# Clean up test
bs9 stop test-app
```

### Test Web Dashboard

```bash
# Start web dashboard
bs9 web --detach --port 8080

# Verify it's running
curl -s http://localhost:8080/api/metrics

# Stop web dashboard
pkill -f "bs9 web"
```

## Configuration

### Default Configuration

After installation, BS9 creates default configuration in `~/.config/bs9/`:

```bash
# Default config location
ls -la ~/.config/bs9/
# config.toml
# alerts.json
# metrics/ (created when services run)
```

### Environment Variables

BS9 respects the following environment variables:

- `BS9_CONFIG_DIR`: Override default config directory
- `BS9_METRICS_DIR`: Override metrics storage directory
- `WEB_DASHBOARD_PORT`: Override web dashboard port (default: 8080)

## Post-Installation

### First Service

```bash
# Start your first service
bs9 start examples/simple-app.js --name myapp

# Check status
bs9 status

# View logs
bs9 logs myapp --follow

# Access web dashboard
bs9 web --detach
```

### Configure Alerts

```bash
# Set up alert thresholds
bs9 alert --cpu 80 --memory 85 --errorRate 5

# Add webhook for notifications
bs9 alert --webhook https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Test webhook
bs9 alert --test
```

## Troubleshooting

### Common Issues

#### Permission Denied
```bash
# Ensure user systemd is enabled
systemctl --user status

# Enable linger for persistence
loginctl enable-linger $USER
```

#### Service Won't Start
```bash
# Check service status
systemctl --user status service-name

# View logs for errors
bs9 logs service-name

# Check systemd unit syntax
systemctl --user daemon-reload
```

#### Web Dashboard Not Accessible
```bash
# Check if process is running
pgrep -f "bs9 web"

# Check port usage
ss -tulpn | grep :8080

# Restart web dashboard
bs9 web --detach --port 8080
```

### Getting Help

- **Documentation**: [README.md](README.md)
- **Issues**: [GitHub Issues](https://github.com/bs9/bs9/issues)
- **Discussions**: [GitHub Discussions](https://github.com/bs9/bs9/discussions)
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)

## Uninstallation

### Remove BS9 CLI
```bash
# Remove CLI binary
rm -f ~/.local/bin/bs9

# Remove from PATH (edit your shell config)
# Remove the line: export PATH="$HOME/.local/bin:$PATH"
```

### Remove Configuration
```bash
# Remove config directory
rm -rf ~/.config/bs9

# Remove metrics data
rm -rf ~/.config/bs9/metrics

# Disable linger (optional)
loginctl disable-linger $USER
```

### Remove Docker Images
```bash
# Remove BS9 image
docker rmi bs9:latest

# Remove containers
docker-compose down -v
```

### Remove Kubernetes Resources
```bash
# Delete namespace and all resources
kubectl delete namespace bs9-system
```

## Next Steps

After successful installation:

1. **Read the README**: Learn about all features
2. **Try Examples**: Test with provided example applications
3. **Configure Alerts**: Set up monitoring and notifications
4. **Deploy Services**: Start managing your applications with BS9
5. **Explore Monitoring**: Use terminal and web dashboards

For detailed usage instructions, see the main [README.md](README.md).
