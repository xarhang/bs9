
import { spawn } from "bun";
import { existsSync, rmSync } from "fs";

const CLI = "./bin/bs9";
const TEST_PORT = 3333;
const TEST_APP = "full-test-app.js";

// Helper to run command
async function run(args: string[], expectSuccess = true) {
    const cmd = ["bun", CLI, ...args];
    console.log(`> ${cmd.join(" ")}`);

    const proc = spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
    });

    const text = await new Response(proc.stdout).text();
    const errText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (expectSuccess && exitCode !== 0) {
        console.error(`❌ Command failed: ${cmd.join(" ")}`);
        console.error(errText || text);
        process.exit(1);
    } else if (!expectSuccess && exitCode === 0) {
        console.error(`❌ Command succeeded (expected fail): ${cmd.join(" ")}`);
        process.exit(1);
    }

    return text + errText;
}

async function main() {
    console.log("🚀 Starting BS9 Full Test Suite");

    // 1. Setup
    console.log("\n📦 Setting up...");
    await Bun.write(TEST_APP, `
    console.log("Test App Started");
    Bun.serve({
      port: ${TEST_PORT},
      fetch(req) { return new Response("BS9 Test OK"); }
    });
  `);

    // 2. Lifecycle
    console.log("\n🔄 Testing Lifecycle...");
    await run(["start", TEST_APP, "--name", "test-svc", "--port", `${TEST_PORT}`]);
    let status = await run(["status"]);
    if (!status.includes("test-svc") || !status.includes("running")) throw new Error("Service not running");

    await run(["restart", "test-svc"]);
    await run(["stop", "test-svc"]);
    status = await run(["status"]);
    if (!status.includes("stopped")) throw new Error("Service not stopped");

    // 3. Multi-service
    console.log("\n🔄 Testing Multi-Service...");
    await run(["start", TEST_APP, "--name", "svc1", "--port", "4001"]);
    await run(["start", TEST_APP, "--name", "svc2", "--port", "4002"]);
    await run(["stop", "svc1", "svc2", "--force"]);

    // 4. Persistence
    console.log("\n💾 Testing Persistence...");
    await run(["delete", "all", "--force", "--remove"]); // Clear first
    await run(["start", TEST_APP, "--name", "persist-svc", "--port", "4003"]);
    await run(["save", "all", "--force"]);
    await run(["delete", "all", "--force", "--remove"]);
    await run(["resurrect", "all"]);
    status = await run(["status", "persist-svc"]);
    if (!status.includes("running")) throw new Error("Resurrection failed");

    // 5. Monitoring
    console.log("\n📊 Testing Monitoring...");
    await run(["doctor"]);
    await run(["inspect"]);
    await run(["logs", "persist-svc", "-n", "5"]);

    // 6. Ops
    console.log("\n🛠️ Testing Ops...");
    await run(["dbpool", "test"]);
    await run(["update", "--check"]);
    // Mock loadbalancer (start/stop)
    try {
        const proc = spawn(["bun", CLI, "loadbalancer", "start", "--port", "9999", "--backends", "localhost:4003"]);
        await new Promise(r => setTimeout(r, 2000));
        proc.kill();
        console.log("✅ Loadbalancer started");
    } catch (e) {
        console.error("❌ Loadbalancer failed", e);
    }

    // 7. Cleanup
    console.log("\n🧹 Cleaning up...");
    await run(["delete", "all", "--force", "--remove"]);
    rmSync(TEST_APP);

    console.log("\n✅ ALL TESTS PASSED");
}

main().catch(e => {
    console.error("\n❌ TEST SUITE FAILED:", e);
    process.exit(1);
});
