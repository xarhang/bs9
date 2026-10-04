import { describe, expect, it } from "bun:test";
import {
  WindowsServiceManager,
  getWindowsPowerShellEnvironment,
  quoteWindowsCommandLineArgument,
  requiresNativeServiceIdentityFallback,
} from "../src/windows/service.js";

describe("Windows SCM service host generation", () => {
  it("keeps PowerShell 7 module directories from shadowing Windows PowerShell security cmdlets", () => {
    const env = getWindowsPowerShellEnvironment({
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      PSModulePath: "C:\\PowerShell7\\Modules;C:\\Codex\\Modules",
    });

    expect(env.PSModulePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules",
    );
  });

  it("quotes native command line arguments using Windows rules", () => {
    expect(quoteWindowsCommandLineArgument("C:\\Program Files\\Bun\\bun.exe"))
      .toBe('"C:\\Program Files\\Bun\\bun.exe"');
    expect(quoteWindowsCommandLineArgument('value with "quotes"'))
      .toBe('"value with \\"quotes\\""');
    expect(quoteWindowsCommandLineArgument("C:\\directory with space\\"))
      .toBe('"C:\\directory with space\\\\"');
  });

  it("generates a ServiceBase wrapper and keeps environment secrets out of setup scripts", () => {
    const originalProgramData = process.env.ProgramData;
    process.env.ProgramData = "C:\\Program Files\\BS9 O'Brien";
    try {
      const manager = new WindowsServiceManager();
      const script = manager.generateServiceScript({
        name: "BS9_Api",
        displayName: "API's Windows Service",
        description: "Production API service",
        executable: "C:\\Users\\app\\.bun\\bin\\bun.exe",
        arguments: ["run", "C:\\apps\\api server\\main.ts"],
        workingDirectory: "C:\\apps\\api server",
        environment: { JWT_SECRET: "do-not-copy-this-secret" },
      });
      const encodedSource = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
      const hostSource = encodedSource ? Buffer.from(encodedSource, "base64").toString("utf-8") : "";

      expect(script).toContain("Add-Type -TypeDefinition $source -OutputAssembly $hostPath -OutputType ConsoleApplication");
      expect(script).toContain("System.ServiceProcess");
      expect(script).toContain("sc.exe failure");
      expect(script).toContain("'NT AUTHORITY\\LocalService'");
      expect(script).toContain("'NT SERVICE\\BS9_Api'");
      expect(script).toContain("@('sidtype', $serviceName, 'unrestricted')");
      expect(script).toContain("$serviceRule = [System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid, [System.Security.AccessControl.FileSystemRights]::Modify");
      expect(script).toContain("C:\\Program Files\\BS9 O''Brien\\BS9\\services\\BS9_Api");
      expect(script).toContain('"C:\\Program Files\\BS9 O\'\'Brien\\BS9\\services\\BS9_Api\\bs9-service-host-');
      expect(script).not.toContain("JWT_SECRET");
      expect(script).not.toContain("do-not-copy-this-secret");
      expect(hostSource).toContain("class Bs9ServiceHost : ServiceBase");
      expect(hostSource).toContain("throw new System.TimeoutException(");
      expect(hostSource).toContain("SetMetadataState(\"stopped\")");
      expect(hostSource).toContain("taskkill.exe");
      expect(hostSource).toContain("killer.ExitCode != 0");
      expect(hostSource).toContain("Watchdog process remained active after taskkill completed");
      expect(hostSource).toContain("IsExpectedProcessRunning(appPid, appStartTime)");
      expect(hostSource).toContain("refusing PID-only termination");
      expect(hostSource).toContain("Environment.Exit(1)");
      expect(hostSource).toContain("BS9_SERVICES_DIR");
    } finally {
      if (originalProgramData === undefined) delete process.env.ProgramData;
      else process.env.ProgramData = originalProgramData;
    }
  });

  it("uses LocalSystem only when explicitly requested and generates an in-place migration script", () => {
    const manager = new WindowsServiceManager();
    const config = {
      name: "BS9_Legacy",
      displayName: "Legacy",
      description: "Existing service",
      executable: "C:\\Program Files\\Bun\\bun.exe",
      arguments: [],
      workingDirectory: "C:\\apps\\legacy",
      environment: {},
      serviceAccount: "LocalSystem" as const,
    };

    const createScript = manager.generateServiceScript(config);
    const migrationScript = manager.generateServiceScript({ ...config, serviceAccount: "LocalService" }, "configure");

    expect(createScript).toContain("$account = 'LocalSystem'");
    expect(migrationScript).toContain("$serviceArgs = @('config'");
    expect(migrationScript).toContain("$account = 'NT AUTHORITY\\LocalService'");
    expect(migrationScript).not.toContain("$serviceArgs = @('create'");
    expect(migrationScript.indexOf("& sc.exe @sidTypeArgs")).toBeLessThan(migrationScript.indexOf("& sc.exe @serviceArgs"));
    expect(migrationScript.indexOf("Set-Acl -LiteralPath $serviceDir")).toBeLessThan(migrationScript.indexOf("& sc.exe @serviceArgs"));
  });

  it("never falls back to the caller when an SCM identity is present or mismatched", () => {
    expect(requiresNativeServiceIdentityFallback("LocalService")).toBe(true);
    expect(requiresNativeServiceIdentityFallback("LocalSystem")).toBe(true);
    expect(requiresNativeServiceIdentityFallback(undefined, "NT AUTHORITY\\LocalService")).toBe(true);
    expect(requiresNativeServiceIdentityFallback("LocalService", "LocalSystem")).toBe(true);
    expect(requiresNativeServiceIdentityFallback(undefined, undefined, "LocalSystem")).toBe(true);
    expect(requiresNativeServiceIdentityFallback(undefined, "unknown")).toBe(false);
    expect(requiresNativeServiceIdentityFallback()).toBe(false);
  });

  it("refuses non-admin deletion of a registered SCM service before changing metadata", async () => {
    const manager = new WindowsServiceManager();
    Object.assign(manager as any, {
      checkAdminPrivileges: () => false,
      getNativeServiceAccount: () => "LocalService",
    });

    await expect(manager.deleteService("BS9_Protected"))
      .rejects.toThrow(/requires an elevated administrator shell/);
  });

  it("refuses non-admin stop when native SCM service metadata is missing", async () => {
    const manager = new WindowsServiceManager();
    Object.assign(manager as any, {
      checkAdminPrivileges: () => false,
      getNativeServiceAccount: () => "LocalService",
      getProcessMetadata: () => null,
    });

    await expect(manager.stopService("BS9_Orphaned"))
      .rejects.toThrow(/requires an elevated administrator shell/);
  });

  it("requires native services to be stopped before changing the SCM account", async () => {
    const manager = new WindowsServiceManager();
    Object.assign(manager as any, {
      checkAdminPrivileges: () => true,
      getNativeServiceAccount: () => "LocalSystem",
      getProcessMetadata: () => ({ name: "BS9_Migrating", executable: "bun.exe" }),
      isNativeServiceStopped: () => false,
    });

    await expect(manager.configureServiceAccount("BS9_Migrating", "LocalService"))
      .rejects.toThrow(/must be stopped before changing its account/);
  });
});
