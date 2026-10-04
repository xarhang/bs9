import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { AlertManager, formatWebhookForDisplay } from "../src/alerting/config.js";
import { escapePlistXmlText, generateLaunchdPlist, isValidServiceName } from "../src/macos/launchd.js";
import { generateLinuxServiceUnit, assertSystemctlSuccess } from "../src/commands/start.js";
import { generateResurrectLaunchdPlist, generateResurrectSystemdUnit } from "../src/commands/startup.js";
import { formatSystemdExecStart } from "../src/utils/systemd.js";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "bs9-lifecycle-security-"));
  tempDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production lifecycle serialization and credential handling", () => {
  it("formats Linux ExecStart and environment values with spaces, quotes, backslashes, and percent specifiers", () => {
    const file = "/tmp/Application Space/api file.ts";
    const unit = generateLinuxServiceUnit({
      serviceName: "api",
      fullPath: file,
      host: "127.0.0.1",
      port: "3000",
      protocol: "http",
      env: ["DB_PASSWORD=one two%h 'quoted' \"value\""],
      otel: false,
      prometheus: false,
    });

    expect(unit).toContain("\"" + file.replace(/\\/g, "\\\\") + "\"");
    const expectedEnvironment = "Environment=\"DB_PASSWORD=one two%%h " + "'quoted'" + " \\\"value\\\"\"";
    expect(unit).toContain(expectedEnvironment);
    expect(unit).toContain('WorkingDirectory="/tmp/Application Space"');
  });

  it("rejects malformed or directive-injection environment assignments", () => {
    const base = {
      serviceName: "api",
      fullPath: "/srv/api.ts",
      host: "127.0.0.1",
      port: "3000",
      protocol: "http",
      otel: false,
      prometheus: false,
    };
    expect(() => generateLinuxServiceUnit({ ...base, env: ["NO_EQUALS"] })).toThrow("Invalid environment assignment");
    expect(() => generateLinuxServiceUnit({ ...base, env: ["APP_KEY=good\nExecStart=/tmp/evil"] })).toThrow("Invalid environment assignment");
  });

  it("keeps cluster preload flag and preload path as distinct ExecStart arguments", () => {
    const unit = generateLinuxServiceUnit({
      serviceName: "api-0-g1",
      fullPath: "/srv/my app/api.ts",
      host: "127.0.0.1",
      port: "3000",
      protocol: "http",
      env: ["BS9_REUSE_PORT=true"],
      otel: false,
      prometheus: false,
    });

    expect(unit).toContain(" run --preload ");
    expect(unit).toContain("cluster-preload.ts");
    expect(unit).not.toContain("--preload \\\"");
  });

  it("formats the boot resurrection executable and arguments as separate systemd tokens", () => {
    const start = formatSystemdExecStart("/opt/Bun Install/bun%h", ["/opt/BS9 Package/bin/bs9", "resurrect", "--all"]);
    const unit = generateResurrectSystemdUnit(start);
    expect(unit).toContain("ExecStart=\"/opt/Bun Install/bun%%h\" \"/opt/BS9 Package/bin/bs9\" resurrect --all");
  });

  it("escapes XML characters in the macOS startup executable and script paths", () => {
    const plist = generateResurrectLaunchdPlist("/opt/Bun & Tools/bun", ["/opt/BS9 <Package>/bin/bs9"]);
    expect(plist).toContain("<string>/opt/Bun &amp; Tools/bun</string>");
    expect(plist).toContain("<string>/opt/BS9 &lt;Package&gt;/bin/bs9</string>");
    expect(plist).not.toContain("/opt/Bun & Tools/bun");
  });

  it("propagates a failed systemctl start result", () => {
    expect(() => assertSystemctlSuccess({ status: 1 }, "start api.service")).toThrow("failed with exit code 1");
    expect(() => assertSystemctlSuccess({ status: null, signal: "SIGTERM" }, "start api.service")).toThrow("signal SIGTERM");
    expect(() => assertSystemctlSuccess({ status: 0 }, "start api.service")).not.toThrow();
  });

  it("escapes plist XML metacharacters in labels, arguments, paths, and environment secrets", () => {
    const plist = generateLaunchdPlist({
      label: "bs9.api",
      programArguments: ["/Applications/A&B/app<one>.js", "</string><key>Injected</key>"],
      workingDirectory: "/Applications/A&B",
      environmentVariables: { WEBHOOK: "secret&<value>\"'" },
      runAtLoad: true,
      keepAlive: true,
    });

    expect(plist).toContain("/Applications/A&amp;B/app&lt;one&gt;.js");
    expect(plist).toContain("&lt;/string&gt;&lt;key&gt;Injected&lt;/key&gt;");
    expect(plist).toContain("secret&amp;&lt;value&gt;");
    expect(plist).toContain("&quot;&apos;");
    expect(plist).not.toContain("secret&<value>");
    expect(() => escapePlistXmlText("invalid\u0001control")).toThrow("forbidden by XML 1.0");
  });

  it("rejects launchd names that could escape service and backup directories", () => {
    expect(isValidServiceName("bs9.api")).toBe(true);
    expect(isValidServiceName("../../outside")).toBe(false);
    expect(isValidServiceName("api\\outside")).toBe(false);
  });

  it("stores alert webhook config privately on POSIX and redacts it from display output", () => {
    const configPath = join(makeTempDirectory(), "bs9", "alerts.json");
    const secretUrl = "https://hooks.example.test/services/private-token?auth=secret";
    const manager = new AlertManager(configPath);
    manager.updateConfig({ webhookUrl: secretUrl });

    expect(JSON.parse(readFileSync(configPath, "utf8")).webhookUrl).toBe(secretUrl);
    expect(formatWebhookForDisplay(secretUrl)).toBe("[configured; value redacted]");
    expect(formatWebhookForDisplay()).toBe("[not configured]");
    let validationError = "";
    try {
      manager.updateConfig({ webhookUrl: "javascript:private-token-secret" });
    } catch (error) {
      validationError = (error as Error).message;
    }
    expect(validationError).toContain("Invalid webhook URL");
    expect(validationError).not.toContain("private-token-secret");

    if (process.platform === "linux" || process.platform === "darwin") {
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);

      chmodSync(configPath, 0o644);
      new AlertManager(configPath);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});
