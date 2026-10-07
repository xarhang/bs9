import { describe, expect, it } from "bun:test";
import {
  WindowsServiceManager,
  createWindowsRestorePlan,
  getWindowsPowerShellEnvironment,
  getWindowsPowerShellExecutable,
  getWindowsProgramDataDirectory,
  getWindowsSystemExecutable,
  hasWindowsAdminPrivileges,
  quoteWindowsCommandLineArgument,
  requiresNativeServiceIdentityFallback,
  runWindowsPowerShell,
  validateWindowsRestoreApproval,
} from "../src/windows/service.js";

describe("Windows SCM service host generation", () => {
  it("keeps PowerShell 7 module directories from shadowing Windows PowerShell security cmdlets", () => {
    const systemDirectory = getWindowsSystemExecutable("sc.exe").replace(/\\sc\.exe$/i, "");
    const windowsRoot = systemDirectory.replace(/\\System32$/i, "");
    const env = getWindowsPowerShellEnvironment({
      SystemRoot: "C:\\Users\\alice\\fake-windows",
      ProgramFiles: "C:\\Program Files",
      PSModulePath: "C:\\PowerShell7\\Modules;C:\\Codex\\Modules",
    });

    expect(env.PSModulePath).toBe(`${systemDirectory}\\WindowsPowerShell\\v1.0\\Modules`);
    expect(env.SystemRoot).toBe(windowsRoot);
    expect(env.PATH).toBe(systemDirectory);
    expect(env.TEMP).toBe(systemDirectory);
    expect(env.TMP).toBe(systemDirectory);
  });

  it("resolves Windows management executables from the OS system directory, ignoring environment overrides", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    const powerShellPath = getWindowsPowerShellExecutable();
    const scPath = getWindowsSystemExecutable("sc.exe");
    try {
      process.env.SystemRoot = "C:\\Users\\alice\\fake-windows";
      process.env.WINDIR = "C:\\Users\\alice\\fake-windir";
      expect(getWindowsPowerShellExecutable()).toBe(powerShellPath);
      expect(getWindowsSystemExecutable("sc.exe")).toBe(scPath);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
    }
    expect(powerShellPath).toMatch(/^[a-zA-Z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    expect(scPath).toMatch(/^[a-zA-Z]:\\.*\\System32\\sc\.exe$/i);
  });

  it("does not let the legacy background environment switch override the privilege check", () => {
    const original = process.env.BS9_WINDOWS_BACKGROUND;
    const manager = new WindowsServiceManager();
    try {
      delete process.env.BS9_WINDOWS_BACKGROUND;
      const baseline = hasWindowsAdminPrivileges();
      process.env.BS9_WINDOWS_BACKGROUND = "1";
      expect(hasWindowsAdminPrivileges()).toBe(baseline);
      expect(manager.checkAdminPrivileges()).toBe(baseline);
    } finally {
      if (original === undefined) delete process.env.BS9_WINDOWS_BACKGROUND;
      else process.env.BS9_WINDOWS_BACKGROUND = original;
    }
  });

  it("sends elevated PowerShell scripts over stdin instead of profile-backed -File paths", () => {
    const script = "$ErrorActionPreference = 'Stop'\nWrite-Output 'setup'";
    let invocation: any;
    const fakeSpawn = ((command: string, args: string[], options: any) => {
      invocation = { command, args, options };
      return { status: 0, error: undefined };
    }) as any;

    expect(runWindowsPowerShell(script, fakeSpawn, { SystemRoot: "C:\\Users\\alice\\fake-windows" }).status).toBe(0);
    expect(invocation.command).toBe(getWindowsPowerShellExecutable());
    expect(invocation.args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    expect(invocation.options.input).toBe(script);
    expect(invocation.options.stdio).toEqual(["pipe", "inherit", "inherit"]);
  });

  it("requires explicit digest and account approval and refuses LocalSystem restore from backups", () => {
    const backupBytes = Buffer.from(JSON.stringify({
      name: "BS9_Api",
      scriptFile: "C:\\Users\\alice\\api.js",
      executable: "C:\\Program Files\\Bun\\bun.exe",
      arguments: ["run", "C:\\Users\\alice\\api.js"],
      environment: { PORT: "3000" },
    }));
    const plan = createWindowsRestorePlan("BS9_Api", backupBytes);

    expect(plan.targetFile).toBe("C:\\Users\\alice\\api.js");
    expect(validateWindowsRestoreApproval(plan, "LocalService", plan.backupSha256))
      .toBe("LocalService");
    expect(() => validateWindowsRestoreApproval(plan, undefined, plan.backupSha256))
      .toThrow(/Choose --windows-service-account LocalService/);
    expect(() => validateWindowsRestoreApproval(plan, "LocalService", "0".repeat(64)))
      .toThrow(/confirmation does not match/);
    expect(() => validateWindowsRestoreApproval(plan, "LocalSystem", plan.backupSha256))
      .toThrow(/LocalSystem restore from a profile backup is disabled/);
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
    const expectedProgramData = getWindowsProgramDataDirectory();
    process.env.ProgramData = "C:\\Users\\alice\\attacker-controlled";
    try {
      const manager = new WindowsServiceManager();
      const config = {
        name: "BS9_Api",
        displayName: "API's Windows Service",
        description: "Production API service",
        executable: "C:\\Users\\app\\.bun\\bin\\bun.exe",
        arguments: ["run", "C:\\apps\\api server\\main.ts"],
        workingDirectory: "C:\\apps\\api server",
        environment: { JWT_SECRET: "do-not-copy-this-secret" },
      };
      const nativePaths = (manager as any).getNativeServicePaths("BS9_Api");
      const script = manager.generateServiceScript(config, "create", nativePaths);
      const directoryAclScript = (manager as any).generateDirectoryAclScript(nativePaths, "BS9_Api", false);
      const runtimeAclScript = (manager as any).generateRuntimeAclScript(nativePaths.runtimeDir);
      const encodedSource = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
      const hostSource = encodedSource ? Buffer.from(encodedSource, "base64").toString("utf-8") : "";

      expect(script).toContain("Add-Type -TypeDefinition $source -OutputAssembly $hostPath -OutputType ConsoleApplication");
      expect(script).toContain("System.ServiceProcess");
      expect(script).toContain("sc.exe failure");
      expect(script).toContain("'NT AUTHORITY\\LocalService'");
      expect(script).toContain("'NT SERVICE\\BS9_Api'");
      expect(script).toContain("@('sidtype', $serviceName, 'unrestricted')");
      expect(script).toContain("$serviceRule = [System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid, [System.Security.AccessControl.FileSystemRights]::Modify");
      expect(script).toContain(`${expectedProgramData}\\BS9\\services\\BS9_Api`);
      expect(script).toContain(`$hostPath = '${nativePaths.hostPath}'`);
      expect(script).toContain("$existingHost = Get-Item -LiteralPath $hostPath -Force");
      expect(script).toContain("Remove-Item -LiteralPath $hostPath -Force");
      expect(script).toContain("$hostAcl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))");
      expect(script).toContain("$hostReadRule = [System.Security.AccessControl.FileSystemAccessRule]::new($localService, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute");
      expect(script).not.toContain("C:\\Users\\alice\\attacker-controlled");
      expect(directoryAclScript).toContain("ProgramData path does not match the Windows known-folder API");
      expect(directoryAclScript).toContain("Refusing reparse point in protected service path");
      expect(directoryAclScript).toContain("$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))");
      expect(runtimeAclScript).toContain("Refusing reparse point in staged runtime");
      expect(runtimeAclScript).toContain("$acl.SetOwner($adminSid)");
      expect(runtimeAclScript).toContain("[System.Security.AccessControl.FileSystemRights]::ReadAndExecute");
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
    expect(migrationScript).toContain("$scExe = [System.IO.Path]::Combine([Environment]::SystemDirectory, 'sc.exe')");
    expect(migrationScript.indexOf("& $scExe @sidTypeArgs")).toBeLessThan(migrationScript.indexOf("& $scExe @serviceArgs"));
    expect(migrationScript.indexOf("Set-Acl -LiteralPath $serviceDir")).toBeLessThan(migrationScript.indexOf("& $scExe @serviceArgs"));
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

  it("does not read or launch profile watchdog metadata from an elevated start without an SCM service", async () => {
    const manager = new WindowsServiceManager();
    let metadataRead = false;
    let watchdogStarted = false;
    Object.assign(manager as any, {
      checkAdminPrivileges: () => true,
      getNativeServiceAccount: () => undefined,
      getProcessMetadata: () => {
        metadataRead = true;
        return { name: "BS9_Tampered", backgroundOnly: true, executable: "C:\\Users\\alice\\evil.exe" };
      },
      startBackgroundProcess: async () => { watchdogStarted = true; },
    });

    await expect(manager.startService("BS9_Tampered")).rejects.toThrow(/will not launch profile metadata/);
    expect(metadataRead).toBe(false);
    expect(watchdogStarted).toBe(false);
  });

  it("does not fall back to profile metadata when an elevated SCM start fails", async () => {
    const manager = new WindowsServiceManager();
    let metadataRead = false;
    let watchdogStarted = false;
    Object.assign(manager as any, {
      checkAdminPrivileges: () => true,
      getNativeServiceAccount: () => "LocalService",
      startNativeService: () => ({ status: 1 }),
      getProcessMetadata: () => {
        metadataRead = true;
        return { name: "BS9_Tampered", backgroundOnly: true, executable: "C:\\Users\\alice\\evil.exe" };
      },
      startBackgroundProcess: async () => { watchdogStarted = true; },
    });

    await expect(manager.startService("BS9_Tampered")).rejects.toThrow(/will not fall back to profile metadata/);
    expect(metadataRead).toBe(false);
    expect(watchdogStarted).toBe(false);
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

  it("stages account changes in a distinct versioned runtime while retaining the registered runtime", () => {
    const manager = new WindowsServiceManager();
    const currentPaths = (manager as any).getNativeServicePaths("BS9_Migrating");
    const stagedPaths = (manager as any).getNativeServicePaths("BS9_Migrating");

    expect(currentPaths.serviceDir).toBe(stagedPaths.serviceDir);
    expect(currentPaths.runtimeDir).not.toBe(stagedPaths.runtimeDir);
    expect(currentPaths.runtimeDir).toMatch(/\\runtime-[0-9a-f-]{36}$/i);
    expect(stagedPaths.hostPath.startsWith(`${stagedPaths.runtimeDir}\\`)).toBe(true);
  });

  it("recognizes legacy and versioned BS9 runtimes for account migration", () => {
    const manager = new WindowsServiceManager();
    const paths = (manager as any).getNativeServicePaths("BS9_Migrating");
    const isManagedRuntimeExecutable = (path: string) =>
      (manager as any).isManagedRuntimeExecutable(path, paths);

    expect(isManagedRuntimeExecutable(`${paths.serviceDir}\\runtime\\bun.exe`)).toBe(true);
    expect(isManagedRuntimeExecutable(`${paths.runtimeDir}\\bun.exe`)).toBe(true);
    expect(isManagedRuntimeExecutable("C:\\Users\\alice\\custom-bun\\bun.exe")).toBe(false);
    expect(isManagedRuntimeExecutable("C:\\ProgramData\\BS9\\services\\OtherService\\runtime\\bun.exe")).toBe(false);
  });
});
