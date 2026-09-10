#!/usr/bin/env bun

/**
 * BS9 - Ecosystem Configuration Generator Command
 * Generates sample ecosystem.config.js template in current working directory.
 * Mirrors `pm2 ecosystem` / `pm2 init`
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface EcosystemInitOptions {
  json?: boolean;
  ts?: boolean;
}

export async function ecosystemInitCommand(options: EcosystemInitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  if (options.json) {
    const jsonPath = join(cwd, "bs9.config.json");
    if (existsSync(jsonPath)) {
      console.warn(`⚠️  Configuration file '${jsonPath}' already exists.`);
      return;
    }

    const jsonTemplate = {
      apps: [
        {
          name: "my-app",
          script: "./index.ts",
          instances: "max",
          port: 3000,
          env: {
            NODE_ENV: "development",
            PORT: "3000"
          },
          env_production: {
            NODE_ENV: "production",
            PORT: "3000"
          }
        }
      ]
    };

    writeFileSync(jsonPath, JSON.stringify(jsonTemplate, null, 2));
    console.log(`✅ Created BS9 JSON configuration template: ${jsonPath}`);
    return;
  }

  const jsFileName = options.ts ? "ecosystem.config.ts" : "ecosystem.config.js";
  const jsPath = join(cwd, jsFileName);

  if (existsSync(jsPath)) {
    console.warn(`⚠️  Configuration file '${jsPath}' already exists.`);
    return;
  }

  const template = `/**
 * BS9 & PM2 Ecosystem Configuration Template
 * 
 * Run with BS9:
 *   bs9 start ${jsFileName}
 *   bs9 start ${jsFileName} --env production
 */

export default {
  apps: [
    {
      name: "web-api",
      script: "./src/index.ts",
      instances: "max",         // "max" uses all CPU cores via Bun reusePort cluster
      port: 3000,
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
    {
      name: "background-worker",
      script: "./src/worker.ts",
      instances: 2,
      args: ["--queue", "default"],
      env: {
        NODE_ENV: "production",
      }
    }
  ],
};
`;

  writeFileSync(jsPath, template);
  console.log(`✅ Created ecosystem configuration template: ${jsPath}`);
  console.log(`💡 Start with: bs9 start ${jsFileName}`);
}
