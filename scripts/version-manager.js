#!/usr/bin/env bun

/**
 * BS9 Version Manager
 * Automatic version management and changelog updates
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function getCurrentVersion() {
  const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
  const version = packageJson.version;
  const [major, minor, patch] = version.split('.').map(Number);
  
  return { major, minor, patch };
}

function incrementVersion(current, type = 'patch') {
  const newVersion = { ...current };
  
  switch (type) {
    case 'patch':
      newVersion.patch++;
      break;
    case 'minor':
      newVersion.minor++;
      newVersion.patch = 0;
      break;
    case 'major':
      newVersion.major++;
      newVersion.minor = 0;
      newVersion.patch = 0;
      break;
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
      const lastTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (lastTag) range = [`${lastTag}..HEAD`];
    } catch {
      range = ["-n", "10"];
    }
    const raw = execFileSync("git", ["log", ...range, "--pretty=format:%s"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
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
  writeFileSync("package.json", JSON.stringify(packageJson, null, 2));
  console.log(`✅ Updated package.json to v${version}`);
}

function updateReadmeVersion(version) {
  const readme = readFileSync("README.md", "utf-8");
  const updatedReadme = readme.replace(
    /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-\d+\.\d+\.\d+-blue\.svg\)\]\(https:\/\/github\.com\/xarhang\/bs9\)/,
    `[![Version](https://img.shields.io/badge/version-${version}-blue.svg)](https://github.com/xarhang/bs9)`
  );
  writeFileSync("README.md", updatedReadme);
  console.log(`✅ Updated README.md to v${version}`);
}

function updateChangelog(version, changes) {
  const changelog = readFileSync("CHANGELOG.md", "utf-8");
  const date = new Date().toISOString().split('T')[0];
  
  const newEntry = `## [${version}] - ${date}

### Changes
${changes.map(change => `- ${change}`).join('\n')}

`;
  
  const updatedChangelog = changelog.replace(
    /# BS9 Changelog\n\nAll notable changes to this project will be documented in this file\.\n\nThe format is based on \[Keep a Changelog\]\(https:\/\/keepachangelog\.com\/en\/1\.0\.0\/\),\nand this project adheres to \[Semantic Versioning\]\(https:\/\/semver\.org\/spec\/v2\.0\.0\.html\)\.\n\n/,
    `# BS9 Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n${newEntry}`
  );
  
  writeFileSync("CHANGELOG.md", updatedChangelog);
  console.log(`✅ Updated CHANGELOG.md with v${version}`);
}

function commitAndTag(version) {
  try {
    execFileSync("git", ["add", "."], { stdio: "inherit" });
    execFileSync("git", [
      "commit",
      "-m",
      `🚀 v${version}: Automated version update\n\n- Updated package.json to v${version}\n- Updated README.md version badge\n- Updated CHANGELOG.md with new version`,
    ], { stdio: "inherit" });
    execFileSync("git", ["tag", `v${version}`], { stdio: "inherit" });
    console.log(`✅ Committed and tagged v${version}`);
  } catch (error) {
    console.log(`⚠️  Git operations failed: ${error}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const type = args[0] || 'patch';
  const changes = args.slice(1);
  
  console.log(`🚀 BS9 Version Manager - ${type} increment`);
  
  const currentVersion = getCurrentVersion();
  const newVersion = incrementVersion(currentVersion, type);
  const versionString = formatVersion(newVersion);
  
  console.log(`📦 Current: ${formatVersion(currentVersion)} → New: ${versionString}`);
  
  // Update all files
  updatePackageJson(versionString);
  updateReadmeVersion(versionString);
  updateChangelog(versionString, changes.length > 0 ? changes : getChangesFromGit());
  
  // Commit and tag
  commitAndTag(versionString);
  
  console.log(`🎉 Version ${versionString} ready for publishing!`);
  console.log(`💡 Run 'bun publish' to publish to npm`);
}

if (import.meta.main) {
  main();
}
