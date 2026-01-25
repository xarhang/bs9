#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { join } from "node:path";
import { getPlatformInfo } from "../platform/detect.js";

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, and dots
  // Prevent command injection and path traversal
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes('..') && !name.includes('/');
}

export async function stopCommand(name: string): Promise<void> {
  // Security: Validate service name
  if (!isValidServiceName(name)) {
    console.error(`❌ Security: Invalid service name: ${name}`);
    process.exit(1);
  }
  
  const platformInfo = getPlatformInfo();
  
  try {
    if (platformInfo.isLinux) {
      // Security: Use shell escaping to prevent injection
      const escapedName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      execSync(`systemctl --user stop "${escapedName}"`, { stdio: "inherit" });
      console.log(`🛑 User service '${name}' stopped`);
    } else if (platformInfo.isMacOS) {
      const { launchdCommand } = await import("../macos/launchd.js");
      await launchdCommand('stop', { name: `bs9.${name}` });
    } else if (platformInfo.isWindows) {
      const { windowsCommand } = await import("../windows/service.js");
      await windowsCommand('stop', { name: `BS9_${name}` });
    }
  } catch (err) {
    console.error(`❌ Failed to stop service '${name}': ${err}`);
    process.exit(1);
  }
}
