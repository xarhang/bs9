#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

if (process.env.BS9_REBOOT_E2E !== "1") {
  throw new Error("Set BS9_REBOOT_E2E=1 on a disposable self-hosted test machine");
}

const phase = process.argv[2];
const root = process.env.BS9_REBOOT_E2E_DIR || join(homedir(), ".bs9-reboot-e2e");
const checkpoint = join(root, "checkpoint.json");
const appFile = join(root, "reboot-canary.ts");
const serviceName = "bs9-reboot-canary";
const port = 49321;

function run(args: string[], allowFailure = false): string {
  const result = spawnSync("bs9", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 60_000,
    env: { ...process.env, BS9_WINDOWS_BACKGROUND: "1" },
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`bs9 ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function waitForHealth(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.text()) === "ok") return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`reboot canary did not become healthy on port ${port}`);
}

if (phase === "before") {
  mkdirSync(root, { recursive: true });
  writeFileSync(appFile, `Bun.serve({\n  port: Number(process.env.PORT || ${port}),\n  fetch(request) {\n    const path = new URL(request.url).pathname;\n    return new Response(path === "/health" ? "ok" : "bs9 reboot canary");\n  },\n});\n`);
  run(["delete", serviceName, "--force"], true);
  run(["start", appFile, "--name", serviceName, "--port", String(port)]);
  await waitForHealth();
  run(["save", serviceName]);
  run(["startup"]);
  writeFileSync(checkpoint, JSON.stringify({ serviceName, port, preparedAt: new Date().toISOString() }, null, 2));
  console.log(`PRE_REBOOT_OK ${checkpoint}`);
  console.log("Reboot this disposable host, then run the after phase.");
} else if (phase === "after") {
  if (!existsSync(checkpoint)) throw new Error("pre-reboot checkpoint is missing");
  const before = JSON.parse(readFileSync(checkpoint, "utf8"));
  try {
    await waitForHealth(60_000);
  } catch {
    run(["resurrect", serviceName]);
    await waitForHealth(60_000);
  }
  const status = run(["status", serviceName]);
  if (!status.includes(serviceName)) throw new Error("service is absent after reboot recovery");
  console.log(JSON.stringify({ passed: true, before, recoveredAt: new Date().toISOString(), platform: process.platform }));
  run(["delete", serviceName, "--force"], true);
  rmSync(root, { recursive: true, force: true });
} else {
  throw new Error("Usage: bun scripts/reboot-recovery.ts <before|after>");
}
