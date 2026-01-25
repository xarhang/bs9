# BS9 Frequently Asked Questions

## 🤔 Common Questions

### Q: "Why does a process manager need PostgreSQL?"

**A: It doesn't!** BS9 is designed to be **lightweight and zero-dependency** for core functionality.

#### ✅ **Core BS9 Features (Zero Database Required)**
- **Process Management**: Start, stop, restart, delete services
- **Status Display**: Visual indicators with detailed metrics
- **Backup & Recovery**: JSON-based configuration backup
- **Monitoring**: Real-time dashboards and metrics
- **Health Checks**: Automatic `/healthz` and `/metrics` endpoints
- **Cross-Platform**: Linux, macOS, Windows support
- **Security**: Input validation and process isolation

#### 📊 **Optional Database Features**
PostgreSQL is **optional** and only needed for:
- **Historical Metrics**: Long-term data storage
- **Advanced Analytics**: Complex queries and reporting
- **Enterprise Audit Trails**: Compliance and auditing
- **Multi-Node Clustering**: Distributed service management

#### 🚀 **For Solo Developers & Minimalists**
```bash
# BS9 works perfectly without any database
npm install -g bs9          # No PostgreSQL required
bs9 deploy app.js          # Zero-config deployment
bs9 status                 # Enhanced status display
bs9 save --all             # JSON-based backup
```

---

### Q: "How does BS9 compare to PM2?"

| Feature | PM2 | BS9 |
|--------|-----|-----|
| **Setup** | `pm2 start app.js` | `bs9 deploy app.js` |
| **Systemd** | Manual setup | ✅ Auto-configured |
| **Health Checks** | Manual setup | ✅ Built-in |
| **Database Required** | ❌ No | ✅ **No** |
| **Zero-Config** | ❌ | ✅ |
| **Status Display** | Basic | ✅ Enhanced with indicators |
| **Backup/Restore** | ❌ | ✅ Built-in |

---

### Q: "What are the system requirements?"

#### **Minimum Requirements**
- **Node.js**: v16+ or Bun v1.0+
- **OS**: Linux, macOS, or Windows
- **Memory**: 50MB for BS9 + application memory
- **Storage**: 10MB for BS9 + application storage

#### **Optional Requirements**
- **PostgreSQL**: Only for advanced features (historical metrics, audit trails)
- **Redis**: Optional for caching (future feature)

---

### Q: "Is BS9 production-ready?"

**Absolutely!** BS9 is designed for production use:

#### ✅ **Production Features**
- **Security Hardening**: Input validation, process isolation
- **Health Checks**: Automatic `/healthz` endpoints
- **Metrics**: Built-in Prometheus and OpenTelemetry
- **Backup System**: Complete configuration backup
- **Cross-Platform**: Works on all major OS
- **Zero-Downtime**: Hot reload capabilities

#### 🏢 **Enterprise Features**
- **Service Discovery**: Consul integration
- **Load Balancing**: Built-in load balancer
- **Monitoring**: Real-time dashboards
- **Alerting**: Webhook notifications
- **Audit Trails**: Optional PostgreSQL integration

---

### Q: "How does the backup system work without a database?"

BS9 uses **JSON-based backup system**:

#### 📁 **Backup Storage**
```bash
# Backups stored in ~/.config/bs9/backups/
~/.config/bs9/backups/
├── myapp_2026-01-25_12-30-45.json
├── all-services_2026-01-25_12-35-22.json
└── myapp_2026-01-25_13-15-10.json
```

#### 📄 **Backup Format**
```json
{
  "name": "myapp",
  "file": "/path/to/app.js",
  "port": 3000,
  "host": "localhost",
  "env": ["NODE_ENV=production"],
  "otel": true,
  "prometheus": true,
  "build": false,
  "https": false,
  "savedAt": "2026-01-25T12:40:57.109Z",
  "platform": "linux"
}
```

#### 🔄 **Restore Process**
```bash
# Save all services
bs9 save --all

# Restore all services
bs9 resurrect --all

# Restore specific service
bs9 resurrect myapp
```

---

### Q: "What about security?"

BS9 is built with **security-first** approach:

#### 🔒 **Security Features**
- **Input Validation**: All inputs validated and sanitized
- **Path Traversal Protection**: Prevents file system attacks
- **Command Injection Prevention**: Blocks malicious commands
- **Process Isolation**: Services run in isolated environments
- **Resource Limits**: CPU and memory limits
- **User Permissions**: Non-root operation

#### 🛡️ **Enterprise Security**
- **Audit Logging**: Complete audit trail (optional PostgreSQL)
- **Role-Based Access**: User permission management
- **Network Security**: Configurable firewall rules
- **Secrets Management**: Environment variable encryption

---

### Q: "How does BS9 handle monitoring?"

#### 📊 **Built-in Monitoring**
- **Real-time Metrics**: CPU, Memory, Uptime, Tasks
- **Health Checks**: `/healthz` and `/metrics` endpoints
- **Status Display**: Visual indicators (✅🔄❌⚠️⏸️)
- **Terminal Dashboard**: Live monitoring interface
- **Web Dashboard**: Browser-based monitoring

#### 📈 **Advanced Monitoring**
- **Prometheus Integration**: Native metrics export
- **OpenTelemetry**: Distributed tracing
- **Alert System**: Webhook notifications
- **Historical Data**: Optional PostgreSQL storage

---

### Q: "Can I use BS9 with Docker?"

Yes! BS9 works great with Docker:

#### 🐳 **Docker Integration**
```dockerfile
FROM node:18-alpine
RUN npm install -g bs9
COPY . /app
WORKDIR /app
CMD ["bs9", "deploy", "app.js"]
```

#### 🚀 **Kubernetes Support**
- **Helm Charts**: Ready-to-use Kubernetes templates
- **Service Discovery**: Consul integration
- **Load Balancing**: Built-in load balancer
- **Health Checks**: Kubernetes-ready health endpoints

---

### Q: "How do I get started?"

#### 🚀 **Quick Start**
```bash
# Install BS9
npm install -g bs9

# Deploy your first application
bs9 deploy app.js

# Check status
bs9 status

# View logs
bs9 logs app.js --follow
```

#### 📚 **Documentation**
- **[README.md](README.md)**: Complete getting started guide
- **[COMMANDS.md](docs/COMMANDS.md)**: All 22 commands documented
- **[SECURITY.md](SECURITY.md)**: Security policies and reporting
- **[PRODUCTION.md](PRODUCTION.md)**: Production deployment guide

---

## 🎯 **Summary**

### ✅ **BS9 is Perfect For:**
- **Solo Developers**: Zero-config, lightweight setup
- **Startups**: Rapid deployment with enterprise features
- **Enterprise**: Production-ready with advanced monitoring
- **Minimalists**: No database required for core functionality

### 🚀 **Key Advantages:**
- **Zero Database Required** for core functionality
- **One-Command Deployment**: `bs9 deploy app.js`
- **Enhanced Status Display**: Visual indicators and metrics
- **Complete Backup System**: JSON-based, no database needed
- **Production Ready**: Security hardening and monitoring

### 📊 **Optional PostgreSQL:**
- **Historical Metrics**: Long-term data storage
- **Advanced Analytics**: Complex queries and reporting
- **Enterprise Audit**: Compliance and auditing
- **Multi-Node Clustering**: Distributed management

**BS9: The lightweight, zero-config process manager that scales from solo projects to enterprise deployments!** 🚀
