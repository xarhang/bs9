#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read package.json
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

// Read bin/bs9
const binPath = path.join(__dirname, '../bin/bs9');
let binContent = fs.readFileSync(binPath, 'utf8');

// Update version in bin/bs9
const versionRegex = /version\("[^"]+"\)/g;
binContent = binContent.replace(versionRegex, `version("${version}")`);

// Write back to bin/bs9
fs.writeFileSync(binPath, binContent);

console.log(`✅ Updated version in bin/bs9 to ${version}`);

// Run build
const { execSync } = require('child_process');
try {
  execSync('bun build ./bin/bs9 --outdir ./dist --target bun', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  console.log('✅ Build completed');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}
