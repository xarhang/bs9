/**
 * BS9 - Compatibility Adapter Registry & Version Matrix
 *
 * Capabilities:
 * - Detects installed/imported package versions against supported version matrix.
 * - Logs warning or skips if an unsupported or untracked major version is used.
 * - Central registry for zero-code compatibility adapters.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import semver from "semver";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackageSupportRule {
  name: string;
  supportedRange: string;
  description?: string;
}

export interface CompatibilityCheckResult {
  supported: boolean;
  version: string | null;
  range: string | null;
  reason?: string;
}

export const SUPPORTED_VERSION_MATRIX: Record<string, PackageSupportRule> = {
  "express-session": {
    name: "express-session",
    supportedRange: "1.17.x - 1.18.x",
    description: "Express session middleware with BS9 State Hub KV Store",
  },
};

/**
 * Attempt to detect the installed version of a package.
 */
export function detectPackageVersion(packageName: string): string | null {
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}

  try {
    const directPath = join(process.cwd(), "node_modules", packageName, "package.json");
    if (existsSync(directPath)) {
      const pkg = JSON.parse(readFileSync(directPath, "utf-8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}

  return null;
}

/**
 * Checks whether a package is supported and if its version matches the supported range.
 * If version is unsupported or untracked, logs a warning and returns { supported: false }.
 */
export function checkPackageCompatibility(
  packageName: string,
  versionOverride?: string,
  options: { silent?: boolean } = {}
): CompatibilityCheckResult {
  const rule = SUPPORTED_VERSION_MATRIX[packageName];
  if (!rule) {
    if (!options.silent) {
      console.warn(
        `[BS9 ADAPTER WARNING] Untracked package "${packageName}". Skipping BS9 adapter.`
      );
    }
    return {
      supported: false,
      version: versionOverride || null,
      range: null,
      reason: `Package "${packageName}" is not tracked in BS9 supported adapter matrix.`,
    };
  }

  const version = versionOverride || detectPackageVersion(packageName);
  if (!version) {
    if (!options.silent) {
      console.warn(
        `[BS9 ADAPTER WARNING] Could not detect installed version of "${packageName}". Skipping BS9 adapter.`
      );
    }
    return {
      supported: false,
      version: null,
      range: rule.supportedRange,
      reason: `Could not detect installed version of package "${packageName}".`,
    };
  }

  const cleanVer = semver.clean(version) || version;
  const isSatisfied = semver.satisfies(cleanVer, rule.supportedRange);

  if (!isSatisfied) {
    if (!options.silent) {
      console.warn(
        `[BS9 ADAPTER WARNING] Package "${packageName}" version "${cleanVer}" is outside supported range "${rule.supportedRange}". Skipping BS9 adapter.`
      );
    }
    return {
      supported: false,
      version: cleanVer,
      range: rule.supportedRange,
      reason: `Version "${cleanVer}" does not satisfy supported range "${rule.supportedRange}".`,
    };
  }

  return {
    supported: true,
    version: cleanVer,
    range: rule.supportedRange,
  };
}

export function isPackageVersionSupported(
  packageName: string,
  versionOverride?: string,
  options?: { silent?: boolean }
): boolean {
  return checkPackageCompatibility(packageName, versionOverride, options).supported;
}

export function registerPackageRule(rule: PackageSupportRule): void {
  SUPPORTED_VERSION_MATRIX[rule.name] = rule;
}
