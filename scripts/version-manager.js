#!/usr/bin/env bun

/**
 * BS9 Version Manager
 * Automatic version management and changelog updates
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

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

function updatePackageJson(version) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
  packageJson.version = version;
  writeFileSync("package.json", JSON.stringify(packageJson, null, 2));
  console.log(`✅ Updated package.json to v${version}`);
}

function updateReadmeVersion(version) {
  const readme = readFileSync("README.md", "utf-8");
  const updatedReadme = readme.replace(
    /\[!\[Version\].*v\d+\.\d+\.\d+.*\]\(https:\/\/github\.com\/xarhang\/bs9\)/,
    `[![Version](https://img.shields.io/badge/version-${version}-blue.svg)](https://github.com/xarhang/bs9)`
  );
  writeFileSync("README.md", updatedReadme);
  console.log(`✅ Updated README.md to v${version}`);
}

function updateChangelog(version, changes) {
  const changelog = readFileSync("CHANGELOG.md", "utf-8");
  const date = new Date().toISOString().split('T')[0];
  
  const newEntry = `## [${version}] - ${date}

### ✨ New Features
${changes.map(change => `- ${change}`).join('\n')}

### 🔧 Technical Improvements
- Automated version management
- Enhanced changelog generation
- Improved documentation updates

### 📚 Documentation
- Updated version references
- Enhanced feature documentation

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
    execSync("git add .", { stdio: "inherit" });
    execSync(`git commit -m "🚀 v${version}: Automated version update

- Updated package.json to v${version}
- Updated README.md version badge
- Updated CHANGELOG.md with new version
- Automated version management process"`, { stdio: "inherit" });
    execSync(`git tag v${version}`, { stdio: "inherit" });
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
  updateChangelog(versionString, changes.length > 0 ? changes : ["Automated version update"]);
  
  // Commit and tag
  commitAndTag(versionString);
  
  console.log(`🎉 Version ${versionString} ready for publishing!`);
  console.log(`💡 Run 'bun publish' to publish to npm`);
}

if (import.meta.main) {
  main();
}
