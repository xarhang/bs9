# Video 2: Installation Guide

## 📹 Video Information

**Title:** Installation Guide  
**Duration:** 8 minutes  
**Format:** MP4 (1080p)  
**Level:** Beginner  
**Release Date:** January 2026-01-25

## 🎯 Video Description

This comprehensive installation guide covers all methods for installing BS9 across different platforms. Viewers will learn about one-click installation, manual installation steps, and troubleshooting common installation issues. Perfect for getting BS9 up and running on any system.

## 🎯 Installation Methods Covered

### 🚀 One-Click Installation (Recommended)
- Using the setup.sh script
- Automatic dependency installation
- Cross-platform compatibility
- Verification steps

### 🔧 Manual Installation
- Clone from GitHub repository
- Install Bun runtime
- Build from source
- Configuration setup

### 📦 Package Manager Installation
- NPM global installation
- Bun global installation
- Version management
- Update procedures

### 🐳 Container Installation
- Docker image usage
- Docker Compose setup
- Kubernetes deployment
- Container orchestration

## 📋 Script and Resources

### 📝 Installation Script
```bash
# One-click installation
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash

# Verify installation
bs9 --version
bs9 doctor

# Check system compatibility
bs9 check
```

### 🔧 Manual Installation
```bash
# Clone repository
git clone https://github.com/xarhang/bs9.git
cd bs9

# Install Bun runtime
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Build from source
bun run build

# Install globally
bun install -g .
```

### 📦 Package Manager Installation
```bash
# NPM global installation
npm install -g bs9

# Bun global installation
bun install -g bs9

# Update to latest version
npm update -g bs9
```

### 🐳 Docker Installation
```bash
# Pull BS9 image
docker pull xarhang/bs9:latest

# Run with Docker Compose
docker-compose up -d

# Run with Docker
docker run -d --name bs9 xarhang/bs9:latest
```

## 🎯 Platform-Specific Instructions

### 🐧 Linux Installation
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y curl
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash

# CentOS/RHEL
sudo yum install -y curl
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash
```

### 🍎 macOS Installation
```bash
# Using Homebrew
brew install bs9

# Using setup script
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash

# Manual installation
git clone https://github.com/xarhang/bs9.git
cd bs9
curl -fsSL https://bun.sh/install | bash
bun install
bun run build
bun install -g .
```

### 🪟 Windows Installation
```bash
# Using PowerShell
iwr -Uri https://raw.githubusercontent.com/xarhang/bs9/setup.sh -OutFile setup.sh
.\setup.sh

# Using Git Bash (WSL)
git clone https://github.com/xarhang/bs9.git
cd bs9
curl -fsSL https://bun.sh/install | bash
bun install
bun run build
bun install -g .
```

## 🔧 Troubleshooting

### 🚫 Common Issues and Solutions

#### Installation Fails
```bash
# Check system requirements
bs9 doctor

# Check Bun installation
bun --version

# Clean cache and retry
bun install --force
```

#### Permission Issues
```bash
# Fix permissions
chmod +x setup.sh
./setup.sh

# Use sudo if needed
sudo ./setup.sh
```

#### Network Issues
```bash
# Test connectivity
curl -I https://registry.npmjs.org/v1/bs9

# Use alternative registry
curl -I https://registry.npmjs.org/v1/bs9
```

#### Dependency Issues
```bash
# Clear cache
bun install --force

# Clean install
rm -rf node_modules
bun install
```

## 📋 Verification Steps

### ✅ Installation Verification
```bash
# Check BS9 version
bs9 --version

# Check system health
bs9 doctor

# Test basic functionality
bs9 status
```

### 🔧 Functionality Testing
```bash
# Start test service
bs9 start examples/simple-app.js --name test-app

# Check service status
bs9 status test-app

# View logs
bs9 logs test-app

# Stop service
bs9 stop test-app
```

## 📚 Additional Resources

### 📚 Documentation Links
- [Installation Guide](../README.md#-quick-start)
- [Troubleshooting Guide](../SUPPORT.md)
- [Platform-Specific Guides](../README.md#platform-support)
- [Configuration Options](../README.md#-configuration)

### 🔗 Community Support
- [Discord Community](https://discord.gg/bs9)
- [GitHub Issues](https://github.com/xarhang/bs9/issues)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/bs9)
- [Reddit Community](https://reddit.com/r/bs9)

### 🎯 Learning Path
After successful installation, continue with:
- Video 3: First Application
- Video 4: Service Management
- Video 5: Monitoring and Metrics
- Video 6: Advanced Configuration

---

*Video production in progress. Coming soon!*
