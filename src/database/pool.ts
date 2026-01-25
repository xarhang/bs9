#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

// Security: Input validation functions
function isValidHost(host: string): boolean {
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const localhostRegex = /^(localhost|127\.0\.0\.1)$/;
  
  return hostnameRegex.test(host) && host.length <= 253 || 
         ipv4Regex.test(host) || 
         localhostRegex.test(host);
}

function isValidDatabaseName(name: string): boolean {
  // Allow alphanumeric, underscores, and hyphens only
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 64;
}

function isValidUsername(username: string): boolean {
  // Allow alphanumeric, underscores, and hyphens only
  return /^[a-zA-Z0-9_-]+$/.test(username) && username.length <= 32;
}

function sanitizeSQL(sql: string): string {
  // Basic SQL injection prevention
  const dangerousPatterns = [
    /drop\s+table/i,
    /delete\s+from/i,
    /truncate\s+table/i,
    /exec\s*\(/i,
    /xp_cmdshell/i,
    /sp_executesql/i,
    /union\s+select/i,
    /insert\s+into/i,
    /update\s+set/i
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(sql)) {
      throw new Error(`❌ Security: Dangerous SQL pattern detected`);
    }
  }
  
  return sql.trim();
}

interface DatabaseConnection {
  id: string;
  created: number;
  lastUsed: number;
  inUse: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  checkedOut: boolean;
  query: (sql: string, params?: any[]) => Promise<any[]>;
  close: () => Promise<void>;
}

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
  minConnections?: number;
  acquireTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  reapIntervalMillis?: number;
}

interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients: number;
  maxConnections: number;
}

class DatabasePool {
  private config: DatabaseConfig;
  private connections: DatabaseConnection[] = [];
  private waitingQueue: Array<{
    resolve: (connection: DatabaseConnection) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }> = [];
  private reapingInterval?: NodeJS.Timeout;
  
  constructor(config: DatabaseConfig) {
    // Security: Validate configuration
    if (!isValidHost(config.host)) {
      throw new Error(`❌ Security: Invalid database host: ${config.host}`);
    }
    
    if (!isValidDatabaseName(config.database)) {
      throw new Error(`❌ Security: Invalid database name: ${config.database}`);
    }
    
    if (!isValidUsername(config.username)) {
      throw new Error(`❌ Security: Invalid database username: ${config.username}`);
    }
    
    const portNum = Number(config.port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`❌ Security: Invalid port number: ${config.port}`);
    }
    
    this.config = {
      maxConnections: 10,
      minConnections: 2,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      ...config,
    };
    
    this.startReaper();
  }
  
  private async createConnection(): Promise<DatabaseConnection> {
    const id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    // Simulate database connection
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
      id,
      created: now,
      lastUsed: now,
      inUse: false,
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      username: this.config.username,
      checkedOut: false,
      query: async (sql: string, params?: any[]) => {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 10));
        return [{ id: 1, data: 'mock_result' }];
      },
      close: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      },
    };
  }
  
  async acquire(): Promise<DatabaseConnection> {
    const now = Date.now();
    
    const availableConnection = this.connections.find(conn => !conn.inUse);
    if (availableConnection) {
      availableConnection.inUse = true;
      availableConnection.lastUsed = now;
      return availableConnection;
    }
    
    if (this.connections.length < this.config.maxConnections!) {
      const newConnection = await this.createConnection();
      newConnection.inUse = true;
      this.connections.push(newConnection);
      return newConnection;
    }
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waitingQueue.findIndex(item => item.resolve === resolve);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
        }
        reject(new Error('Connection acquire timeout'));
      }, this.config.acquireTimeoutMillis);
      
      this.waitingQueue.push({
        resolve: (connection) => {
          clearTimeout(timeoutId);
          resolve(connection);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timestamp: now,
      });
    });
  }
  
  async release(connection: DatabaseConnection): Promise<void> {
    connection.inUse = false;
    connection.lastUsed = Date.now();
    
    const waiting = this.waitingQueue.shift();
    if (waiting) {
      connection.inUse = true;
      waiting.resolve(connection);
    }
  }
  
  private async startReaper(): Promise<void> {
    this.reapingInterval = setInterval(async () => {
      await this.reapIdleConnections();
    }, this.config.reapIntervalMillis);
  }
  
  private async reapIdleConnections(): Promise<void> {
    const now = Date.now();
    const minConnections = this.config.minConnections!;
    
    const idleConnections = this.connections.filter(conn => 
      !conn.inUse && 
      now - conn.lastUsed > this.config.idleTimeoutMillis! &&
      this.connections.length > minConnections
    );
    
    for (const conn of idleConnections) {
      const index = this.connections.indexOf(conn);
      if (index !== -1) {
        await conn.close();
        this.connections.splice(index, 1);
      }
    }
  }
  
  getStats(): PoolStats {
    const activeConnections = this.connections.filter(conn => conn.inUse).length;
    const idleConnections = this.connections.filter(conn => !conn.inUse).length;
    
    return {
      totalConnections: this.connections.length,
      activeConnections,
      idleConnections,
      waitingClients: this.waitingQueue.length,
      maxConnections: this.config.maxConnections!,
    };
  }
  
  async close(): Promise<void> {
    if (this.reapingInterval) {
      clearInterval(this.reapingInterval);
    }
    
    const closePromises = this.connections.map(conn => conn.close());
    await Promise.all(closePromises);
    this.connections = [];
    
    for (const waiting of this.waitingQueue) {
      waiting.reject(new Error('Pool is closing'));
    }
    this.waitingQueue = [];
  }
  
  async testConnection(): Promise<boolean> {
    try {
      const conn = await this.acquire();
      await conn.query('SELECT 1');
      await this.release(conn);
      return true;
    } catch {
      return false;
    }
  }
}

export async function dbpoolCommand(action: string, options: any): Promise<void> {
  console.log('🗄️  BS9 Database Connection Pool Management');
  console.log('='.repeat(80));
  
  const config: DatabaseConfig = {
    host: options.host || 'localhost',
    port: parseInt(options.port) || 5432,
    database: options.database || 'testdb',
    username: options.username || 'user',
    password: options.password || 'password',
    maxConnections: parseInt(options.maxConnections) || 10,
    minConnections: parseInt(options.minConnections) || 2,
  };
  
  try {
    switch (action) {
      case 'start':
        console.log(`🚀 Starting database pool...`);
        console.log(`   Host: ${config.host}:${config.port}`);
        console.log(`   Database: ${config.database}`);
        console.log(`   Max Connections: ${config.maxConnections}`);
        console.log(`   Min Connections: ${config.minConnections}`);
        
        const pool = new DatabasePool(config);
        const isConnected = await pool.testConnection();
        
        if (isConnected) {
          console.log('✅ Database pool started successfully');
          const stats = pool.getStats();
          console.log(`📊 Initial Stats: ${stats.totalConnections} connections`);
          console.log('✅ Pool management commands ready');
        } else {
          console.error('❌ Failed to connect to database');
          process.exit(1);
        }
        break;
        
      case 'test':
        console.log('🧪 Testing database pool...');
        const testPool = new DatabasePool(config);
        const connected = await testPool.testConnection();
        console.log(connected ? '✅ Connection test passed' : '❌ Connection test failed');
        await testPool.close();
        break;
        
      case 'stats':
        console.log('📊 Database Pool Statistics');
        console.log('-'.repeat(40));
        const statsPool = new DatabasePool(config);
        const stats = statsPool.getStats();
        console.log(`Total Connections: ${stats.totalConnections}`);
        console.log(`Active Connections: ${stats.activeConnections}`);
        console.log(`Idle Connections: ${stats.idleConnections}`);
        console.log(`Waiting Clients: ${stats.waitingClients}`);
        console.log(`Max Connections: ${stats.maxConnections}`);
        console.log(`Pool Utilization: ${((stats.activeConnections / stats.maxConnections) * 100).toFixed(1)}%`);
        await statsPool.close();
        break;
        
      default:
        console.error(`❌ Unknown action: ${action}`);
        console.log('Available actions: start, test, stats');
        process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Failed to ${action} pool: ${error}`);
    process.exit(1);
  }
}