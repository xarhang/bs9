/**
 * BS9 - Bun Sentinel 9
 * Unified Service Discovery Utility
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPlatformInfo, PlatformInfo } from "../platform/detect.js";
import { homedir } from "node:os";

export interface ServiceMetrics {
    name: string;
    loaded: string;
    active: string;
    sub: string;
    state: string;
    cpu: string;
    memory: string;
    uptime: string;
    tasks: string;
    pid: string;
    description: string;
    health?: string;
}

export async function listServices(): Promise<ServiceMetrics[]> {
    const platformInfo = getPlatformInfo();

    if (platformInfo.isLinux) {
        return getLinuxServices();
    } else if (platformInfo.isWindows) {
        return getWindowsServices();
    } else if (platformInfo.isMacOS) {
        return getMacOSServices();
    }

    return [];
}

async function getLinuxServices(): Promise<ServiceMetrics[]> {
    try {
        const listOutput = execSync("systemctl --user list-units --type=service --no-pager --no-legend", { encoding: "utf-8" });
        const lines = listOutput.split("\n").filter(line => line.includes(".service"));

        const services: ServiceMetrics[] = [];

        for (const line of lines) {
            if (!line.trim()) continue;

            const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
            if (!match) continue;

            const [, , name, loaded, active, sub, description] = match;

            if (!description.includes("Bun Service:") && !description.includes("BS9 Service:")) continue;

            const service: ServiceMetrics = {
                name,
                loaded,
                active,
                sub,
                state: `${active}/${sub}`,
                description,
                cpu: '-',
                memory: '-',
                uptime: '-',
                tasks: '-',
                pid: '-',
            };

            // Populate metrics
            try {
                const props = ["CPUUsageNSec", "MemoryCurrent", "ActiveEnterTimestamp", "TasksCurrent", "MainPID", "StatusText"];
                const showOutput = execSync(`systemctl --user show ${name} -p ${props.join(",")} --no-pager`, { encoding: "utf-8" });

                const getData = (key: string) => {
                    const m = showOutput.match(new RegExp(`${key}=(.+)`));
                    return m ? m[1].trim() : null;
                };

                const cpuNs = getData("CPUUsageNSec");
                if (cpuNs && cpuNs !== "0") service.cpu = `${(Number(cpuNs) / 1000000).toFixed(1)}ms`;

                const memBytes = getData("MemoryCurrent");
                if (memBytes && memBytes !== "[not set]") service.memory = formatMemory(Number(memBytes));

                const uptime = getData("ActiveEnterTimestamp");
                if (uptime && uptime !== "") service.uptime = formatUptime(uptime);

                const tasks = getData("TasksCurrent");
                if (tasks && tasks !== "[not set]") service.tasks = tasks;

                const pid = getData("MainPID");
                if (pid && pid !== "0") service.pid = pid;

            } catch { /* ignore properties errors */ }

            services.push(service);
        }

        return services;
    } catch (error) {
        return [];
    }
}

async function getWindowsProcessMetrics(pids: string[]): Promise<Map<string, { cpu: string, memory: string }>> {
    const metricsMap = new Map<string, { cpu: string, memory: string }>();
    if (pids.length === 0) return metricsMap;

    try {
        const validPids = pids.filter(p => p !== '-' && !isNaN(Number(p)));
        if (validPids.length === 0) return metricsMap;

        // Use safer PowerShell filtering that doesn't throw if a PID is missing
        const pidList = validPids.join(',');
        const command = `powershell -NoProfile -Command "$ids = @(${pidList}); Get-Process | Where-Object { $ids -contains $_.Id } | Select-Object Id, @{Name='Mem';Expression={ [Math]::Round($_.WorkingSet64 / 1024) }}, @{Name='CPU';Expression={ $_.TotalProcessorTime.ToString('hh\\:mm\\:ss') }} | ConvertTo-Csv -NoTypeInformation"`;

        const output = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const lines = output.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || !trimmedLine.includes(',')) continue;
            // CSV format: "Id","Mem","CPU"
            const parts = trimmedLine.split(',').map(p => p.replace(/^"|"$/g, '').trim());
            if (parts.length >= 3 && parts[0] !== 'Id') {
                const pid = parts[0];
                const memK = parts[1]; // in KB
                const cpuTime = parts[2];

                metricsMap.set(pid, {
                    cpu: cpuTime,
                    memory: `${memK} K`
                });
            }
        }
    } catch {
        // targeted query failed
    }
    return metricsMap;
}

async function getWindowsServices(): Promise<ServiceMetrics[]> {
    const services: ServiceMetrics[] = [];

    // 1. Collect all metadata first
    const nativeServices: any[] = [];
    try {
        const { WindowsServiceManager } = await import("../windows/service.js");
        const manager = new WindowsServiceManager();
        const winServices = await manager.listServices();
        nativeServices.push(...winServices);
    } catch { /* skip native if failed */ }

    const backgroundMeta: any[] = [];
    const userBs9Dir = join(homedir(), '.bs9', 'services');
    if (existsSync(userBs9Dir)) {
        const files = readdirSync(userBs9Dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const metadata = JSON.parse(readFileSync(join(userBs9Dir, file), 'utf-8'));
                backgroundMeta.push(metadata);
            } catch { /* skip invalid */ }
        }
    }

    // 2. Extract PIDs for batch metric fetching
    const pidsToFetch = new Set<string>();
    nativeServices.forEach(s => { if (s.processId) pidsToFetch.add(s.processId.toString()); });
    backgroundMeta.forEach(m => { if (m.pid) pidsToFetch.add(m.pid.toString()); });

    // 3. Fetch metrics for all PIDs in one go
    const metricsMap = await getWindowsProcessMetrics(Array.from(pidsToFetch));

    // 4. Map collected data to ServiceMetrics
    for (const svc of nativeServices) {
        const pidStr = svc.processId?.toString() || '-';
        const metrics = pidStr !== '-' ? metricsMap.get(pidStr) : null;
        services.push({
            name: svc.name,
            loaded: "loaded",
            active: metrics ? 'active' : (svc.state === 'running' ? 'active' : 'inactive'),
            sub: metrics ? 'running' : (svc.state === 'running' ? 'running' : 'stopped'),
            state: svc.state,
            description: svc.description || `BS9 Windows Service`,
            cpu: metrics?.cpu || '-',
            memory: metrics?.memory || '-',
            uptime: '-',
            tasks: '-',
            pid: pidStr,
        });
    }

    for (const metadata of backgroundMeta) {
        if (services.find(s => s.name === metadata.name)) continue;

        const pidStr = metadata.pid?.toString() || '-';
        const metrics = pidStr !== '-' ? metricsMap.get(pidStr) : null;

        services.push({
            name: metadata.name,
            loaded: "loaded",
            active: metrics ? 'active' : 'inactive',
            sub: metrics ? 'running' : 'stopped',
            state: metrics ? 'active/running' : 'inactive/stopped',
            description: metadata.description || "BS9 Background Process (Non-Admin)",
            cpu: metrics?.cpu || '-',
            memory: metrics?.memory || '-',
            uptime: metadata.startTime ? formatUptime(metadata.startTime) : '-',
            tasks: '-',
            pid: metrics ? pidStr : '-',
        });
    }

    return services;
}

async function getMacOSServices(): Promise<ServiceMetrics[]> {
    return [];
}

function formatMemory(bytes: number): string {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${sizes[i]}`;
}

function formatUptime(timestamp: string): string {
    try {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        if (diff < 0) return '-';

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    } catch {
        return '-';
    }
}
