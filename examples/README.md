# BS9 Example Applications

This directory contains example applications that demonstrate how to use BS9 for managing Bun applications in production.

## 📁 Example Applications

### 1. Simple App (`simple-app.js`)
A basic Bun web server that demonstrates BS9's core functionality.

**Features:**
- HTTP server with Bun
- Health check endpoints (`/healthz`, `/readyz`)
- Metrics endpoint (`/metrics`)
- Simple routing

**Usage:**
```bash
# Start with BS9
bs9 start examples/simple-app.js --name simple-app

# Check status
bs9 status simple-app

# View logs
bs9 logs simple-app

# Stop
bs9 stop simple-app
```

### 2. Express App (`express-app.js`)
A complete Express.js application with REST API endpoints.

**Features:**
- Express.js framework
- REST API with CRUD operations
- Health checks and metrics
- Error handling middleware
- Graceful shutdown

**Usage:**
```bash
# Start with BS9
bs9 start examples/express-app.js --name express-app --port 3001

# Test endpoints
curl http://localhost:3001/health
curl http://localhost:3001/api/users
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com"}'
```

### 3. WebSocket App (`websocket-app.js`)
A real-time WebSocket application with chat functionality.

**Features:**
- WebSocket server
- Real-time messaging
- Client connection management
- Message history
- HTML client interface

**Usage:**
```bash
# Start with BS9
bs9 start examples/websocket-app.js --name websocket-app

# Open in browser
open http://localhost:3002

# WebSocket endpoint
wscat -c ws://localhost:3003
```

### 4. Database App (`database-app.js`)
A RESTful API with database operations (simulated).

**Features:**
- REST API with CRUD operations
- User management
- Blog posts and comments
- Database simulation
- CORS support

**Usage:**
```bash
# Start with BS9
bs9 start examples/database-app.js --name database-app --port 3004

# Test endpoints
curl http://localhost:3004/api/users
curl http://localhost:3004/api/posts
curl -X POST http://localhost:3004/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@example.com","bio":"Developer"}'
```

### 5. Microservices App (`microservices-app.js`)
A microservices architecture example with API Gateway.

**Features:**
- Multiple services (API, Auth, Notification, Gateway)
- Service registry
- Health checks
- Request routing
- Service discovery

**Services:**
- **Gateway Service** (port 3000): Routes requests to appropriate services
- **API Service** (port 3010): Handles business logic
- **Auth Service** (port 3011): Manages authentication
- **Notification Service** (port 3012): Sends notifications

**Usage:**
```bash
# Start all services with BS9
bs9 start examples/microservices-app.js --name microservices-app

# Or start individual services
bs9 start examples/microservices-app.js --name gateway-service --port 3000
bs9 start examples/microservices-app.js --name api-service --port 3010
bs9 start examples/microservices-app.js --name auth-service --port 3011
bs9 start examples/microservices-app.js --name notification-service --port 3012

# Access services
curl http://localhost:3000/services
curl http://localhost:3000/api/users
curl http://localhost:3000/auth/login
curl http://localhost:3000/notifications
```

## 🚀 Getting Started

### Prerequisites
- Bun runtime installed
- BS9 installed (`bun install -g bs9`)

### Installation
```bash
# Clone the repository
git clone https://github.com/xarhang/bs9.git
cd bs9/examples

# Install dependencies (if needed)
bun install

# Start BS9 services
bs9 start simple-app.js --name simple-app
```

### Common Operations

#### Start Services
```bash
# Start single service
bs9 start examples/simple-app.js --name simple-app

# Start with environment variables
bs9 start examples/express-app.js --name express-app --env NODE_ENV=production

# Start with multiple instances
bs9 start examples/database-app.js --name database-app --instances 3

# Start with custom port
bs9 start examples/websocket-app.js --name websocket-app --port 8080
```

#### Monitor Services
```bash
# Check status
bs9 status

# Monitor with dashboard
bs9 monit

# View logs
bs9 logs

# View logs for specific service
bs9 logs express-app
```

#### Manage Services
```bash
# Restart service
bs9 restart express-app

# Stop service
bs9 stop express-app

# Stop all services
bs9 stop --all

# Update service configuration
bs9 stop express-app
bs9 start examples/express-app.js --name express-app --env NODE_ENV=production
```

## 🔧 Configuration Examples

### Environment Variables
```bash
# Set environment variables
bs9 start examples/express-app.js --name express-app \
  --env NODE_ENV=production \
  --env PORT=3001 \
  --env DB_HOST=localhost \
  --env DB_PORT=5432
```

### Resource Limits
```bash
# Set memory and CPU limits
bs9 start examples/database-app.js --name database-app \
  --memory 512M \
  --cpu 0.5
```

### Restart Policies
```bash
# Always restart on failure
bs9 start examples/simple-app.js --name simple-app --restart always

# Restart only on failure
bs9 start examples/express-app.js --name express-app --restart on-failure

# Never restart
bs9 start examples/websocket-app.js --name websocket-app --restart never
```

## 📊 Monitoring and Metrics

### Health Checks
All examples include health check endpoints:

```bash
# Check health
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3004/health
```

### Metrics
Most examples expose metrics endpoints:

```bash
# Get metrics
curl http://localhost:3000/metrics
curl http://localhost:3001/health
curl http://localhost:3004/metrics
```

### BS9 Monitoring
```bash
# Real-time monitoring
bs9 monit

# Web dashboard
bs9 web --port 8080

# Service status
bs9 status --detailed

# Resource usage
bs9 status --resources
```

## 🛠️ Development Workflow

### Local Development
```bash
# Start service in development mode
bs9 start examples/express-app.js --name express-app \
  --env NODE_ENV=development \
  --log-level debug

# Watch for changes
bs9 restart express-app --force
```

### Testing
```bash
# Run tests
bun test

# Load testing
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com"}'

# Performance testing
ab -n 1000 -c 10 http://localhost:3001/api/users
```

### Production Deployment
```bash
# Start with production settings
bs9 start examples/express-app.js --name express-app \
  --env NODE_ENV=production \
  --instances 3 \
  --restart always \
  --memory 512M \
  --cpu 0.5

# Monitor production
bs9 monit --service express-app
bs9 logs express-app --level error
```

## 🔒 Security Considerations

### Security Audit
All examples run with BS9's built-in security audit by default:

```bash
# Security audit is enabled by default
bs9 start examples/express-app.js --name express-app

# Skip security audit (not recommended)
bs9 start examples/express-app.js --name express-app --no-security-audit
```

### Network Security
```bash
# Bind to localhost only
bs9 start examples/express-app.js --name express-app --port 3001

# Use HTTPS
bs9 web --https --cert /path/to/cert.pem --key /path/to/key.pem
```

## 📚 Best Practices

### Service Naming
```bash
# Use descriptive names
bs9 start examples/express-app.js --name user-api-service
bs9 start examples/database-app.js --name user-database
```

### Environment Configuration
```bash
# Use environment-specific configurations
bs9 start examples/express-app.js --name express-app \
  --env NODE_ENV=production \
  --env CONFIG_PATH=/path/to/config.json
```

### Logging
```bash
# Configure logging
bs9 start examples/express-app.js --name express-app \
  --log-level info \
  --log-file /var/log/bs9/express-app.log
```

### Resource Management
```bash
# Set appropriate resource limits
bs9 start examples/database-app.js --name database-app \
  --memory 1G \
  --cpu 0.8 \
  --instances 2
```

## 🚨 Troubleshooting

### Common Issues

#### Service Won't Start
```bash
# Check logs
bs9 logs express-app

# Check configuration
bs9 status express-app --detailed

# Run health check
bs9 doctor
```

#### Port Conflicts
```bash
# Use different ports
bs9 start examples/express-app.js --name express-app --port 3002

# Check what's using the port
lsof -i :3001
```

#### Memory Issues
```bash
# Check memory usage
bs9 status --resources

# Set memory limits
bs9 start examples/database-app.js --name database-app --memory 256M
```

### Getting Help
```bash
# Get help for commands
bs9 --help
bs9 start --help

# Check BS9 version
bs9 --version

# Run health check
bs9 doctor
```

## 📖 Additional Resources

- [BS9 CLI Commands](../docs/COMMANDS.md)
- [API Documentation](../docs/API.md)
- [Security Best Practices](../SECURITY.md)
- [Troubleshooting Guide](../SUPPORT.md)

---

*Last Updated: January 25, 2026*
*BS9 Version: 1.3.5*
