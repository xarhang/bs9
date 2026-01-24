#!/bin/bash

set -euo pipefail

# BS9 (Bun Sentinel 9) Installer
# One-click installation for mission-critical process manager

echo "🚀 Installing BS9 (Bun Sentinel 9)..."

# Check if running as root for systemd operations
if [[ $EUID -eq 0 ]]; then
  echo "⚠️  Running as root detected. BS9 is designed for user-mode operation."
  echo "   For user-mode installation (recommended):"
  echo "   - Run as regular user"
  echo "   - Services will run without root privileges"
  echo "   - Use loginctl enable-linger for persistence"
  read -p "Continue with root install? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 1
  fi
  ROOT_INSTALL=1
else
  echo "👤 Running as user. BS9 will use systemd user mode."
  ROOT_INSTALL=0
fi

# Function to detect OS
detect_os() {
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "debian"
    elif command -v yum >/dev/null 2>&1; then
      echo "rhel"
    elif command -v pacman >/dev/null 2>&1; then
      echo "arch"
    else
      echo "linux"
    fi
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
echo "🖥️  Detected OS: $OS"

# Install Bun if not present
if ! command -v bun >/dev/null 2>&1; then
  echo "📦 Installing Bun..."
  case $OS in
    "macos")
      if command -v brew >/dev/null 2>&1; then
        brew tap oven-sh/bun
        brew install bun
      else
        curl -fsSL https://bun.sh/install | bash
      fi
      ;;
    "debian"|"rhel"|"arch"|"linux")
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
      else
        echo "❌ curl is required to install Bun. Please install curl first."
        exit 1
      fi
      ;;
    *)
      echo "❌ Unsupported OS for automatic Bun installation"
      exit 1
      ;;
  esac
  
  # Source bun for current session
  if [[ -f "$HOME/.bashrc" ]]; then
    source "$HOME/.bashrc"
  elif [[ -f "$HOME/.zshrc" ]]; then
    source "$HOME/.zshrc"
  fi
else
  echo "✅ Bun already installed: $(bun --version)"
fi

# Create temporary directory for BSN
TEMP_DIR=$(mktemp -d)
echo "📁 Working in: $TEMP_DIR"

# Clone or download BSN
if command -v git >/dev/null 2>&1; then
  echo "📥 Cloning BSN repository..."
  git clone https://github.com/your-org/bsn.git "$TEMP_DIR"
else
  echo "📥 Downloading BSN..."
  curl -L https://github.com/your-org/bsn/archive/main.tar.gz | tar -xz -C "$TEMP_DIR" --strip-components=1
fi

cd "$TEMP_DIR"

# Install dependencies
echo "📦 Installing BS9 dependencies..."
bun install

# Build BS9
echo "🔨 Building BS9..."
bun run build

# Install BS9 CLI
if [[ $ROOT_INSTALL -eq 1 ]]; then
  echo "🔧 Installing BS9 CLI to /usr/local/bin..."
  cp bin/bs9 /usr/local/bin/bs9
  chmod +x /usr/local/bin/bs9
else
  echo "🔧 Installing BS9 CLI to ~/.local/bin..."
  mkdir -p "$HOME/.local/bin"
  cp bin/bs9 "$HOME/.local/bin/bs9"
  chmod +x "$HOME/.local/bin/bs9"
  
  # Add to PATH if not already there
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$HOME/.bashrc"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$HOME/.zshrc" 2>/dev/null || true
    echo "📝 Added ~/.local/bin to PATH in shell config"
  fi
fi

# Enable user services persistence (PM2-like behavior)
if [[ $ROOT_INSTALL -eq 0 ]]; then
  echo "🔄 Enabling user service persistence (loginctl enable-linger)..."
  if command -v loginctl >/dev/null 2>&1; then
    # Get current username
    CURRENT_USER=${SUDO_USER:-$USER}
    if command -v sudo >/dev/null 2>&1 && [[ $EUID -eq 0 ]]; then
      sudo -u "$CURRENT_USER" loginctl enable-linger "$CURRENT_USER"
    else
      loginctl enable-linger "$CURRENT_USER" 2>/dev/null || {
        echo "⚠️  Could not enable linger. Services will stop when you logout."
        echo "   To enable persistence, run: loginctl enable-linger $USER"
      }
    fi
    echo "✅ User services will persist after logout"
  else
    echo "⚠️  loginctl not found. Services may stop when you logout."
  fi
fi

# Create BS9 config directory
CONFIG_DIR="$HOME/.config/bs9"
mkdir -p "$CONFIG_DIR"

# Create default config
cat > "$CONFIG_DIR/config.toml" <<EOF
[default]
# Default port for health/metrics endpoints
port = 3000

# Enable/disable auto-injection
otel_enabled = true
prometheus_enabled = true

# Default environment
environment = "production"

[security]
# Security audit settings
security_audit = true
block_eval = true
block_child_process_exec = true
block_fs_access = true

[monitoring]
# Dashboard refresh interval (seconds)
refresh_interval = 2
# Health check timeout (milliseconds)
health_check_timeout = 1000

[logging]
# Log level: debug, info, warn, error
level = "info"
# Use structured JSON logging
structured = true
EOF

echo "✅ BS9 configuration created at $CONFIG_DIR/config.toml"

# Cleanup
cd /
rm -rf "$TEMP_DIR"

echo ""
echo "🎉 BS9 installation complete!"
echo ""
echo "📖 Quick start:"
if [[ $ROOT_INSTALL -eq 1 ]]; then
  echo "   bs9 start app.js          # Start your app with BS9"
else
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "   bs9 start app.js          # Start your app with BS9"
fi
echo ""
echo "🔧 BS9 Features:"
echo "   - Services run without root privileges"
echo "   - Persistent after logout (loginctl enable-linger)"
echo "   - Stored in ~/.config/systemd/user/"
echo "   - Real-time monitoring dashboard: bs9 monit"
echo ""
echo "📚 Documentation: https://github.com/your-org/bsn"
echo "🐛 Issues: https://github.com/your-org/bsn/issues"
echo ""
echo "✨ Happy coding with BS9!"
