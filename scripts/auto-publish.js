#!/usr/bin/env bun

/**
 * BS9 Auto Publisher
 * Full end-to-end release workflow:
 * 1. Sync version across package.json, README, GitHub Pages (docs/index.md, COMMANDS.md, HA_RUNTIME.md),
 *    llms.txt, setup.sh, src/mcp/server.ts, and CHANGELOG.md
 * 2. Run TypeScript check (`./node_modules/.bin/tsc --noEmit`) and bundle (`bun run build`)
 * 3. Git commit + tag `vX.Y.Z`
 * 4. Push `main` and tags to GitHub (`git push origin main --tags`)
 * 5. Create official GitHub Release (`gh release create vX.Y.Z`) which triggers GitHub Pages & canary workflows
 * 6. Publish package to npm (`bun publish --auth-type=web` with automatic fallback to `npm login --auth-type=web`)
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const VALID_INCREMENT_TYPES = new Set(["patch", "minor", "major"]);

function run(command, args, allowFail = false) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) {
    if (allowFail) return false;
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFail) return false;
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
  }
  return true;
}

function getPackageVersion() {
  return JSON.parse(readFileSync("package.json", "utf-8")).version;
}

function extractLatestChangelogSection(version) {
  try {
    const changelog = readFileSync("CHANGELOG.md", "utf-8");
    const header = `## [${version}]`;
    const startIdx = changelog.indexOf(header);
    if (startIdx === -1) return "";
    const afterHeader = changelog.indexOf("\n", startIdx);
    const nextSection = changelog.indexOf("\n## [", afterHeader + 1);
    const body =
      nextSection === -1
        ? changelog.slice(afterHeader + 1).trim()
        : changelog.slice(afterHeader + 1, nextSection).trim();
    return body;
  } catch {
    return "";
  }
}

function autoPublish(type = "patch", changes = []) {
  console.log(`🚀 BS9 Auto Publisher - ${type} release workflow`);

  try {
    if (!VALID_INCREMENT_TYPES.has(type) && !/^\d+\.\d+\.\d+$/.test(type)) {
      throw new Error("Version increment must be patch, minor, major, or explicit X.Y.Z");
    }

    // Step 1: Update all version files, changelog, typecheck, build, commit & tag
    console.log("\n📝 Step 1/4: Updating version files, docs, changelog, building, and tagging...");
    run("bun", ["scripts/version-manager.js", type, ...changes]);

    const version = getPackageVersion();
    const tag = `v${version}`;

    // Step 2: Push main and tags to GitHub (triggers GitHub Pages deployment on main)
    console.log(`\n📤 Step 2/4: Pushing main and tag ${tag} to GitHub...`);
    run("git", ["push", "origin", "main", "--tags"]);

    // Step 3: Create GitHub Release via gh CLI
    console.log(`\n🏷️  Step 3/4: Creating GitHub Release ${tag}...`);
    const notes = extractLatestChangelogSection(version);
    const ghArgs = notes
      ? ["release", "create", tag, "--title", `${tag}`, "--notes", notes]
      : ["release", "create", tag, "--title", `${tag}`, "--generate-notes"];
    if (!run("gh", ghArgs, true)) {
      console.log(`ℹ️  GitHub Release ${tag} already exists or gh CLI skipped; continuing to npm publish.`);
    }

    // Step 4: Publish to npm registry (with web auth support for 2FA)
    console.log(`\n📦 Step 4/4: Publishing bs9@${version} to npm...`);
    const published = run("bun", ["publish", "--auth-type=web"], true);
    if (!published) {
      console.log("🔑 npm session not active. Launching `npm login --auth-type=web`...");
      run("npm", ["login", "--auth-type=web"]);
      run("bun", ["publish", "--auth-type=web"]);
    }

    console.log(`\n🎉 Release ${tag} completed end-to-end (GitHub + Pages + Release + npm)!`);
  } catch (error) {
    console.error("❌ Auto publish failed:", error.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || "patch";
  const changes = args.slice(1);

  autoPublish(type, changes);
}

if (import.meta.main) {
  main();
}
