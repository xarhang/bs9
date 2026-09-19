#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: bun scripts/verify-published-canary.ts <version>");
}

const maxAttempts = Number(process.env.BS9_CANARY_REGISTRY_ATTEMPTS || "12");
let available = false;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const view = spawnSync("npm", ["view", `bs9@${version}`, "version"], { encoding: "utf8", shell: false });
  if (view.status === 0 && view.stdout.trim() === version) {
    available = true;
    break;
  }
  await Bun.sleep(10_000);
}
if (!available) throw new Error(`bs9@${version} did not become available in npm registry`);

const install = spawnSync("bun", ["add", "-g", `bs9@${version}`], { stdio: "inherit", shell: false });
if (install.status !== 0) process.exit(install.status ?? 1);

for (const args of [["-V"], ["--help"], ["doctor"]]) {
  const result = spawnSync("bs9", args, { encoding: "utf8", shell: process.platform === "win32", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`bs9 ${args.join(" ")} failed: ${result.stderr}`);
  if (!result.stdout.trim()) throw new Error(`bs9 ${args.join(" ")} produced no console output`);
}

console.log(`Published canary bs9@${version} passed on ${process.platform}/${process.arch}`);
