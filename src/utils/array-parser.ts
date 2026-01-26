import { execSync } from "child_process";
import { existsSync } from "fs";

export interface ServiceInfo {
  name: string;
  status: string;
  pid?: number;
  port?: number;
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
      // Pattern matching
      const pattern = service.replace('*', '.*');
      const matching = await getServicesByPattern(pattern);
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

export async function getAllServices(): Promise<string[]> {
  try {
    const services = await listServices();
    // Return only the base names (without BS9_ prefix if applicable, 
    // or just return names that listServices provides which are normalized)
    // listServices returns full names like 'BS9_app'. We should trim the prefix if we want the 'short' name
    // But most commands expect the short name and then prepend the prefix.
    // However, listServices is our source of truth now.
    return services.map(s => s.name.replace(/^BS9_/, ''));
  } catch {
    return [];
  }
}

export async function getServicesByPattern(pattern: string): Promise<string[]> {
  try {
    const allServices = await getAllServices();
    const regexPattern = pattern.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return allServices.filter(service => regex.test(service));
  } catch {
    return [];
  }
}

export async function getServiceInfo(serviceName: string): Promise<ServiceInfo | null> {
  try {
    const services = await listServices();
    // Match either the provided name or the prefixed name
    const service = services.find(s => s.name === serviceName || s.name === `BS9_${serviceName}`);

    if (!service) return null;

    return {
      name: service.name.replace(/^BS9_/, ''),
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
  const results = await Promise.allSettled(
    serviceNames.map(name => getServiceInfo(name))
  );

  return results
    .filter((result): result is PromiseFulfilledResult<ServiceInfo> =>
      result.status === 'fulfilled' && result.value !== null
    )
    .map(result => result.value);
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

    const onData = (key: string) => {
      if (key === 'y' || key === 'Y') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve(true);
      } else if (key === '\n' || key === '\r' || key === 'n' || key === 'N') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve(false);
      }
    };

    process.stdin.on('data', onData);
  });
}
