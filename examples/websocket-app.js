#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 3002;
const WS_PORT = process.env.WS_PORT || 3003;

// HTTP Server for serving HTML
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>BS9 WebSocket Example</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .messages { border: 1px solid #ccc; height: 300px; overflow-y: auto; padding: 10px; margin: 10px 0; }
        .message { margin: 5px 0; padding: 5px; border-radius: 3px; }
        .user { background: #e3f2fd; }
        .system { background: #f3e5f5; }
        .error { background: #ffebee; }
        input { width: 70%; padding: 5px; }
        button { padding: 5px 15px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>BS9 WebSocket Example</h1>
        <div class="messages" id="messages"></div>
        <input type="text" id="messageInput" placeholder="Type a message..." />
        <button onclick="sendMessage()">Send</button>
        <button onclick="disconnect()">Disconnect</button>
      </div>
      
      <script>
        const ws = new WebSocket('ws://localhost:${WS_PORT}');
        const messages = document.getElementById('messages');
        const input = document.getElementById('messageInput');
        
        ws.onopen = function(event) {
          addMessage('Connected to BS9 WebSocket server', 'system');
        };
        
        ws.onmessage = function(event) {
          const data = JSON.parse(event.data);
          addMessage(data.message, data.type);
        };
        
        ws.onclose = function(event) {
          addMessage('Disconnected from server', 'system');
        };
        
        ws.onerror = function(error) {
          addMessage('WebSocket error: ' + error.message, 'error');
        };
        
        function addMessage(text, type = 'user') {
          const div = document.createElement('div');
          div.className = 'message ' + type;
          div.textContent = new Date().toLocaleTimeString() + ' - ' + text;
          messages.appendChild(div);
          messages.scrollTop = messages.scrollHeight;
        }
        
        function sendMessage() {
          const text = input.value.trim();
          if (text) {
            ws.send(JSON.stringify({ message: text }));
            input.value = '';
          }
        }
        
        function disconnect() {
          ws.close();
        }
        
        input.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
            sendMessage();
          }
        });
      </script>
    </body>
    </html>
  `);
});

// WebSocket Server
const wss = new WebSocketServer({ port: WS_PORT });

const clients = new Set();
const messageHistory = [];

wss.on('connection', (ws, req) => {
  console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);
  
  clients.add(ws);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'system',
    message: 'Welcome to BS9 WebSocket server!',
    timestamp: new Date().toISOString(),
    clients: clients.size
  }));
  
  // Send message history
  messageHistory.slice(-10).forEach(msg => {
    ws.send(JSON.stringify(msg));
  });
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const messageData = {
        type: 'user',
        message: message.message,
        timestamp: new Date().toISOString(),
        sender: req.socket.remoteAddress,
        clients: clients.size
      };
      
      // Store message
      messageHistory.push(messageData);
      
      // Keep only last 100 messages
      if (messageHistory.length > 100) {
        messageHistory.shift();
      }
      
      // Broadcast to all clients
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(messageData));
        }
      });
      
      console.log(`Message: ${message.message} from ${req.socket.remoteAddress}`);
      
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        timestamp: new Date().toISOString()
      }));
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    console.log(`WebSocket disconnected from ${req.socket.remoteAddress}`);
    clients.delete(ws);
    
    // Broadcast client count update
    const updateMessage = {
      type: 'system',
      message: 'Client disconnected',
      timestamp: new Date().toISOString(),
      clients: clients.size
    };
    
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(updateMessage));
      }
    });
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Periodic status updates
setInterval(() => {
  const statusMessage = {
    type: 'system',
    message: `Server status: ${clients.size} connected clients`,
    timestamp: new Date().toISOString(),
    clients: clients.size,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(statusMessage));
    }
  });
}, 30000); // Every 30 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Notify all clients
  const shutdownMessage = {
    type: 'system',
    message: 'Server shutting down...',
    timestamp: new Date().toISOString()
  };
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(shutdownMessage));
      client.close();
    }
  });
  
  wss.close();
  httpServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.emit('SIGTERM');
});

// Start servers
httpServer.listen(PORT, () => {
  console.log(`HTTP server started on port ${PORT}`);
  console.log(`WebSocket server started on port ${WS_PORT}`);
  console.log(`Process ID: ${process.pid}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

console.log('BS9 WebSocket Example Server Started');
console.log(`Open http://localhost:${PORT} in your browser`);
console.log(`WebSocket endpoint: ws://localhost:${WS_PORT}`);
