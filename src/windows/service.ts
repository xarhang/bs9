#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * https://github.com/xarhang/bs9
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, openSync, copyFileSync, cpSync, rmSync, renameSync } from "node:fs";
import { join, dirname, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { getPlatformInfo } from "../platform/detect.js";
import { recordCrash, resetCrash, sleep, startHealthyTimer, formatCrashState } from "../utils/crash-tracker.js";
import { withManifestLock } from "../utils/manifest-lock.js";

export function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

function writeFileAtomically(path: string, contents: string | Buffer): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents);
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export type WindowsServiceAccount = "LocalService" | "LocalSystem";

/** Keep Windows PowerShell 5.1 from loading same-named modules shipped for PowerShell 7. */
export function getWindowsPowerShellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const windowsRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  return {
    ...env,
    PSModulePath: [
      win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      win32.join(programFiles, "WindowsPowerShell", "Modules"),
    ].join(";"),
  };
}

interface NativeServicePaths {
  rootDir: string;
  servicesDir: string;
  serviceDir: string;
  hostPath: string;
  configPath: string;
  setupScriptPath: string;
  aclScriptPath: string;
  watchdogScript: string;
}

interface NativeServiceHostConfig {
  name: string;
  runtimeExecutable: string;
  watchdogScript: string;
  serviceDir: string;
  bs9Home: string;
  logPath: string;
}

const WINDOWS_SERVICE_HOST_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.ServiceProcess;

public sealed class Bs9ServiceHostConfig {
    public string name { get; set; }
    public string runtimeExecutable { get; set; }
    public string watchdogScript { get; set; }
    public string serviceDir { get; set; }
    public string bs9Home { get; set; }
    public string logPath { get; set; }
}

public sealed class Bs9ServiceHost : ServiceBase {
    private readonly string configPath;
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private Bs9ServiceHostConfig config;
    private Process watchdog;
    private bool stopping;
    private string metadataPath;

    public Bs9ServiceHost(string path) {
        configPath = path;
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }

    public static void Main(string[] args) {
        if (args == null || args.Length != 1) Environment.Exit(64);
        ServiceBase.Run(new Bs9ServiceHost(args[0]));
    }

    protected override void OnStart(string[] args) {
        try {
            config = serializer.Deserialize<Bs9ServiceHostConfig>(File.ReadAllText(configPath, Encoding.UTF8));
            if (config == null || String.IsNullOrWhiteSpace(config.name) ||
                String.IsNullOrWhiteSpace(config.runtimeExecutable) ||
                String.IsNullOrWhiteSpace(config.watchdogScript) ||
                String.IsNullOrWhiteSpace(config.serviceDir)) {
                throw new InvalidDataException("Incomplete BS9 service host configuration");
            }
            metadataPath = Path.Combine(config.serviceDir, config.name + ".json");
            SetMetadataState("starting");
            string workingDirectory = config.serviceDir;
            Dictionary<string, object> metadata = ReadMetadata();
            object workingDirValue;
            if (metadata != null && metadata.TryGetValue("workingDir", out workingDirValue) &&
                workingDirValue is string && !String.IsNullOrWhiteSpace((string)workingDirValue)) {
                if (!Directory.Exists((string)workingDirValue)) {
                    throw new DirectoryNotFoundException("Configured working directory is missing or unavailable to the service identity: " + (string)workingDirValue);
                }
                workingDirectory = (string)workingDirValue;
            }
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = config.runtimeExecutable;
            start.Arguments = JoinArguments(new string[] { "run", config.watchdogScript, config.name, config.serviceDir });
            start.WorkingDirectory = workingDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["BS9_HOME"] = config.bs9Home;
            start.EnvironmentVariables["BS9_SERVICES_DIR"] = config.serviceDir;
            watchdog = new Process();
            watchdog.StartInfo = start;
            watchdog.EnableRaisingEvents = true;
            watchdog.Exited += WatchdogExited;
            if (!watchdog.Start()) throw new InvalidOperationException("Could not start the BS9 watchdog process");
            Log("Watchdog started (PID " + watchdog.Id + ")");
        } catch (Exception error) {
            ExitCode = 1;
            Log("Service startup failed: " + error);
            throw;
        }
    }

    protected override void OnStop() {
        stopping = true;
        int appPid = ReadMetadataPid("pid");
        string appStartTime = ReadMetadataValue("startTime");
        try { SetMetadataState("stopped"); }
        catch (Exception error) { Log("Could not update stop state: " + error.Message); }
        Exception stopFailure = null;
        bool watchdogTreeTerminationRequested = false;
        if (watchdog != null) {
            try {
                if (!watchdog.WaitForExit(3000)) {
                    watchdogTreeTerminationRequested = true;
                    KillTree(watchdog.Id);
                    if (!watchdog.WaitForExit(5000)) {
                        throw new System.TimeoutException("Watchdog process remained active after taskkill completed");
                    }
                }
            } catch (Exception error) {
                Log("Could not stop watchdog process tree: " + error.Message);
                stopFailure = error;
            }
        }
        try {
            if (appPid > 0 && IsExpectedProcessRunning(appPid, appStartTime)) {
                string reason = watchdogTreeTerminationRequested
                    ? "Managed application remains active after taskkill of the watchdog process tree"
                    : "Watchdog has exited while the managed application remains active; refusing PID-only termination";
                throw new System.TimeoutException(reason);
            }
        } catch (Exception error) {
            Log("Could not stop managed application process: " + error.Message);
            stopFailure = stopFailure == null ? error : new AggregateException(stopFailure, error);
        } finally {
            if (watchdog != null) watchdog.Dispose();
        }
        if (stopFailure != null) {
            try { SetMetadataState("running"); }
            catch (Exception restoreError) { Log("Could not restore running state after failed stop: " + restoreError.Message); }
            ExitCode = 1;
            throw new InvalidOperationException("BS9 could not confirm that the watchdog and managed application stopped", stopFailure);
        }
        Log("Service stopped");
    }

    protected override void OnShutdown() { OnStop(); }

    private void WatchdogExited(object sender, EventArgs e) {
        if (stopping) return;
        string state = "";
        try {
            Dictionary<string, object> metadata = ReadMetadata();
            object value;
            if (metadata != null && metadata.TryGetValue("status", out value)) state = Convert.ToString(value);
        } catch { }
        Log("Watchdog exited unexpectedly with state '" + state + "'");
        // Explicit stops and the watchdog crash-loop circuit breaker are terminal
        // states. Other exits are process failures and trigger SCM recovery.
        if (state == "stopped" || state == "crash-loop") Environment.Exit(0);
        Environment.Exit(1);
    }

    private Dictionary<string, object> ReadMetadata() {
        if (String.IsNullOrEmpty(metadataPath) || !File.Exists(metadataPath)) return null;
        return serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(metadataPath, Encoding.UTF8));
    }

    private int ReadMetadataPid(string key) {
        try {
            Dictionary<string, object> metadata = ReadMetadata();
            object value;
            return metadata != null && metadata.TryGetValue(key, out value) && value != null
                ? Convert.ToInt32(value)
                : 0;
        } catch { return 0; }
    }

    private string ReadMetadataValue(string key) {
        try {
            Dictionary<string, object> metadata = ReadMetadata();
            object value;
            return metadata != null && metadata.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value)
                : null;
        } catch { return null; }
    }

    private static bool IsExpectedProcessRunning(int pid, string expectedStartTime) {
        if (pid <= 0 || String.IsNullOrWhiteSpace(expectedStartTime)) return false;
        try {
            using (Process process = Process.GetProcessById(pid)) {
                if (process.HasExited) return false;
                DateTime expected = DateTime.Parse(expectedStartTime).ToUniversalTime();
                DateTime actual = process.StartTime.ToUniversalTime();
                return Math.Abs((actual - expected).TotalSeconds) <= 5;
            }
        } catch (ArgumentException) {
            return false;
        }
    }

    private void SetMetadataState(string state) {
        Dictionary<string, object> metadata = ReadMetadata();
        if (metadata == null) throw new FileNotFoundException("BS9 runtime metadata was not found", metadataPath);
        metadata["status"] = state;
        if (state == "starting") {
            metadata["pid"] = null;
            metadata["watchdogPid"] = null;
            metadata["startTime"] = null;
        }
        string tempPath = metadataPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(tempPath, serializer.Serialize(metadata), new UTF8Encoding(false));
        if (File.Exists(metadataPath)) File.Replace(tempPath, metadataPath, null);
        else File.Move(tempPath, metadataPath);
    }

    private static void KillTree(int pid) {
        if (pid <= 0) return;
        Process killer = new Process();
        killer.StartInfo = new ProcessStartInfo("taskkill.exe", "/F /T /PID " + pid.ToString());
        killer.StartInfo.UseShellExecute = false;
        killer.StartInfo.CreateNoWindow = true;
        killer.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
        try {
            if (!killer.Start()) throw new InvalidOperationException("taskkill.exe did not start");
            if (!killer.WaitForExit(10000)) {
                try { killer.Kill(); } catch { }
                throw new System.TimeoutException("taskkill.exe did not finish within 10 seconds");
            }
            if (killer.ExitCode != 0) {
                throw new InvalidOperationException("taskkill.exe failed with exit code " + killer.ExitCode.ToString());
            }
        } finally { killer.Dispose(); }
    }

    private void Log(string message) {
        try {
            if (!String.IsNullOrEmpty(config == null ? null : config.logPath)) {
                File.AppendAllText(config.logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        } catch { }
    }

    private static string JoinArguments(string[] arguments) {
        StringBuilder result = new StringBuilder();
        foreach (string argument in arguments) {
            if (result.Length != 0) result.Append(' ');
            result.Append(QuoteArgument(argument));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string argument) {
        if (argument.Length != 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
`;

export function quoteWindowsCommandLineArgument(argument: string): string {
  if (argument.length > 0 && !/[\s\t\n\v"]/.test(argument)) return argument;
  let result = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes++;
    } else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function requiresNativeServiceIdentityFallback(
  configuredAccount?: string,
  reportedAccount?: string,
  legacyNativeAccount?: string,
): boolean {
  const canonical = (account: string) => {
    const normalized = account.trim().toLowerCase().replace(/^nt authority\\/, '');
    if (normalized === 'localservice') return 'LocalService';
    if (normalized === 'localsystem' || normalized === 'system') return 'LocalSystem';
    return normalized === 'unknown' ? 'unknown' : account.trim();
  };
  const configured = configuredAccount ? canonical(configuredAccount) : undefined;
  const reported = reportedAccount ? canonical(reportedAccount) : undefined;
  if (configured && reported && reported !== 'unknown' && configured !== reported) return true;
  return Boolean((reported && reported !== 'unknown') || configured || legacyNativeAccount);
}

interface WindowsServiceConfig {
  name: string;
  displayName: string;
  description: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  watch?: boolean;
  maxMemoryRestart?: string;
  restartDelay?: number;
  noAutorestart?: boolean;
  time?: boolean;
  scriptFile?: string;
  serviceAccount?: WindowsServiceAccount;
  backgroundOnly?: boolean;
  legacyNativeServiceAccount?: string;
}

interface WindowsServiceStatus {
  name: string;
  state: 'running' | 'stopped' | 'paused' | 'starting' | 'stopping';
  startType: 'auto' | 'demand' | 'disabled';
  processId?: number;
  startTime?: Date;
  description?: string;
  serviceAccount?: string;
  legacyNativeServiceAccount?: string;
  backgroundOnly?: boolean;
}

export class WindowsServiceManager {
  private configPath: string;
  private servicesDir: string;

  constructor() {
    const platformInfo = getPlatformInfo();
    this.configPath = join(platformInfo.configDir, 'windows-services.json');
    this.servicesDir = platformInfo.serviceDir;
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    if (!existsSync(dirname(this.configPath))) {
      mkdirSync(dirname(this.configPath), { recursive: true });
    }
    if (!existsSync(this.servicesDir)) {
      mkdirSync(this.servicesDir, { recursive: true });
    }
  }

  private loadConfigs(): Record<string, WindowsServiceConfig> {
    try {
      if (existsSync(this.configPath)) {
        return JSON.parse(readFileSync(this.configPath, 'utf-8'));
      }
    } catch (error) {
      console.warn('Failed to load Windows service configs:', error);
    }
    return {};
  }

  private saveConfigs(configs: Record<string, WindowsServiceConfig>): boolean {
    try {
      writeFileSync(this.configPath, JSON.stringify(configs, null, 2));
      return true;
    } catch (error) {
      console.error('Failed to save Windows service configs:', error);
      return false;
    }
  }

  public checkAdminPrivileges(): boolean {
    // Ephemeral environments can exercise the supported watchdog path without
    // registering machine-wide services in the Windows SCM.
    if (process.env.BS9_WINDOWS_BACKGROUND === '1') return false;
    try {
      execSync('net session', { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  async createService(config: WindowsServiceConfig, options: { forceBackground?: boolean } = {}): Promise<void> {
    if (!isValidServiceName(config.name)) {
      throw new Error(`Security: Invalid service name: ${config.name}`);
    }

    const serviceAccount = this.normalizeServiceAccount(config.serviceAccount);
    const isAdmin = !options.forceBackground && this.checkAdminPrivileges();
    const backgroundOnly = options.forceBackground || !isAdmin;
    if (isAdmin && !process.versions.bun) {
      throw new Error('Windows SCM services currently require BS9 to run under Bun so the watchdog can restart applications. Use the same-user watchdog path when running BS9 under Node.');
    }
    const existingNativeAccount = this.getNativeServiceAccount(config.name);
    if (existingNativeAccount && !options.forceBackground) {
      throw new Error(`Native Windows service '${config.name}' already exists and was left unchanged. Use 'bs9 windows account --name ${config.name} --service-account LocalService' to stage the BS9 service host and account migration, then restart it during a maintenance window.`);
    }
    if (!isAdmin && !options.forceBackground && config.serviceAccount) {
      throw new Error(`Creating '${config.name}' with service account ${config.serviceAccount} requires an elevated shell. Omit --windows-service-account to use the supported same-user watchdog path.`);
    }
    const legacyNativeServiceAccount = options.forceBackground
      ? existingNativeAccount
      : undefined;
    let normalizedConfig: WindowsServiceConfig = backgroundOnly
      ? {
          ...config,
          backgroundOnly: true,
          ...(legacyNativeServiceAccount ? { legacyNativeServiceAccount } : {}),
        }
      : { ...config, serviceAccount };

    const configs = this.loadConfigs();
    if (isAdmin && configs[config.name]) {
      throw new Error(`BS9 already has metadata for '${config.name}'. It was left unchanged. Stop and delete the existing BS9 registration before replacing it.`);
    }
    let nativePaths: NativeServicePaths | undefined;
    if (isAdmin) {
      nativePaths = this.getNativeServicePaths(config.name);
      this.secureNativeServiceDirectory(nativePaths, config.name);
      const stagedRuntime = this.stageNativeServiceRuntime(nativePaths);
      if (resolve(normalizedConfig.executable) === resolve(process.execPath)) {
        normalizedConfig = { ...normalizedConfig, executable: stagedRuntime.runtimeExecutable };
      }
      if (serviceAccount === 'LocalService') {
        normalizedConfig = this.stageLocalServiceToken(config.name, normalizedConfig, nativePaths);
      }
    }

    configs[config.name] = normalizedConfig;
    if (!this.saveConfigs(configs)) {
      throw new Error(`Failed to persist Windows service config for '${config.name}'`);
    }

    const metadata = {
      name: normalizedConfig.name,
      description: normalizedConfig.description,
      executable: normalizedConfig.executable,
      arguments: normalizedConfig.arguments,
      workingDir: normalizedConfig.workingDirectory,
      environment: normalizedConfig.environment,
      serviceAccount: normalizedConfig.serviceAccount,
      backgroundOnly: normalizedConfig.backgroundOnly,
      legacyNativeServiceAccount: normalizedConfig.legacyNativeServiceAccount,
      status: 'stopped',
      watch: normalizedConfig.watch,
      maxMemoryRestart: normalizedConfig.maxMemoryRestart,
      restartDelay: normalizedConfig.restartDelay,
      noAutorestart: normalizedConfig.noAutorestart,
      time: normalizedConfig.time,
      scriptFile: normalizedConfig.scriptFile
    };
    this.saveProcessMetadata(config.name, metadata);

    if (isAdmin && nativePaths) {
      const scriptPath = nativePaths.setupScriptPath;
      if (serviceAccount === "LocalSystem") {
        console.warn(`⚠️ Windows service '${config.name}' is configured as LocalSystem for compatibility. Use --service-account LocalService when the application supports the LocalService profile and ACLs.`);
      } else {
        console.warn(`ℹ️ BS9 stages its Bun runtime and watchdog under the protected service directory for NT AUTHORITY\\LocalService. Ensure application files, working directory, and any cluster IPC/token resources are accessible to that account.`);
      }
      try {
        this.writeNativeHostConfig(normalizedConfig, nativePaths);
        writeFileSync(scriptPath, this.generateServiceScript(normalizedConfig));
        const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
          stdio: 'inherit', windowsHide: true, env: getWindowsPowerShellEnvironment(),
        });
        if (res.error || res.status !== 0) throw new Error(`PowerShell service setup failed: ${res.error?.message || `exit code ${res.status}`}`);
        console.log(`✅ Windows service '${config.name}' created successfully`);
      } catch (error) {
        delete configs[config.name];
        this.saveConfigs(configs);
        const metadataPath = join(this.servicesDir, `${config.name}.json`);
        if (existsSync(metadataPath)) unlinkSync(metadataPath);
        for (const path of [
          join(nativePaths.serviceDir, `${config.name}.json`),
          nativePaths.configPath,
          nativePaths.hostPath,
          join(nativePaths.serviceDir, 'cluster-auth.token'),
          nativePaths.setupScriptPath,
        ]) {
          if (existsSync(path)) unlinkSync(path);
        }
        throw error;
      } finally {
        if (existsSync(scriptPath)) unlinkSync(scriptPath);
      }
    } else {
      // Background Process path
      if (legacyNativeServiceAccount) {
        console.warn(`[Security] Existing native service '${config.name}' remains registered as '${legacyNativeServiceAccount}'. BS9 is using the same-user watchdog for new daemon launches. After confirming it is unused, remove the legacy SCM registration with 'sc.exe stop ${config.name}' and 'sc.exe delete ${config.name}'.`);
      }
      console.log(options.forceBackground
        ? `ℹ️ Registering '${config.name}' as a same-user watchdog process...`
        : `ℹ️ Non-admin user detected. Registering '${config.name}' as a background process...`);
      console.log(`✅ Service '${config.name}' registered for background execution`);
    }
  }

  async startService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const metadata = this.getProcessMetadata(serviceName);
    if (metadata?.backgroundOnly && !metadata?.serviceAccount) {
      await this.startBackgroundProcess(metadata);
      return;
    }

    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      const res = spawnSync("net", ["start", serviceName], { stdio: 'inherit', windowsHide: true });
      if (res.status === 0) {
        const startedMetadata = this.getProcessMetadata(serviceName);
        const scmAccount = this.getNativeServiceAccount(serviceName);
        if (startedMetadata?.legacyNativeServiceAccount && startedMetadata.serviceAccount &&
            scmAccount && this.canonicalServiceAccount(scmAccount) === this.canonicalServiceAccount(startedMetadata.serviceAccount)) {
          delete startedMetadata.legacyNativeServiceAccount;
          this.saveProcessMetadata(serviceName, startedMetadata);
          const configs = this.loadConfigs();
          if (configs[serviceName]) {
            delete configs[serviceName].legacyNativeServiceAccount;
            this.saveConfigs(configs);
          }
        }
        console.log(`Windows service '${serviceName}' started successfully`);
      } else {
        // Native services must never be restarted under the caller's identity.
        const failedServiceMetadata = this.getProcessMetadata(serviceName);
        if (this.mustFailClosedFallback(serviceName, failedServiceMetadata)) {
          throw new Error(
            `Windows service '${serviceName}' failed to start under its configured SCM identity. BS9 will not fall back to launching it under the current user; inspect the SCM error and service-host log, then repair file access or service configuration before retrying.`
          );
        }
        if (failedServiceMetadata) await this.startBackgroundProcess(failedServiceMetadata);
        else throw new Error(`Failed to start service '${serviceName}'`);
      }
    } else {
      const metadata = this.getProcessMetadata(serviceName);
      if (!metadata) throw new Error(`Service '${serviceName}' not found or not registered for background execution`);
      if (this.mustFailClosedFallback(serviceName, metadata)) {
        throw new Error(
          `Windows service '${serviceName}' is configured for a native SCM identity and must be started through the elevated Windows Service Control Manager; BS9 will not run it under the current user.`
        );
      }
      await this.startBackgroundProcess(metadata);
    }
  }

  private mustFailClosedFallback(serviceName: string, metadata: WindowsServiceConfig | null): boolean {
    const configuredAccount = metadata?.serviceAccount
      ? this.canonicalServiceAccount(metadata.serviceAccount)
      : undefined;
    const reportedAccount = this.getNativeServiceAccount(serviceName);
    const scmAccount = reportedAccount && this.canonicalServiceAccount(reportedAccount) !== "unknown"
      ? this.canonicalServiceAccount(reportedAccount)
      : undefined;

    // SCM is authoritative when it can be queried. If external changes or a
    // partial account migration make disk metadata disagree, do not guess which
    // identity to use for a watchdog fallback.
    if (configuredAccount && scmAccount && configuredAccount !== scmAccount) return true;
    return requiresNativeServiceIdentityFallback(
      configuredAccount,
      scmAccount,
      metadata?.legacyNativeServiceAccount,
    );
  }

  async stopService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      const res = spawnSync("net", ["stop", serviceName], { stdio: 'inherit', windowsHide: true });
      if (res.status !== 0) {
        const metadata = this.getProcessMetadata(serviceName);
        if (this.isNativeServiceStopped(serviceName)) return;
        if (this.mustFailClosedFallback(serviceName, metadata)) {
          throw new Error(`Failed to stop native Windows service '${serviceName}' through SCM. BS9 will not kill processes through the caller identity.`);
        }
        if (metadata && (metadata.pid || metadata.watchdogPid)) {
          await this.stopBackgroundProcess(metadata);
        } else {
          throw new Error(`Failed to stop Windows service '${serviceName}'`);
        }
      }
    } else {
      const metadata = this.getProcessMetadata(serviceName);
      const nativeServiceAccount = this.getNativeServiceAccount(serviceName);
      if (nativeServiceAccount || metadata?.serviceAccount) {
        throw new Error(`Stopping native Windows service '${serviceName}' requires an elevated administrator shell. No service process or metadata was changed.`);
      }
      if (metadata && (metadata.pid || metadata.watchdogPid)) {
        await this.stopBackgroundProcess(metadata);
      }
    }
  }

  async deleteService(serviceName: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }

    const isAdmin = this.checkAdminPrivileges();
    const nativeServiceAccount = this.getNativeServiceAccount(serviceName);
    const metadata = this.getProcessMetadata(serviceName);
    const nativeMetadata = Boolean(metadata?.serviceAccount && !metadata?.backgroundOnly);
    if ((nativeServiceAccount || nativeMetadata) && !isAdmin) {
      throw new Error(`Deleting native Windows service '${serviceName}' requires an elevated administrator shell. No service process or metadata was changed.`);
    }
    if (nativeServiceAccount || metadata) {
      await this.stopService(serviceName);
    }

    if (nativeServiceAccount) {
      if (!this.isNativeServiceStopped(serviceName)) {
        throw new Error(`Native Windows service '${serviceName}' is still running; preserving BS9 metadata so it can be stopped safely.`);
      }
      const result = spawnSync("sc.exe", ["delete", serviceName], { encoding: 'utf-8', windowsHide: true });
      if ((result.error || result.status !== 0) && this.getNativeServiceAccount(serviceName)) {
        throw new Error(`Failed to delete native Windows service '${serviceName}': ${result.stderr || result.stdout || `exit code ${result.status}`}`);
      }
      if (this.getNativeServiceAccount(serviceName)) {
        throw new Error(`Windows SCM still reports service '${serviceName}' after deletion was requested; preserving BS9 metadata. Wait for pending service handles to close, then retry.`);
      }
    }

    // Remove metadata and config
    const configs = this.loadConfigs();
    delete configs[serviceName];
    const cleanName = serviceName.replace(/^BS9_/, '');
    delete configs[cleanName];
    this.saveConfigs(configs);

    const metaPath = join(this.servicesDir, `${serviceName}.json`);
    if (existsSync(metaPath)) unlinkSync(metaPath);

    const cleanMetaPath = join(this.servicesDir, `${cleanName}.json`);
    if (existsSync(cleanMetaPath)) unlinkSync(cleanMetaPath);

    if (isAdmin && metadata?.serviceAccount) {
      const runtimeDir = this.getNativeServicePaths(serviceName).serviceDir;
      if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }

    console.log(`✅ Service '${serviceName}' deleted successfully`);
  }

  async getServiceStatus(serviceName: string): Promise<WindowsServiceStatus | null> {
    if (!isValidServiceName(serviceName)) {
      return null;
    }

    const metadata = this.getProcessMetadata(serviceName);
    const queriedNativeServiceAccount = this.getNativeServiceAccount(serviceName);
    const nativeServiceAccount = queriedNativeServiceAccount || metadata?.serviceAccount;
    const legacyNativeServiceAccount = metadata?.legacyNativeServiceAccount ||
      (!metadata?.serviceAccount ||
        (queriedNativeServiceAccount &&
          this.canonicalServiceAccount(queriedNativeServiceAccount) !== this.canonicalServiceAccount(metadata.serviceAccount))
        ? queriedNativeServiceAccount || nativeServiceAccount
        : undefined);
    const isAdmin = this.checkAdminPrivileges();

    if (isAdmin) {
      try {
        const res = spawnSync("sc.exe", ["query", serviceName], { encoding: 'utf-8', windowsHide: true });
        const output = res.stdout || '';
        if (res.status === 0 && output.includes('RUNNING')) {
          return {
            name: serviceName,
            state: 'running',
            startType: 'demand',
            serviceAccount: nativeServiceAccount,
            legacyNativeServiceAccount,
            backgroundOnly: metadata?.backgroundOnly,
          };
        }
      } catch { }
    }

    // Check background process metadata
    if (metadata && metadata.pid) {
      try {
        const res = spawnSync("tasklist", ["/FI", `PID eq ${metadata.pid}`, "/NH"], { encoding: 'utf-8', windowsHide: true });
        if (res.status === 0 && (res.stdout || '').includes(String(metadata.pid))) {
          return {
            name: serviceName,
            state: 'running',
            startType: 'demand',
            processId: metadata.pid,
            serviceAccount: nativeServiceAccount,
            legacyNativeServiceAccount,
            backgroundOnly: metadata.backgroundOnly,
          };
        }
      } catch { }
    }

    return metadata ? {
      name: serviceName,
      state: 'stopped',
      startType: 'demand',
      serviceAccount: nativeServiceAccount,
      legacyNativeServiceAccount,
      backgroundOnly: metadata.backgroundOnly,
    } : null;
  }

  async listServices(): Promise<WindowsServiceStatus[]> {
    const services: WindowsServiceStatus[] = [];
    const configs = this.loadConfigs();

    for (const name of Object.keys(configs)) {
      const status = await this.getServiceStatus(name);
      if (status) {
        status.description = configs[name].description;
        status.serviceAccount = status.serviceAccount || configs[name].serviceAccount;
        status.legacyNativeServiceAccount = status.legacyNativeServiceAccount || configs[name].legacyNativeServiceAccount;
        status.backgroundOnly = status.backgroundOnly || configs[name].backgroundOnly;
        services.push(status);
      }
    }

    return services;
  }

  private async startBackgroundProcess(metadata: any): Promise<void> {
    console.log(`Starting background process for '${metadata.name}'...`);

    const platformInfo = getPlatformInfo();
    const logsDir = platformInfo.logDir;
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    // Path to dedicated detached watchdog agent
    const watchdogScript = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.js');
    const watchdogTs = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.ts');
    const agentFile = existsSync(watchdogTs) ? watchdogTs : watchdogScript;

    // Make sure status is set so watchdog starts immediately
    metadata.status = 'starting';
    this.saveProcessMetadata(metadata.name, metadata);

    const watchdogOut = openSync(join(logsDir, `${metadata.name}.watchdog.log`), 'a');

    // Spawn detached watchdog agent that persists even after CLI exits
    const watchdog = spawn(process.execPath, ['run', agentFile, metadata.name, this.servicesDir], {
      cwd: metadata.workingDir || process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', watchdogOut, watchdogOut],
      env: {
        ...process.env,
        ...(process.env.BS9_HOME ? { BS9_HOME: process.env.BS9_HOME } : {}),
        BS9_SERVICES_DIR: this.servicesDir,
      },
    });

    watchdog.unref();

    metadata.watchdogPid = watchdog.pid;
    this.saveProcessMetadata(metadata.name, metadata);

    // Wait up to 3 seconds for child process to be spawned and record PID
    let attempts = 0;
    while (attempts < 30) {
      await sleep(100);
      const fresh = this.getProcessMetadata(metadata.name);
      if (fresh && fresh.pid) {
        metadata.pid = fresh.pid;
        metadata.status = 'running';
        break;
      }
      attempts++;
    }

    console.log(`✅ Started background service '${metadata.name}' (PID: ${metadata.pid || 'running'}, Watchdog: ${watchdog.pid})`);
  }

  private async stopBackgroundProcess(metadata: any): Promise<void> {
    console.log(`Stopping background process for '${metadata.name}'...`);

    // Signal status stopped so watchdog stops looping
    metadata.status = 'stopped';
    this.saveProcessMetadata(metadata.name, metadata);

    // Kill child application process
    if (metadata.pid) {
      await this.terminateBackgroundPid(metadata.pid, 'application');
      metadata.pid = null;
      this.saveProcessMetadata(metadata.name, metadata);
    }

    // Kill watchdog supervisor process
    if (metadata.watchdogPid) {
      await this.terminateBackgroundPid(metadata.watchdogPid, 'watchdog');
      metadata.watchdogPid = null;
    }

    metadata.startTime = null;
    this.saveProcessMetadata(metadata.name, metadata);
    console.log(`✅ Service '${metadata.name}' stopped`);
  }

  private async terminateBackgroundPid(pidValue: number, label: string): Promise<void> {
    const pid = Number(pidValue);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Refusing to stop ${label} process with invalid PID '${pidValue}'`);
    }
    try { process.kill(pid); } catch { /* Verify below; it may already have exited. */ }
    const query = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8', windowsHide: true });
    if (query.error || query.status !== 0) {
      throw new Error(`Could not verify whether ${label} process ${pid} stopped: ${query.error?.message || query.stderr || `exit code ${query.status}`}`);
    }
    const isRunning = () => (query.stdout || '').split(/\r?\n/).some((line) => new RegExp(`\\s${pid}\\s`).test(line));
    if (isRunning()) {
      const termination = spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf-8', windowsHide: true });
      const confirm = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8', windowsHide: true });
      if (confirm.error || confirm.status !== 0 || (confirm.stdout || '').split(/\r?\n/).some((line) => new RegExp(`\\s${pid}\\s`).test(line))) {
        throw new Error(`Could not stop ${label} process ${pid}: ${termination.error?.message || termination.stderr || termination.stdout || `exit code ${termination.status}`}`);
      }
    }
  }

  private saveProcessMetadata(name: string, data: any): void {
    writeFileSync(join(this.servicesDir, `${name}.json`), JSON.stringify(data, null, 2));
    if (data.serviceAccount && !data.backgroundOnly && process.platform === 'win32') {
      const paths = this.getNativeServicePaths(name);
      if (existsSync(paths.serviceDir)) {
        writeFileSync(join(paths.serviceDir, `${name}.json`), JSON.stringify(data, null, 2));
      }
    }
  }

  private getNativeServicePaths(name: string): NativeServicePaths {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const rootDir = win32.join(programData, 'BS9');
    const servicesDir = win32.join(rootDir, 'services');
    const serviceDir = win32.join(servicesDir, name);
    const platformInfo = getPlatformInfo();
    const watchdogTs = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.ts');
    const watchdogJs = join(dirname(import.meta.path), '..', 'utils', 'watchdog-agent.js');
    const watchdogScript = existsSync(watchdogTs) ? watchdogTs : watchdogJs;
    if (!existsSync(watchdogScript)) {
      throw new Error(`Cannot locate the BS9 watchdog runtime (${watchdogTs} or ${watchdogJs})`);
    }
    const hostVersion = createHash('sha256').update(WINDOWS_SERVICE_HOST_SOURCE).digest('hex').slice(0, 12);
    return {
      rootDir,
      servicesDir,
      serviceDir,
      hostPath: win32.join(serviceDir, `bs9-service-host-${hostVersion}.exe`),
      configPath: win32.join(serviceDir, 'service-host.json'),
      setupScriptPath: join(platformInfo.configDir, `${name}-setup.ps1`),
      aclScriptPath: join(platformInfo.configDir, `${name}-acl.ps1`),
      watchdogScript,
    };
  }

  private secureNativeServiceDirectory(paths: NativeServicePaths, serviceName: string): void {
    const serviceExists = Boolean(this.getNativeServiceAccount(serviceName));
    const script = this.generateDirectoryAclScript(paths, serviceName, serviceExists);
    writeFileSync(paths.aclScriptPath, script, 'utf-8');
    try {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.aclScriptPath,
      ], { encoding: 'utf-8', windowsHide: true, env: getWindowsPowerShellEnvironment() });
      if (result.error || result.status !== 0) {
        throw new Error(`Could not secure native service runtime storage: ${result.error?.message || result.stderr || result.stdout || `exit code ${result.status}`}`);
      }
    } finally {
      if (existsSync(paths.aclScriptPath)) unlinkSync(paths.aclScriptPath);
    }
  }

  private generateDirectoryAclScript(paths: NativeServicePaths, serviceName: string, serviceExists: boolean): string {
    const rootDir = quotePowerShellLiteral(paths.rootDir);
    const servicesDir = quotePowerShellLiteral(paths.servicesDir);
    const serviceDir = quotePowerShellLiteral(paths.serviceDir);
    const serviceSidAccount = quotePowerShellLiteral(`NT SERVICE\\${serviceName}`);
    const existingServiceSidAcl = serviceExists
      ? `\n$serviceAcl = Get-Acl -LiteralPath $serviceDir\n$serviceIdentity = New-Object System.Security.Principal.NTAccount(${serviceSidAccount})\n$serviceSid = $serviceIdentity.Translate([System.Security.Principal.SecurityIdentifier])\n$serviceRule = [System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid, [System.Security.AccessControl.FileSystemRights]::Modify, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)\n[void]$serviceAcl.AddAccessRule($serviceRule)\nSet-Acl -LiteralPath $serviceDir -AclObject $serviceAcl\n`
      : '';
    return `$ErrorActionPreference = 'Stop'\n$rootDir = ${rootDir}\n$servicesDir = ${servicesDir}\n$serviceDir = ${serviceDir}\n$parentPaths = @($rootDir, $servicesDir)\nforeach ($path in @($parentPaths + $serviceDir)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }\n$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit\nfunction Set-Bs9BaseAcl([string]$path, [bool]$allowLocalServiceTraverse) {\n  $acl = Get-Acl -LiteralPath $path\n  $acl.SetAccessRuleProtection($true, $false)\n  foreach ($oldRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($oldRule) }\n  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {\n    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)\n    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)\n    [void]$acl.AddAccessRule($rule)\n  }\n  if ($allowLocalServiceTraverse) {\n    $identity = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19')\n    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::Traverse, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)\n    [void]$acl.AddAccessRule($rule)\n  }\n  Set-Acl -LiteralPath $path -AclObject $acl\n}\nSet-Bs9BaseAcl $rootDir $true\nSet-Bs9BaseAcl $servicesDir $true\nSet-Bs9BaseAcl $serviceDir $false${existingServiceSidAcl}`;
  }

  private writeNativeHostConfig(config: WindowsServiceConfig, paths: NativeServicePaths): void {
    if (!process.versions.bun) {
      throw new Error('Windows SCM services currently require BS9 to run under Bun so the watchdog can restart applications. Use the same-user watchdog path when running BS9 under Node.');
    }
    const hostConfig: NativeServiceHostConfig = {
      name: config.name,
      runtimeExecutable: join(paths.serviceDir, 'runtime', 'bun.exe'),
      watchdogScript: join(paths.serviceDir, 'runtime', 'src', 'utils', paths.watchdogScript.endsWith('.ts') ? 'watchdog-agent.ts' : 'watchdog-agent.js'),
      serviceDir: paths.serviceDir,
      // Native services must not share a writable BS9_HOME across the common
      // LocalService logon SID. Keep service state and credentials isolated.
      bs9Home: paths.serviceDir,
      logPath: join(paths.serviceDir, 'service-host.log'),
    };
    writeFileSync(paths.configPath, JSON.stringify(hostConfig, null, 2), 'utf-8');
  }

  private stageNativeServiceRuntime(paths: NativeServicePaths): { runtimeExecutable: string; watchdogScript: string } {
    // SCM services commonly run as LocalService, which cannot traverse a
    // developer's per-user Bun install. Keep the interpreter and the watchdog
    // module tree beside the service host under the protected ProgramData tree.
    const runtimeDir = join(paths.serviceDir, 'runtime');
    const runtimeExecutable = join(runtimeDir, 'bun.exe');
    const sourceRoot = join(dirname(paths.watchdogScript), '..');
    const stagedSourceRoot = join(runtimeDir, 'src');
    if (!existsSync(process.execPath)) {
      throw new Error(`Cannot stage Windows service runtime: Bun executable '${process.execPath}' is missing`);
    }
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync(process.execPath, runtimeExecutable);
    cpSync(sourceRoot, stagedSourceRoot, { recursive: true, force: true });
    const watchdogScript = join(stagedSourceRoot, 'utils', paths.watchdogScript.endsWith('.ts') ? 'watchdog-agent.ts' : 'watchdog-agent.js');
    if (!existsSync(watchdogScript)) {
      throw new Error(`Cannot stage Windows service watchdog: '${watchdogScript}' is missing`);
    }
    return { runtimeExecutable, watchdogScript };
  }

  private stageLocalServiceToken(name: string, config: WindowsServiceConfig, paths: NativeServicePaths): WindowsServiceConfig {
    const tokenPath = config.environment?.BS9_AUTH_TOKEN_FILE;
    if (!tokenPath) return config;
    if (!existsSync(tokenPath)) {
      throw new Error(`Cluster token file '${tokenPath}' is missing; refusing to create LocalService worker '${name}' without its authentication token`);
    }
    const stagedTokenPath = join(paths.serviceDir, 'cluster-auth.token');
    if (resolve(tokenPath) !== resolve(stagedTokenPath)) {
      copyFileSync(tokenPath, stagedTokenPath);
    }
    return {
      ...config,
      environment: { ...config.environment, BS9_AUTH_TOKEN_FILE: stagedTokenPath },
    };
  }

  private normalizeServiceAccount(value?: string): WindowsServiceAccount {
    const account = value || "LocalService";
    if (account !== "LocalService" && account !== "LocalSystem") {
      throw new Error(`Invalid Windows service account '${account}'. Use LocalService or LocalSystem.`);
    }
    return account;
  }

  private getNativeServiceAccount(serviceName: string): string | undefined {
    const result = spawnSync("sc.exe", ["qc", serviceName], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    const reportedAccount = /SERVICE_START_NAME\s*:\s*(.+)/i.exec(result.stdout || "")?.[1]?.trim();
    return reportedAccount ? this.canonicalServiceAccount(reportedAccount) : "unknown";
  }

  private isNativeServiceStopped(serviceName: string): boolean {
    const result = spawnSync('sc.exe', ['query', serviceName], { encoding: 'utf-8', windowsHide: true });
    return result.status === 0 && /STATE\s*:\s*1\b/i.test(result.stdout || '');
  }

  private canonicalServiceAccount(account: string): string {
    const normalized = account.trim().toLowerCase().replace(/^nt authority\\/, "");
    if (normalized === "localservice") return "LocalService";
    if (normalized === "localsystem" || normalized === "system") return "LocalSystem";
    return account.trim();
  }

  public async configureServiceAccount(serviceName: string, value: string): Promise<void> {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }
    const clusterMatch = /^BS9_(.+)-\d+-g\d+$/.exec(serviceName);
    if (!clusterMatch) {
      this.configureServiceAccountTransaction(serviceName, value);
      return;
    }

    const clusterName = clusterMatch[1];
    const manifestPath = join(getPlatformInfo().clusterDir, `${clusterName}.manifest.json`);
    const { ControllerAdminClient, ClusterLockSession } = await import("../cluster/admin-client.js");
    const adminClient = new ControllerAdminClient();
    if (!await adminClient.connect(1000)) {
      adminClient.disconnect();
      throw new Error(`Cannot safely change the account for cluster service '${serviceName}' while the BS9 daemon is unavailable. Start the daemon and retry so cluster mutations can be serialized.`);
    }
    let lockSession: InstanceType<typeof ClusterLockSession> | null = null;
    try {
      const lock = await adminClient.lockCluster(clusterName, "manual", 300_000, `windows-service-account:${serviceName}`);
      if (!lock.locked || !lock.lockToken) {
        throw new Error(`Cannot change the account for '${serviceName}' while cluster '${clusterName}' is locked for '${lock.reason || "another operation"}' by ${lock.currentOwner || "another operation"}`);
      }
      lockSession = new ClusterLockSession(adminClient, clusterName, lock.lockToken, {
        renewIntervalMs: 60_000,
        extendMs: 300_000,
        onLost: (error: Error) => console.error(`[ClusterLock] ${error.message}`),
      });
      lockSession.start();
      await lockSession.assertActive();
      mkdirSync(dirname(manifestPath), { recursive: true });
      withManifestLock(manifestPath, () => this.configureServiceAccountTransaction(serviceName, value));
      await lockSession.assertActive();
    } finally {
      try {
        if (lockSession) await lockSession.release();
      } finally {
        adminClient.disconnect();
      }
    }
  }

  private configureServiceAccountTransaction(serviceName: string, value: string): void {
    if (!isValidServiceName(serviceName)) {
      throw new Error(`Security: Invalid service name: ${serviceName}`);
    }
    if (!value) {
      throw new Error("--service-account is required for the account action");
    }
    const serviceAccount = this.normalizeServiceAccount(value);
    if (!this.checkAdminPrivileges()) {
      throw new Error("Changing a native Windows service account requires an elevated administrator shell");
    }

    if (!process.versions.bun) {
      throw new Error('Windows service account migration requires BS9 to run under Bun so it can install the watchdog host');
    }
    const oldNativeAccount = this.getNativeServiceAccount(serviceName);
    if (!oldNativeAccount || oldNativeAccount === 'unknown') {
      throw new Error(`Native Windows service '${serviceName}' was not found; no configuration was changed`);
    }
    const oldMetadata = this.getProcessMetadata(serviceName);
    if (!oldMetadata) {
      throw new Error(`BS9 metadata for '${serviceName}' was not found; refusing to replace an unverified service image path`);
    }
    if (!this.isNativeServiceStopped(serviceName)) {
      throw new Error(`Native Windows service '${serviceName}' must be stopped before changing its account. No configuration was changed.`);
    }
    const configs = this.loadConfigs();
    const previousConfig = configs[serviceName];
    const config: WindowsServiceConfig = previousConfig || {
      name: serviceName,
      displayName: oldMetadata.displayName || oldMetadata.description || serviceName,
      description: oldMetadata.description || `BS9 Service: ${serviceName}`,
      executable: oldMetadata.executable,
      arguments: oldMetadata.arguments || [],
      workingDirectory: oldMetadata.workingDirectory || oldMetadata.workingDir || process.cwd(),
      environment: oldMetadata.environment || {},
      watch: oldMetadata.watch,
      maxMemoryRestart: oldMetadata.maxMemoryRestart,
      restartDelay: oldMetadata.restartDelay,
      noAutorestart: oldMetadata.noAutorestart,
      time: oldMetadata.time,
      scriptFile: oldMetadata.scriptFile,
    };
    const paths = this.getNativeServicePaths(serviceName);
    this.secureNativeServiceDirectory(paths, serviceName);
    const stagedRuntime = this.stageNativeServiceRuntime(paths);
    let nextConfig: WindowsServiceConfig = { ...config, serviceAccount, backgroundOnly: false };
    if (resolve(nextConfig.executable) === resolve(process.execPath)) {
      nextConfig = { ...nextConfig, executable: stagedRuntime.runtimeExecutable };
    }
    const nextMetadata = {
      ...oldMetadata,
      ...(resolve(oldMetadata.executable) === resolve(process.execPath) ? { executable: stagedRuntime.runtimeExecutable } : {}),
      serviceAccount,
      backgroundOnly: false,
      ...(this.canonicalServiceAccount(oldNativeAccount) !== serviceAccount
        ? { legacyNativeServiceAccount: oldNativeAccount }
        : {}),
    };
    if (this.canonicalServiceAccount(oldNativeAccount) === serviceAccount) {
      delete nextMetadata.legacyNativeServiceAccount;
    }
    const scriptPath = join(dirname(paths.setupScriptPath), `${serviceName}-account-setup.ps1`);
    const nativeMetadataPath = join(paths.serviceDir, `${serviceName}.json`);
    const tokenPath = join(paths.serviceDir, 'cluster-auth.token');
    const clusterMatch = /^BS9_(.+)-\d+-g\d+$/.exec(serviceName);
    let manifestUpdate: { path: string; contents: string } | null = null;
    if (clusterMatch) {
      const clusterName = clusterMatch[1];
      const platformInfo = getPlatformInfo();
      const manifestPath = join(platformInfo.clusterDir, `${clusterName}.manifest.json`);
      if (existsSync(manifestPath)) {
        const manifestBytes = readFileSync(manifestPath);
        const manifest = JSON.parse(manifestBytes.toString("utf-8"));
        if (manifest.clusterName === clusterName) {
          manifest.options = { ...(manifest.options || {}), windowsServiceAccount: serviceAccount };
          manifestUpdate = { path: manifestPath, contents: JSON.stringify(manifest, null, 2) };
        }
      }
    }
    const previousFiles = new Map<string, Buffer | null>();
    const configMetadataPaths = [paths.configPath, join(this.servicesDir, `${serviceName}.json`), nativeMetadataPath, tokenPath];
    if (manifestUpdate) configMetadataPaths.push(manifestUpdate.path);
    for (const path of configMetadataPaths) {
      previousFiles.set(path, existsSync(path) ? readFileSync(path) : null);
    }
    try {
      if (serviceAccount === 'LocalService') {
        nextConfig = this.stageLocalServiceToken(serviceName, nextConfig, paths);
      }
      configs[serviceName] = nextConfig;
      if (!this.saveConfigs(configs)) {
        throw new Error(`Failed to persist staged configuration for '${serviceName}'`);
      }
      this.writeNativeHostConfig(nextConfig, paths);
      this.saveProcessMetadata(serviceName, nextMetadata);
      if (manifestUpdate) writeFileAtomically(manifestUpdate.path, manifestUpdate.contents);
      writeFileSync(scriptPath, this.generateServiceScript(nextConfig, 'configure'), 'utf-8');
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        encoding: "utf-8",
        windowsHide: true,
        env: getWindowsPowerShellEnvironment(),
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Failed to stage the BS9 SCM host for '${serviceName}': ${result.error?.message || result.stderr || result.stdout || `exit code ${result.status}`}`);
      }
    } catch (error) {
      if (previousConfig) configs[serviceName] = previousConfig;
      else delete configs[serviceName];
      const rollbackErrors: string[] = [];
      if (!this.saveConfigs(configs)) rollbackErrors.push('could not restore the service configuration file');
      for (const [path, contents] of previousFiles) {
        try {
          if (contents === null) {
            if (existsSync(path)) unlinkSync(path);
          } else {
            writeFileAtomically(path, contents);
          }
        } catch (restoreError) {
          rollbackErrors.push(`could not restore ${path}: ${restoreError}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors.map((message) => new Error(message))],
          `Windows service account migration failed and rollback was incomplete: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    } finally {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    }

    console.log(`✅ Windows service '${serviceName}' is staged for ${serviceAccount} under the BS9 service host. The running instance is unchanged; restart it during a maintenance window to apply the new host/account. Validate LocalService profile, file, pipe, and network access before restarting.`);
  }

  public getProcessMetadata(name: string): any {
    if (!isValidServiceName(name)) return null;
    const path = join(this.servicesDir, `${name}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
  }

  public generateServiceScript(config: WindowsServiceConfig, operation: 'create' | 'configure' = 'create'): string {
    const paths = this.getNativeServicePaths(config.name);
    const serviceAccount = this.normalizeServiceAccount(config.serviceAccount);
    const credentialAccount = serviceAccount === "LocalService"
      ? "NT AUTHORITY\\LocalService"
      : "LocalSystem";
    const sourceBase64 = Buffer.from(WINDOWS_SERVICE_HOST_SOURCE, 'utf-8').toString('base64');
    const binaryPath = `${quoteWindowsCommandLineArgument(paths.hostPath)} ${quoteWindowsCommandLineArgument(paths.configPath)}`;
    const serviceName = quotePowerShellLiteral(config.name);
    const displayName = quotePowerShellLiteral(config.displayName || config.name);
    const binaryPathLiteral = quotePowerShellLiteral(binaryPath);
    const hostPath = quotePowerShellLiteral(paths.hostPath);
    const accountLiteral = quotePowerShellLiteral(credentialAccount);
    const description = quotePowerShellLiteral(config.description || `BS9 Service: ${config.name}`);
    const serviceSidAccount = quotePowerShellLiteral(`NT SERVICE\\${config.name}`);
    const serviceDir = quotePowerShellLiteral(paths.serviceDir);
    const command = operation === 'create' ? 'create' : 'config';
    const registrationArgs = operation === 'create'
      ? `@('${command}', $serviceName, 'binPath=', $binaryPath, 'start=', 'auto', 'obj=', $account, 'DisplayName=', $displayName)`
      : `@('${command}', $serviceName, 'binPath=', $binaryPath, 'obj=', $account)`;
    const deleteOnFailure = operation === 'create' ? `if ($created) { & sc.exe delete $serviceName | Out-Null }` : '';
    const descriptionFailure = operation === 'create'
      ? `if ($LASTEXITCODE -ne 0) { throw "sc.exe description failed with exit code $LASTEXITCODE" }`
      : `if ($LASTEXITCODE -ne 0) { Write-Warning "Could not update the service description (exit code $LASTEXITCODE)" }`;
    const recoveryConfig = operation === 'create'
      ? `  $failureArgs = @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000')\n  & sc.exe @failureArgs\n  if ($LASTEXITCODE -ne 0) { throw "sc.exe failure recovery configuration failed with exit code $LASTEXITCODE" }\n  & sc.exe failureflag $serviceName 1\n  if ($LASTEXITCODE -ne 0) { throw "sc.exe failureflag failed with exit code $LASTEXITCODE" }\n`
      : '';
    const sidTypeSetup = `  $sidTypeArgs = @('sidtype', $serviceName, 'unrestricted')\n  & sc.exe @sidTypeArgs\n  if ($LASTEXITCODE -ne 0) { throw "sc.exe sidtype failed with exit code $LASTEXITCODE" }\n`;
    const serviceAclSetup = `  $acl = Get-Acl -LiteralPath $serviceDir\n  $acl.SetAccessRuleProtection($true, $false)\n  foreach ($oldRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($oldRule) }\n  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit\n  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {\n    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)\n    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)\n    [void]$acl.AddAccessRule($rule)\n  }\n  $serviceIdentity = New-Object System.Security.Principal.NTAccount($serviceSidAccount)\n  $serviceSid = $serviceIdentity.Translate([System.Security.Principal.SecurityIdentifier])\n  $serviceRule = [System.Security.AccessControl.FileSystemAccessRule]::new($serviceSid, [System.Security.AccessControl.FileSystemRights]::Modify, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)\n  [void]$acl.AddAccessRule($serviceRule)\n  Set-Acl -LiteralPath $serviceDir -AclObject $acl\n`;
    const preRegistrationSetup = operation === 'configure' ? `${sidTypeSetup}${serviceAclSetup}` : '';
    const postRegistrationSetup = operation === 'create' ? `${sidTypeSetup}${serviceAclSetup}` : '';
    return `$ErrorActionPreference = 'Stop'\n$serviceName = ${serviceName}\n$displayName = ${displayName}\n$hostPath = ${hostPath}\n$serviceDir = ${serviceDir}\n$serviceSidAccount = ${serviceSidAccount}\n$binaryPath = ${binaryPathLiteral}\n$account = ${accountLiteral}\n$description = ${description}\n$created = $false\ntry {\n  if (-not (Test-Path -LiteralPath $hostPath)) {\n    $source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${sourceBase64}'))\n    Add-Type -TypeDefinition $source -OutputAssembly $hostPath -OutputType ConsoleApplication -ReferencedAssemblies @('System.ServiceProcess', 'System.Web.Extensions')\n  }\n${preRegistrationSetup}  $serviceArgs = ${registrationArgs}\n  & sc.exe @serviceArgs\n  if ($LASTEXITCODE -ne 0) { throw "sc.exe ${command} failed with exit code $LASTEXITCODE" }\n  $created = $true\n${postRegistrationSetup}  $descriptionArgs = @('description', $serviceName, $description)\n  & sc.exe @descriptionArgs\n  ${descriptionFailure}\n${recoveryConfig}} catch {\n  ${deleteOnFailure}\n  throw\n}\n`;
  }
}

export async function windowsCommand(action: string, options: any): Promise<void> {
  console.log('🪟 BS9 Windows Service Management');
  console.log('='.repeat(80));

  const manager = new WindowsServiceManager();

  try {
    switch (action) {
      case 'create':
        await manager.createService({
          name: options.name,
          displayName: options.displayName || options.name,
          description: options.description || `BS9 Service: ${options.name}`,
          executable: options.file, // Note: caller passes 'file'
          arguments: options.args || [],
          workingDirectory: options.workingDir || process.cwd(),
          environment: options.env ? JSON.parse(options.env) : {},
          serviceAccount: options.serviceAccount,
          watch: options.watch,
          maxMemoryRestart: options.maxMemoryRestart,
          restartDelay: options.restartDelay,
          noAutorestart: options.noAutorestart,
          time: options.time,
          scriptFile: options.scriptFile || (options.args && options.args.length > 0 ? options.args[options.args.length - 1] : options.file)
        });
        await manager.startService(options.name);
        break;
      case 'account':
        await manager.configureServiceAccount(options.name, options.serviceAccount);
        break;
      case 'start':
        await manager.startService(options.name);
        break;
      case 'stop':
        await manager.stopService(options.name);
        break;
      case 'restart':
        await manager.stopService(options.name);
        await manager.startService(options.name);
        break;
      case 'delete':
        await manager.deleteService(options.name);
        break;
      case 'save':
        if (options.name) {
          const metadata = manager.getProcessMetadata(options.name);
          if (metadata) {
            const platformInfo = getPlatformInfo();
            const backupFile = join(platformInfo.backupDir, `${options.name}.json`);
            if (!existsSync(platformInfo.backupDir)) mkdirSync(platformInfo.backupDir, { recursive: true });
            writeFileSync(backupFile, JSON.stringify(metadata, null, 2));
            console.log(`💾 Service '${options.name}' saved to backup`);
          } else {
            console.warn(`⚠️ No metadata found for '${options.name}' to save`);
          }
        }
        break;
      case 'resurrect':
        if (options.name) {
          const platformInfo = getPlatformInfo();
          const backupFile = join(platformInfo.backupDir, `${options.name}.json`);
          if (existsSync(backupFile)) {
            const metadata = JSON.parse(readFileSync(backupFile, 'utf-8'));
            const { startCommand } = await import("../commands/start.js");
            const targetFile = metadata.scriptFile || (metadata.arguments && metadata.arguments.length > 0 ? metadata.arguments[metadata.arguments.length - 1] : metadata.executable);
            if (!metadata.serviceAccount) {
              console.warn(`[Security] Saved service '${options.name}' has no Windows service account recorded. Keeping LocalSystem for compatibility; recreate with --windows-service-account LocalService after validating profile access and ACLs to migrate.`);
            }
            await startCommand([targetFile], {
              name: metadata.name.replace(/^BS9_/, ''),
              port: metadata.environment?.PORT,
              host: metadata.environment?.HOST,
              env: Object.entries(metadata.environment || {}).map(([k, v]) => `${k}=${v}`),
              windowsServiceAccount: metadata.serviceAccount || "LocalSystem",
            });
            console.log(`✅ Service '${options.name}' resurrected from backup`);
          } else {
            throw new Error(`Backup for '${options.name}' not found`);
          }
        }
        break;
      case 'status':
      case 'show':
        if (options.name) {
          const status = await manager.getServiceStatus(options.name);
          if (status) {
            console.log(`📊 Service Status: ${status.name}`);
            console.log(`   State: ${status.state}`);
            if (status.serviceAccount) console.log(`   Native account: ${status.serviceAccount}`);
            if (status.legacyNativeServiceAccount) {
              console.warn(`   ⚠️ Legacy native SCM account recorded as '${status.legacyNativeServiceAccount}'. Verify its current state with: sc.exe qc ${status.name}`);
              if (status.backgroundOnly) {
                console.warn(`   Migration: after confirming the same-user watchdog is healthy, stop/delete this unused legacy daemon SCM registration with 'sc.exe stop ${status.name}' and 'sc.exe delete ${status.name}'.`);
              } else {
                console.warn(`   Migration: validate LocalService profile/file access, then run 'bs9 windows account --name ${status.name} --service-account LocalService'; restart the service to apply it.`);
              }
            }
            if (status.processId) console.log(`   PID: ${status.processId}`);
          } else {
            throw new Error(`Service '${options.name}' not found`);
          }
        } else {
          const services = await manager.listServices();
          console.table(services.map(s => ({
            Name: s.name,
            State: s.state,
            Account: s.serviceAccount || s.legacyNativeServiceAccount || '-',
            LegacySCM: s.legacyNativeServiceAccount ? 'review' : '-',
            PID: s.processId || '-',
          })));
        }
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`❌ Failed to ${action} Windows service: ${error}`);
    throw error;
  }
}
