#!/bin/bash

set -euo pipefail

# BS9 (Bun Sentinel 9) Installer
# One-click installation for mission-critical process manager

echo "🚀 Installing BS9 (Bun Sentinel 9)..."

# 1. PATH Injection for current process
export PATH="$HOME/.bun/bin:$PATH"

# Check if running as root for systemd operations
if [[ $EUID -eq 0 ]]; then
  echo "⚠️  Running as root detected. BS9 is designed for user-mode operation."
  echo "    For user-mode installation (recommended):"
  echo "    - Run as regular user"
  echo "    - Services will run without root privileges"
  echo "    - Use loginctl enable-linger for persistence"
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
  
  # Update current script's path after installation
  export PATH="$HOME/.bun/bin:$PATH"

  # Source bun for current session
  if [[ -f "$HOME/.bashrc" ]]; then
    source "$HOME/.bashrc"
  elif [[ -f "$HOME/.zshrc" ]]; then
    source "$HOME/.zshrc"
  fi
else
  echo "✅ Bun already installed: $(bun --version)"
fi

# Clone or download BS9 (only if bs9 not already installed)
if ! command -v bs9 >/dev/null 2>&1; then
  # Create temporary directory for BS9
  TEMP_DIR=$(mktemp -d)
  echo "📁 Working in: $TEMP_DIR"

  # Clone or download BS9
  if command -v git >/dev/null 2>&1; then
    echo "📥 Cloning BS9 repository..."
    git clone https://github.com/xarhang/bs9.git "$TEMP_DIR"
  else
    echo "📥 Downloading BS9..."
    curl -L https://github.com/xarhang/bs9/archive/main.tar.gz | tar -xz -C "$TEMP_DIR" --strip-components=1
  fi

  cd "$TEMP_DIR"

  # Install dependencies and build (only if installing from source)
  if command -v bun >/dev/null 2>&1; then
    echo "📦 Installing BS9 dependencies..."
    bun install
    
    echo "🔨 Building BS9..."
    bun run build
  fi
else
  echo "✅ BS9 already installed, skipping download..."
  TEMP_DIR=""
fi

# Install BS9 CLI
echo "🔧 Installing BS9 CLI globally..."
if command -v bun >/dev/null 2>&1; then
  echo "📦 Installing via bun (recommended)..."
  bun install -g bs9
elif command -v npm >/dev/null 2>&1; then
  echo "📦 Installing via npm..."
  npm install -g bs9@latest
else
  echo "❌ Neither bun nor npm found. Please install one first."
  echo "    Install Bun: curl -fsSL https://bun.sh/install | bash"
  echo "    Install NPM: sudo apt install npm"
  exit 1
fi

# 2. UPDATED: Verify installation with fallback instructions
if command -v bs9 >/dev/null 2>&1; then
  echo "✅ BS9 installed successfully: $(bs9 --version 2>/dev/null || echo 'v1.3.1')"
else
  # Detect Shell for the fix message
  SHELL_NAME=$(basename "$SHELL")
  PROFILE_FILE="~/.profile"
  [[ "$SHELL_NAME" == "zsh" ]] && PROFILE_FILE="~/.zshrc"
  [[ "$SHELL_NAME" == "bash" ]] && PROFILE_FILE="~/.bashrc"

  echo "--------------------------------------------------------"
  echo "⚠️  BS9 is installed but NOT yet in your PATH."
  echo "To fix this, run the command below:"
  echo ""
  echo "echo 'export PATH=\"\$HOME/.bun/bin:\$PATH\"' >> $PROFILE_FILE && source $PROFILE_FILE"
  echo "--------------------------------------------------------"
  
  # Allow the script to continue by manually setting path one last time
  export PATH="$HOME/.bun/bin:$PATH"
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
        echo "    To enable persistence, run: loginctl enable-linger $USER"
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
port = 3000
host = "localhost"
protocol = "http"
otel_enabled = true
prometheus_enabled = true
environment = "production"

[security]
security_audit = true
block_eval = true
block_child_process_exec = true
block_fs_access = true
session_token_required = true

[monitoring]
refresh_interval = 2
health_check_timeout = 1000
advanced_dashboard = true
anomaly_detection = true

[discovery]
consul_enabled = false
consul_url = "http://localhost:8500"
auto_register = true

[updates]
auto_check = true
auto_update = false
channel = "stable"

[logging]
level = "info"
structured = true
max_files = 10
max_size = "10MB"
EOF

echo "✅ BS9 configuration created at $CONFIG_DIR/config.toml"

# Cleanup
if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
  cd /
  rm -rf "$TEMP_DIR"
  echo "🧹 Cleaned up temporary files"
fi

echo ""
echo "🎉 BS9 installation complete!"
echo ""
echo "📖 Quick start:"
echo "    bs9 start app.js          # Start your app"
echo "    bs9 status                # Check status"
echo "    bs9 monit                 # Real-time monitoring"
echo ""
echo "✨ Happy coding with BS9!"
