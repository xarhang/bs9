#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

interface WebOptions {
  port?: string;
  detach?: boolean;
}

// Security: Port validation
function isValidPort(port: string): boolean {
  const portNum = Number(port);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

// Security: Generate secure session token
function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export async function webCommand(options: WebOptions): Promise<void> {
  // Security: Validate port
  const port = options.port || "8080";
  if (!isValidPort(port)) {
    console.error(`❌ Security: Invalid port number: ${port}. Must be 1-65535`);
    process.exit(1);
  }
  
  const dashboardPath = `${import.meta.dir}/../web/dashboard.ts`;
  
  // Security: Generate session token for authentication
  const sessionToken = generateSessionToken();
  
  console.log(`🌐 Starting BS9 Web Dashboard on port ${port}`);
  console.log(`🔐 Session Token: ${sessionToken}`);
  
  if (options.detach) {
    // Run in background with security
    const child = spawn("bun", ["run", dashboardPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WEB_DASHBOARD_PORT: port,
        WEB_SESSION_TOKEN: sessionToken,
        NODE_ENV: "production",
      },
    });
    
    child.unref();
    
    console.log(`✅ Web dashboard started in background`);
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   Process ID: ${child.pid}`);
    console.log(`   Stop with: kill ${child.pid}`);
    console.log(`   🔐 Use session token for API access`);
  } else {
    // Run in foreground with security
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   🔐 Session token: ${sessionToken}`);
    console.log(`   Press Ctrl+C to stop`);
    console.log('');
    
    try {
      execSync(`WEB_DASHBOARD_PORT=${port} WEB_SESSION_TOKEN=${sessionToken} NODE_ENV=production bun run ${dashboardPath}`, { 
        stdio: "inherit" 
      });
    } catch (error) {
      console.error(`❌ Failed to start web dashboard: ${error}`);
      process.exit(1);
    }
  }
}
