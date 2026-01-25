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
    const output = execSync("systemctl --user list-units --type=service --all --no-pager --no-legend", { 
      encoding: "utf-8" 
    });
    
    const services = output
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.split(' ')[0])
      .filter(service => service.includes('bs9-'))
      .map(service => service.replace('bs9-', ''));
    
    return services;
  } catch {
    return [];
  }
}

export async function getServicesByPattern(pattern: string): Promise<string[]> {
  try {
    const allServices = await getAllServices();
    const regex = new RegExp(`^${pattern}$`);
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
