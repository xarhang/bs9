#!/usr/bin/env bun

/**
 * BS9 Test Publisher
 * Automated version update without publishing (for testing)
 */

import { execSync } from "node:child_process";

function testPublish(type = 'patch', changes = []) {
  console.log(`🧪 BS9 Test Publisher - ${type} increment (no publish)`);
  
  try {
    // Step 1: Update version and changelog
    console.log("📝 Step 1: Updating version and changelog...");
    execSync(`bun scripts/version-manager.js ${type} ${changes.join(' ')}`, { stdio: "inherit" });
    
    // Step 2: Push to GitHub
    console.log("📤 Step 2: Pushing to GitHub...");
    execSync("git push origin main --tags", { stdio: "inherit" });
    
    console.log("🎉 Test publish completed successfully!");
    console.log("💡 Run 'bun publish' manually to publish to npm");
    
  } catch (error) {
    console.error("❌ Test publish failed:", error.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || 'patch';
  const changes = args.slice(1);
  
  testPublish(type, changes);
}

if (import.meta.main) {
  main();
}
