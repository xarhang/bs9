#!/usr/bin/env bun

/**
 * BS9 Version Manager
 * Comprehensive version synchronization across package.json, docs, MCP server,
 * installer script, llms.txt, and CHANGELOG.md, followed by typecheck, build, commit, and tag.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function getCurrentVersion() {
  const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
  const version = packageJson.version;
  const [major, minor, patch] = version.split(".").map(Number);

  return { major, minor, patch };
}

function incrementVersion(current, type = "patch") {
  if (/^\d+\.\d+\.\d+$/.test(type)) {
    const [major, minor, patch] = type.split(".").map(Number);
    return { major, minor, patch };
  }

  const newVersion = { ...current };

  switch (type) {
    case "patch":
      newVersion.patch++;
      break;
    case "minor":
      newVersion.minor++;
      newVersion.patch = 0;
      break;
    case "major":
      newVersion.major++;
      newVersion.minor = 0;
      newVersion.patch = 0;
      break;
    default:
      throw new Error(`Invalid increment type "${type}" (use patch, minor, major, or X.Y.Z)`);
  }

  return newVersion;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function getChangesFromGit() {
  try {
    let range = [];
    try {
      const lastTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (lastTag) range = [`${lastTag}..HEAD`];
    } catch {
      range = ["-n", "10"];
    }
    const raw = execFileSync("git", ["log", ...range, "--pretty=format:%s"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const subjects = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("🚀 v"));
    return subjects.length > 0 ? subjects : ["Maintenance and dependency updates"];
  } catch {
    return ["Maintenance and dependency updates"];
  }
}

function updatePackageJson(version) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
  packageJson.version = version;
  writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`✅ Updated package.json to v${version}`);
}

function updateReadmeVersion(version) {
  const readme = readFileSync("README.md", "utf-8");
  const updatedReadme = readme.replace(
    /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-\d+\.\d+\.\d+-blue\.svg\)\]\(https:\/\/github\.com\/xarhang\/bs9\)/,
    `[![Version](https://img.shields.io/badge/version-${version}-blue.svg)](https://github.com/xarhang/bs9)`
  );
  writeFileSync("README.md", updatedReadme);
  console.log(`✅ Updated README.md badge to v${version}`);
}

function updateDocsAndInstaller(version) {
  // 1. docs/index.md (GitHub Pages landing page)
  if (existsSync("docs/index.md")) {
    const indexMd = readFileSync("docs/index.md", "utf-8");
    const updated = indexMd.replace(
      /Bun Sentinel 9 · v\d+\.\d+\.\d+/g,
      `Bun Sentinel 9 · v${version}`
    );
    writeFileSync("docs/index.md", updated);
    console.log(`✅ Updated docs/index.md (GitHub Pages) to v${version}`);
  }

  // 2. docs/COMMANDS.md
  if (existsSync("docs/COMMANDS.md")) {
    const cmdMd = readFileSync("docs/COMMANDS.md", "utf-8");
    const updated = cmdMd.replace(
      /\*BS9 Version: \d+\.\d+\.\d+\*/g,
      `*BS9 Version: ${version}*`
    );
    writeFileSync("docs/COMMANDS.md", updated);
    console.log(`✅ Updated docs/COMMANDS.md to v${version}`);
  }

  // 3. docs/HA_RUNTIME.md
  if (existsSync("docs/HA_RUNTIME.md")) {
    const haMd = readFileSync("docs/HA_RUNTIME.md", "utf-8");
    const updated = haMd.replace(
      /high-availability behavior of BS9 \d+\.\d+\.\d+\./g,
      `high-availability behavior of BS9 ${version}.`
    );
    writeFileSync("docs/HA_RUNTIME.md", updated);
    console.log(`✅ Updated docs/HA_RUNTIME.md to v${version}`);
  }

  // 4. llms.txt
  if (existsSync("llms.txt")) {
    const llms = readFileSync("llms.txt", "utf-8");
    const updated = llms.replace(
      /^# BS9 \(Bun Sentinel 9\)(?: — v\d+\.\d+\.\d+)?/m,
      `# BS9 (Bun Sentinel 9) — v${version}`
    );
    writeFileSync("llms.txt", updated);
    console.log(`✅ Updated llms.txt to v${version}`);
  }

  // 5. setup.sh
  if (existsSync("setup.sh")) {
    const setup = readFileSync("setup.sh", "utf-8");
    const updated = setup.replace(
      /BS9_VERSION="\$\{BS9_VERSION:-\d+\.\d+\.\d+\}"/g,
      `BS9_VERSION="\${BS9_VERSION:-${version}}"`
    );
    writeFileSync("setup.sh", updated);
    console.log(`✅ Updated setup.sh default version to v${version}`);
  }

  // 6. src/mcp/server.ts
  if (existsSync("src/mcp/server.ts")) {
    const mcp = readFileSync("src/mcp/server.ts", "utf-8");
    const updated = mcp.replace(
      /(name:\s*"bs9-mcp",\s*version:\s*")\d+\.\d+\.\d+(")/,
      `$1${version}$2`
    );
    writeFileSync("src/mcp/server.ts", updated);
    console.log(`✅ Updated src/mcp/server.ts version to v${version}`);
  }
}

function updateChangelog(version, changes) {
  const changelog = readFileSync("CHANGELOG.md", "utf-8");
  if (changelog.includes(`## [${version}]`)) {
    console.log(`ℹ️  CHANGELOG.md already contains an entry for [${version}], keeping existing section.`);
    return;
  }

  const date = new Date().toISOString().split("T")[0];

  const newEntry = `## [${version}] - ${date}

### Changes
${changes.map((change) => `- ${change}`).join("\n")}

`;

  const updatedChangelog = changelog.replace(
    /# BS9 Changelog\n\nAll notable changes to this project will be documented in this file\.\n\nThe format is based on \[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.0\.0\/\),\nand this project adheres to \[Semantic Versioning\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)\.\n\n/,
    `# BS9 Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n${newEntry}`
  );

  writeFileSync("CHANGELOG.md", updatedChangelog);
  console.log(`✅ Updated CHANGELOG.md with v${version}`);
}

function verifyAndBuild() {
  console.log("🔍 Running TypeScript check (./node_modules/.bin/tsc --noEmit)...");
  execFileSync("./node_modules/.bin/tsc", ["--noEmit"], { stdio: "inherit" });
  console.log("🏗️  Building dist bundle (bun run build)...");
  execFileSync("bun", ["run", "build"], { stdio: "inherit" });
  console.log("✅ TypeScript check and build succeeded");
}

function commitAndTag(version) {
  try {
    execFileSync("git", ["add", "."], { stdio: "inherit" });
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        `🚀 v${version}: Release v${version}\n\n- Updated package.json, README.md, docs/index.md, docs/COMMANDS.md, docs/HA_RUNTIME.md, llms.txt, setup.sh, and src/mcp/server.ts to v${version}\n- Updated CHANGELOG.md with v${version}`,
      ],
      { stdio: "inherit" }
    );
    execFileSync("git", ["tag", "-f", `v${version}`], { stdio: "inherit" });
    console.log(`✅ Committed and tagged v${version}`);
  } catch (error) {
    console.log(`⚠️  Git operations failed: ${error}`);
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || "patch";
  const changes = args.slice(1);

  console.log(`🚀 BS9 Version Manager - ${type} increment`);

  const currentVersion = getCurrentVersion();
  const newVersion = incrementVersion(currentVersion, type);
  const versionString = formatVersion(newVersion);

  console.log(`📦 Current: ${formatVersion(currentVersion)} → New: ${versionString}`);

  // 1. Update all version references across repo & docs
  updatePackageJson(versionString);
  updateReadmeVersion(versionString);
  updateDocsAndInstaller(versionString);
  updateChangelog(versionString, changes.length > 0 ? changes : getChangesFromGit());

  // 2. Verify TypeScript & rebuild dist/
  verifyAndBuild();

  // 3. Commit and tag
  commitAndTag(versionString);

  console.log(`🎉 Version ${versionString} ready for publishing!`);
  console.log(`💡 Next: git push origin main --tags && gh release create v${versionString} --generate-notes && bun publish --auth-type=web`);
}

if (import.meta.main) {
  main();
}
