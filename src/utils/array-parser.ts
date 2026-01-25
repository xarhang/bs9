import { execSync } from "child_process";
import { existsSync } from "fs";

export interface ServiceInfo {
  name: string;
  status: string;
  pid?: number;
  port?: number;
}

export async function parseServiceArray(input: string): Promise<string[]> {
  if (!input) return [];
  
  // Handle "all" keyword
  if (input === 'all') {
    return await getAllServices();
  }
  
  // Handle array syntax [app1, app2, app-*]
  const arrayMatch = input.match(/^\[(.*)\]$/);
  if (!arrayMatch) {
    return [input]; // Single service
  }
  
  const services = arrayMatch[1].split(',').map(s => s.trim());
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
    } else {
      // Specific service
      expanded.push(service);
    }
  }
  
  // Remove duplicates and return
  return [...new Set(expanded)];
}

export async function getAllServices(): Promise<string[]> {
  try {
    // Use the same logic as the status command since it already works
    const output = execSync("systemctl --user list-units --type=service --all --no-pager --no-legend", { encoding: "utf-8" });
    const lines = output.split("\n").filter(line => line.includes(".service"));
    
    const services = [];
    for (const line of lines) {
      const match = line.match(/^(?:\s*([●\s○]))?\s*([^\s]+)\.service\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.+)$/);
      if (match) {
        const [, , name, , , , description] = match;
        if (description.includes("BS9 Service:")) {
          services.push(name);
        }
      }
    }
    
    return services;
  } catch {
    return [];
  }
}

export async function getServicesByPattern(pattern: string): Promise<string[]> {
  try {
    const allServices = await getAllServices();
    // Convert glob pattern to regex
    const regexPattern = pattern.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return allServices.filter(service => regex.test(service));
  } catch {
    return [];
  }
}

export async function getServiceInfo(serviceName: string): Promise<ServiceInfo | null> {
  try {
    const status = execSync(`systemctl --user is-active bs9-${serviceName}`, { encoding: "utf-8" }).trim();
    const showOutput = execSync(`systemctl --user show bs9-${serviceName}`, { encoding: "utf-8" });
    
    const pidMatch = showOutput.match(/MainPID=(\d+)/);
    const portMatch = showOutput.match(/Environment=PORT=(\d+)/);
    
    return {
      name: serviceName,
      status: status,
      pid: pidMatch ? parseInt(pidMatch[1]) : undefined,
      port: portMatch ? parseInt(portMatch[1]) : undefined
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
