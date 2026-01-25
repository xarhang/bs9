#!/usr/bin/env bun

/**
 * BS9 Auto Publisher
 * Automated publishing workflow for incremental versions
 */

import { execSync } from "node:child_process";

function autoPublish(type = 'patch', changes = []) {
  console.log(`🚀 BS9 Auto Publisher - ${type} increment with publish`);
  
  try {
    // Step 1: Update version and changelog
    console.log("📝 Step 1: Updating version and changelog...");
    execSync(`bun scripts/version-manager.js ${type} ${changes.join(' ')}`, { stdio: "inherit" });
    
    // Step 2: Push to GitHub
    console.log("📤 Step 2: Pushing to GitHub...");
    execSync("git push origin main --tags", { stdio: "inherit" });
    
    // Step 3: Publish to npm
    console.log("📦 Step 3: Publishing to npm...");
    execSync("bun publish", { stdio: "inherit" });
    
    console.log("🎉 Auto publish completed successfully!");
    
  } catch (error) {
    console.error("❌ Auto publish failed:", error.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || 'patch';
  const changes = args.slice(1);
  
  autoPublish(type, changes);
}

if (import.meta.main) {
  main();
}
