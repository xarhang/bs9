#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";

interface WebOptions {
  port?: string;
  detach?: boolean;
}

export async function webCommand(options: WebOptions): Promise<void> {
  const port = options.port || "8080";
  const dashboardPath = `${import.meta.dir}/../web/dashboard.ts`;
  
  console.log(`🌐 Starting BS9 Web Dashboard on port ${port}`);
  
  if (options.detach) {
    // Run in background
    const child = spawn("bun", ["run", dashboardPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WEB_DASHBOARD_PORT: port,
      },
    });
    
    child.unref();
    
    console.log(`✅ Web dashboard started in background`);
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   Process ID: ${child.pid}`);
    console.log(`   Stop with: kill ${child.pid}`);
  } else {
    // Run in foreground
    console.log(`   URL: http://localhost:${port}`);
    console.log(`   Press Ctrl+C to stop`);
    console.log('');
    
    try {
      execSync(`WEB_DASHBOARD_PORT=${port} bun run ${dashboardPath}`, { 
        stdio: "inherit" 
      });
    } catch (error) {
      console.error(`❌ Failed to start web dashboard: ${error}`);
      process.exit(1);
    }
  }
}
