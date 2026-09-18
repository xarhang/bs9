import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ServiceInfo {
  name: string;
  status: string;
  pid?: number;
  port?: number;
}

// Shared batch result display — used by start, stop, restart, delete commands
export function displayBatchResults(
  results: PromiseSettledResult<{ service: string; status: string; error: string | null }>[],
  operation: string
): void {
  console.log(`\n📊 Batch ${operation} Results`);
  console.log("=".repeat(50));

  const successful = results.filter(r => r.status === 'fulfilled' && r.value.status === 'success');
  const failed = results.filter(r => r.status === 'fulfilled' && r.value.status === 'failed');

  successful.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`✅ ${result.value.service} - ${operation} successful`);
    }
  });

  failed.forEach(result => {
    if (result.status === 'fulfilled') {
      console.log(`❌ ${result.value.service} - Failed: ${result.value.error}`);
    }
  });

  const total = results.length;
  console.log(`\n📈 Summary:`);
  console.log(`   Total: ${total} services`);
  console.log(`   Success: ${successful.length}/${total} (${((successful.length / Math.max(1, total)) * 100).toFixed(1)}%)`);
  console.log(`   Failed: ${failed.length}/${total} (${((failed.length / Math.max(1, total)) * 100).toFixed(1)}%)`);
}

export async function parseServiceArray(input: string | string[]): Promise<string[]> {
  if (!input || (Array.isArray(input) && input.length === 0)) return [];

  let services: string[] = [];

  if (Array.isArray(input)) {
    if (input.length === 1) {
      return await parseServiceArray(input[0]);
    }
    services = input;
  } else {
    // Handle "all" keyword
    if (input === 'all') {
      return await getAllServices();
    }

    // Handle array syntax [app1, app2, app-*]
    const arrayMatch = input.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      services = arrayMatch[1].split(',').map(s => s.trim());
    } else {
      services = [input];
    }
  }

  const expanded: string[] = [];

  for (const service of services) {
    if (service.includes('*')) {
      // Pattern matching — pass raw pattern with * to getServicesByPattern
      const matching = await getServicesByPattern(service);
      expanded.push(...matching);
    } else if (service === 'all') {
      // All services
      const allServices = await getAllServices();
      expanded.push(...allServices);
    } else if (service) {
      // Specific service
      expanded.push(service);
    }
  }

  // Remove duplicates and return
  return [...new Set(expanded)];
}

import { listServices } from "./service-discovery.js";

export function normalizeManagedServiceName(name: string): string {
  return name.replace(/^(BS9_|bs9\.)/, '');
}

export async function getAllServices(): Promise<string[]> {
  try {
    const services = await listServices();
    // Commands consume platform-neutral names and add the native prefix only
    // at the service-manager boundary.
    return services.map(s => normalizeManagedServiceName(s.name));
  } catch {
    return [];
  }
}

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getServicesByPattern(pattern: string): Promise<string[]> {
  try {
    const allServices = await getAllServices();
    // Escape all regex special chars except '*', then convert '*' to '.*'
    const escaped = pattern.split('*').map(part => escapeRegExp(part)).join('.*');
    const regex = new RegExp(`^${escaped}$`);
    return allServices.filter(service => regex.test(service));
  } catch {
    return [];
  }
}

export async function getServiceInfo(serviceName: string): Promise<ServiceInfo | null> {
  try {
    const services = await listServices();
    // Match either the provided name or the prefixed name
    const service = services.find(s => normalizeManagedServiceName(s.name) === normalizeManagedServiceName(serviceName));

    if (!service) return null;

    return {
      name: normalizeManagedServiceName(service.name),
      status: service.active === 'active' ? 'active' : 'inactive',
      pid: service.pid !== '-' ? parseInt(service.pid) : undefined
      // Port matching would require parsing description or checking env, 
      // but getServiceInfo is rarely used and ServiceMetrics has description.
    };
  } catch {
    return null;
  }
}

export async function getMultipleServiceInfo(serviceNames: string[]): Promise<ServiceInfo[]> {
  try {
    const services = await listServices();
    const targetSet = new Set(serviceNames.map(normalizeManagedServiceName));
    const result: ServiceInfo[] = [];

    for (const service of services) {
      const norm = normalizeManagedServiceName(service.name);
      if (targetSet.has(norm)) {
        result.push({
          name: norm,
          status: service.active === 'active' ? 'active' : 'inactive',
          pid: service.pid !== '-' && !isNaN(Number(service.pid)) ? parseInt(service.pid, 10) : undefined,
        });
      }
    }

    return result;
  } catch {
    return [];
  }
}

export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(message);

    // Handle non-TTY (pipes)
    if (!process.stdin.setRawMode) {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (data) => {
        const key = data.toString().trim().toLowerCase();
        resolve(key === 'y' || key === 'yes');
      });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };

    const onData = (key: string) => {
      if (key === '\x03') {
        // Ctrl+C — restore terminal and exit gracefully
        cleanup();
        process.stdout.write('\n');
        resolve(false);
      } else if (key === 'y' || key === 'Y') {
        cleanup();
        resolve(true);
      } else if (key === '\n' || key === '\r' || key === 'n' || key === 'N') {
        cleanup();
        resolve(false);
      }
    };

    process.stdin.on('data', onData);
  });
}
