# BS9 API Documentation

## Overview

BS9 provides a comprehensive REST API for managing services, monitoring metrics, and automating operations. The API is designed to be RESTful, secure, and easy to integrate with existing systems.

## 🔗 Base URL

```
http://localhost:3000/api/v1
```

## 🔐 Authentication

### Session Token Authentication

```bash
# Get session token
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "password"}'

# Use token in requests
curl -X GET http://localhost:3000/api/v1/services \
  -H "Authorization: Bearer <session-token>"
```

### API Key Authentication

```bash
# Use API key
curl -X GET http://localhost:3000/api/v1/services \
  -H "X-API-Key: <api-key>"
```

## 📊 Endpoints

### Authentication

#### POST `/api/v1/auth/login`
Authenticate and get session token.

**Request:**
```json
{
  "username": "admin",
  "password": "password"
}
```

**Response:**
```json
{
  "success": true,
  "token": "REDACTED",
  "expiresIn": 3600,
  "user": {
    "id": "admin",
    "role": "administrator"
  }
}
```

#### POST `/api/v1/auth/logout`
Invalidate session token.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

### Services

#### GET `/api/v1/services`
List all services.

**Response:**
```json
{
  "services": [
    {
      "name": "my-app",
      "status": "running",
      "pid": 12345,
      "uptime": 3600,
      "memory": 52428800,
      "cpu": 0.05,
      "port": 3000,
      "restarts": 0,
      "lastRestart": "2024-01-01T12:00:00Z",
      "health": "healthy"
    }
  ],
  "total": 1,
  "running": 1,
  "failed": 0
}
```

#### GET `/api/v1/services/{name}`
Get specific service details.

**Response:**
```json
{
  "name": "my-app",
  "status": "running",
  "pid": 12345,
  "uptime": 3600,
  "memory": 52428800,
  "cpu": 0.05,
  "port": 3000,
  "restarts": 0,
  "lastRestart": "2024-01-01T12:00:00Z",
  "health": "healthy",
  "config": {
    "file": "/path/to/app.js",
    "instances": 1,
    "env": {
      "NODE_ENV": "production"
    },
    "restart": "always"
  },
  "metrics": {
    "requests": 1000,
    "errors": 5,
    "responseTime": 150
  }
}
```

#### POST `/api/v1/services/{name}/start`
Start a service.

**Request:**
```json
{
  "file": "/path/to/app.js",
  "instances": 2,
  "env": {
    "NODE_ENV": "production",
    "PORT": "3000"
  },
  "restart": "always"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Service started successfully",
  "service": {
    "name": "my-app",
    "status": "starting",
    "pid": null
  }
}
```

#### POST `/api/v1/services/{name}/stop`
Stop a service.

**Request:**
```json
{
  "force": false,
  "timeout": 30
}
```

**Response:**
```json
{
  "success": true,
  "message": "Service stopped successfully"
}
```

#### POST `/api/v1/services/{name}/restart`
Restart a service.

**Request:**
```json
{
  "zeroDowntime": false,
  "force": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "Service restarted successfully"
}
```

#### DELETE `/api/v1/services/{name}`
Delete a service.

**Response:**
```json
{
  "success": true,
  "message": "Service deleted successfully"
}
```

### Metrics

#### GET `/api/v1/metrics`
Get system metrics.

**Query Parameters:**
- `service`: Filter by service name
- `from`: Start time (ISO 8601)
- `to`: End time (ISO 8601)
- `interval`: Data interval (1m, 5m, 1h, 1d)

**Response:**
```json
{
  "metrics": {
    "cpu": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 0.05
      }
    ],
    "memory": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 52428800
      }
    ],
    "requests": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 100
      }
    ],
    "errors": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 5
      }
    ]
  },
  "summary": {
    "avgCpu": 0.05,
    "avgMemory": 52428800,
    "totalRequests": 1000,
    "totalErrors": 5
  }
}
```

#### GET `/api/v1/metrics/{service}`
Get metrics for specific service.

**Response:**
```json
{
  "service": "my-app",
  "metrics": {
    "cpu": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 0.05
      }
    ],
    "memory": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 52428800
      }
    ],
    "responseTime": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 150
      }
    ],
    "throughput": [
      {
        "timestamp": "2024-01-01T12:00:00Z",
        "value": 100
      }
    ]
  }
}
```

### Logs

#### GET `/api/v1/logs`
Get service logs.

**Query Parameters:**
- `service`: Filter by service name
- `level`: Filter by log level (debug, info, warn, error)
- `from`: Start time (ISO 8601)
- `to`: End time (ISO 8601)
- `limit`: Number of log entries
- `search`: Search term

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2024-01-01T12:00:00Z",
      "level": "info",
      "service": "my-app",
      "message": "Server started on port 3000",
      "pid": 12345,
      "metadata": {
        "port": 3000,
        "host": "localhost"
      }
    }
  ],
  "total": 100,
  "hasMore": true
}
```

#### GET `/api/v1/logs/{service}`
Get logs for specific service.

**Response:**
```json
{
  "service": "my-app",
  "logs": [
    {
      "timestamp": "2024-01-01T12:00:00Z",
      "level": "info",
      "message": "Server started on port 3000",
      "pid": 12345
    }
  ]
}
```

### Alerts

#### GET `/api/v1/alerts`
Get alerts.

**Query Parameters:**
- `active`: Filter by active status (true/false)
- `severity`: Filter by severity (low, medium, high, critical)
- `from`: Start time (ISO 8601)
- `to`: End time (ISO 8601)

**Response:**
```json
{
  "alerts": [
    {
      "id": "alert-123",
      "name": "High CPU Usage",
      "severity": "high",
      "service": "my-app",
      "condition": "cpu > 80",
      "status": "active",
      "createdAt": "2024-01-01T12:00:00Z",
      "updatedAt": "2024-01-01T12:05:00Z",
      "message": "CPU usage is above 80%",
      "actions": ["notify"]
    }
  ],
  "total": 1,
  "active": 1
}
```

#### POST `/api/v1/alerts`
Create alert rule.

**Request:**
```json
{
  "name": "High CPU Usage",
  "condition": "cpu > 80",
  "severity": "high",
  "service": "my-app",
  "actions": ["notify"],
  "enabled": true,
  "description": "Alert when CPU usage exceeds 80%"
}
```

**Response:**
```json
{
  "success": true,
  "alert": {
    "id": "alert-123",
    "name": "High CPU Usage",
    "condition": "cpu > 80",
    "severity": "high",
    "service": "my-app",
    "actions": ["notify"],
    "enabled": true,
    "createdAt": "2024-01-01T12:00:00Z"
  }
}
```

#### PUT `/api/v1/alerts/{id}`
Update alert rule.

**Request:**
```json
{
  "enabled": false,
  "condition": "cpu > 90"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Alert updated successfully"
}
```

#### DELETE `/api/v1/alerts/{id}`
Delete alert rule.

**Response:**
```json
{
  "success": true,
  "message": "Alert deleted successfully"
}
```

### Configuration

#### GET `/api/v1/config`
Get BS9 configuration.

**Response:**
```json
{
  "version": "1.3.5",
  "environment": "production",
  "logLevel": "info",
  "metrics": {
    "enabled": true,
    "interval": 30
  },
  "alerts": {
    "enabled": true,
    "channels": ["slack", "email"]
  },
  "security": {
    "authentication": true,
    "authorization": true
  }
}
```

#### PUT `/api/v1/config`
Update BS9 configuration.

**Request:**
```json
{
  "logLevel": "debug",
  "metrics": {
    "interval": 15
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration updated successfully"
}
```

### Health

#### GET `/api/v1/health`
Get system health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00Z",
  "version": "1.3.5",
  "uptime": 86400,
  "checks": {
    "database": "healthy",
    "filesystem": "healthy",
    "network": "healthy",
    "memory": "healthy"
  },
  "metrics": {
    "cpu": 0.05,
    "memory": 52428800,
    "disk": 1073741824
  }
}
```

#### GET `/api/v1/health/{service}`
Get service health status.

**Response:**
```json
{
  "service": "my-app",
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00Z",
  "uptime": 3600,
  "checks": {
    "process": "healthy",
    "port": "healthy",
    "memory": "healthy"
  },
  "metrics": {
    "cpu": 0.05,
    "memory": 52428800,
    "responseTime": 150
  }
}
```

## 📝 Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "message": "Operation completed successfully"
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_NOT_FOUND",
    "message": "Service not found",
    "details": "Service 'my-app' does not exist"
  }
}
```

## 🚨 Error Codes

| Code | Description |
|------|-------------|
| `UNAUTHORIZED` | Authentication required |
| `FORBIDDEN` | Insufficient permissions |
| `SERVICE_NOT_FOUND` | Service does not exist |
| `INVALID_REQUEST` | Invalid request parameters |
| `INTERNAL_ERROR` | Internal server error |
| `SERVICE_UNAVAILABLE` | Service temporarily unavailable |

## 🔒 Rate Limiting

API requests are rate-limited to prevent abuse:

- **100 requests per minute** per IP address
- **1000 requests per hour** per authenticated user

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
```

## 📚 SDK Examples

### JavaScript/Node.js

```javascript
const BS9API = require('bs9-api');

const client = new BS9API({
  baseURL: 'http://localhost:3000/api/v1',
  token: 'your-session-token'
});

// Get all services
const services = await client.services.list();

// Start a service
await client.services.start('my-app', {
  file: '/path/to/app.js',
  instances: 2
});

// Get metrics
const metrics = await client.metrics.get({
  service: 'my-app',
  from: '2024-01-01T00:00:00Z',
  to: '2024-01-01T23:59:59Z'
});
```

### Python

```python
import requests

class BS9Client:
    def __init__(self, base_url, token=None):
        self.base_url = base_url
        self.token = token
        self.headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}' if token else None
        }
    
    def get_services(self):
        response = requests.get(
            f'{self.base_url}/services',
            headers=self.headers
        )
        return response.json()
    
    def start_service(self, name, config):
        response = requests.post(
            f'{self.base_url}/services/{name}/start',
            json=config,
            headers=self.headers
        )
        return response.json()

# Usage
client = BS9Client('http://localhost:3000/api/v1', 'your-token')
services = client.get_services()
```

### cURL

```bash
# Get services
curl -X GET http://localhost:3000/api/v1/services \
  -H "Authorization: Bearer <token>"

# Start service
curl -X POST http://localhost:3000/api/v1/services/my-app/start \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"file": "/path/to/app.js", "instances": 2}'

# Get metrics
curl -X GET "http://localhost:3000/api/v1/metrics?service=my-app&from=2024-01-01T00:00:00Z" \
  -H "Authorization: Bearer <token>"
```

## 🔄 Webhooks

BS9 can send webhook notifications for various events:

### Configure Webhook

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-webhook-endpoint.com/bs9",
    "events": ["service.started", "service.stopped", "alert.triggered"],
    "secret": "your-webhook-secret"
  }'
```

### Webhook Payload

```json
{
  "event": "service.started",
  "timestamp": "2024-01-01T12:00:00Z",
  "service": {
    "name": "my-app",
    "status": "running",
    "pid": 12345
  },
  "signature": "sha256=..."
}
```

## 🧪 Testing

### Test Environment

BS9 provides a test environment for API testing:

```bash
# Start test server
bs9 web --test-mode --port 3001

# Use test API
curl -X GET http://localhost:3001/api/v1/test/services \
  -H "X-API-Key: test-key"
```

### Postman Collection

Import the BS9 API Postman collection from:
```
https://github.com/xarhang/bs9/blob/main/docs/postman-collection.json
```

## 🔗 Related Documentation

- [CLI Commands](COMMANDS.md)
- [Configuration Guide](../README.md#-configuration)
- [Security Best Practices](../SECURITY.md)
- [Troubleshooting](../SUPPORT.md)

---

*Last Updated: January 25, 2026*
*BS9 Version: 1.3.5*
