#!/usr/bin/env bun

/**
 * BS9 Auto Publisher
 * Automated publishing workflow for incremental versions
 */

import { spawnSync } from "node:child_process";

const VALID_INCREMENT_TYPES = new Set(["patch", "minor", "major"]);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}`);
  }
}

function autoPublish(type = 'patch', changes = []) {
  console.log(`🚀 BS9 Auto Publisher - ${type} increment with publish`);
  
  try {
    if (!VALID_INCREMENT_TYPES.has(type)) {
      throw new Error("Version increment must be patch, minor, or major");
    }

    // Step 1: Update version and changelog
    console.log("📝 Step 1: Updating version and changelog...");
    run("bun", ["scripts/version-manager.js", type, ...changes]);
    
    // Step 2: Push to GitHub
    console.log("📤 Step 2: Pushing to GitHub...");
    run("git", ["push", "origin", "main", "--tags"]);
    
    // Step 3: Publish to npm
    console.log("📦 Step 3: Publishing to npm...");
    run("bun", ["publish"]);
    
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
