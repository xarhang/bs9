#!/usr/bin/env bun

/**
 * BS9 - High-Availability Inspection & Diagnostic Tooling (`bs9 inspect-ha`)
 *
 * Capabilities:
 * - Analyzes entrypoint file and referenced relative imports.
 * - Framework & HTTP server detection: Bun.serve (explicit or default export), Hono, Elysia, Express, Fastify.
 * - In-memory state pitfall detection: module-level mutable variables (`let`, `var`), collections (`Map`, `Set`), in-memory session/cache objects.
 * - High-Availability Tier classification:
 *     - Tier 1: Fully Stateless / HA Ready (100% safe zero-downtime rolling reload & failover).
 *     - Tier 2: Managed State HA Ready (uses `bs9/runtime` State, Lease, Queue).
 *     - Tier 3: Unmanaged In-Memory State Warning (detects state that will be lost on worker restart; provides actionable recommendations to migrate to `bs9/runtime`).
 * - Supports `--json` flag for CI/CD pipelines.
 * - Formats rich visual terminal output with remediation steps and migration snippets.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";

export interface HaPitfall {
  file: string;
  line: number;
  type: "mutable-variable" | "collection" | "cache-object";
  name: string;
  snippet: string;
  description: string;
  remediation: string;
}

export type HaTier = 1 | 2 | 3;

export interface HaInspectionReport {
  file: string;
  framework: string;
  frameworkDetected: boolean;
  tier: HaTier;
  tierName: string;
  haReady: boolean;
  summary: string;
  pitfalls: HaPitfall[];
  managedState: {
    usesBs9Runtime: boolean;
    features: string[];
  };
  scannedFiles: string[];
}

export interface InspectHaOptions {
  json?: boolean;
}

/**
 * Detect framework from source code
 */
function detectFramework(contents: string): { name: string; detected: boolean } {
  if (/\bnew\s+Hono\b|from\s+['"]hono['"]/i.test(contents)) {
    return { name: "Hono", detected: true };
  }
  if (/\bnew\s+Elysia\b|from\s+['"]elysia['"]/i.test(contents)) {
    return { name: "Elysia", detected: true };
  }
  if (/\bexpress\s*\(\s*\)|from\s+['"]express['"]|require\s*\(\s*['"]express['"]\s*\)/i.test(contents)) {
    return { name: "Express", detected: true };
  }
  if (/\bfastify\s*\(\s*\)|from\s+['"]fastify['"]|require\s*\(\s*['"]fastify['"]\s*\)/i.test(contents)) {
    return { name: "Fastify", detected: true };
  }
  if (
    /\bBun\.serve\b|\bserve\s*\(\{/i.test(contents) ||
    /export\s+default\s*\{[\s\S]*?\bfetch\b/i.test(contents)
  ) {
    return { name: "Bun.serve", detected: true };
  }

  return { name: "Generic HTTP Server", detected: false };
}

/**
 * Detect bs9/runtime managed state usage
 */
function detectManagedState(contents: string): { usesBs9Runtime: boolean; features: string[] } {
  const isRuntimeImported =
    /from\s+['"]bs9\/runtime['"]|from\s+['"]bs9['"]|require\s*\(\s*['"]bs9\/runtime['"]\s*\)/i.test(contents);

  const features: string[] = [];
  if (isRuntimeImported) {
    if (/\bstate\b|\bState\b/.test(contents)) features.push("State");
    if (/\blease\b|\bLease\b/.test(contents)) features.push("Lease");
    if (/\bqueue\b|\bQueue\b/.test(contents)) features.push("Queue");
    if (/\bevents\b|\bEvents\b/.test(contents)) features.push("Events");
  }

  return {
    usesBs9Runtime: isRuntimeImported,
    features,
  };
}

/**
 * Resolve relative imported file path with standard JS/TS extensions
 */
function resolveRelativeImport(baseFile: string, importPath: string): string | null {
  const dir = dirname(baseFile);
  const target = resolve(dir, importPath);

  const candidates = [
    target,
    `${target}.ts`,
    `${target}.js`,
    `${target}.tsx`,
    `${target}.jsx`,
    `${target}.mjs`,
    join(target, "index.ts"),
    join(target, "index.js"),
  ];

  for (const cand of candidates) {
    if (existsSync(cand)) {
      return cand;
    }
  }

  return null;
}

/**
 * Extract relative imports from source code
 */
function extractRelativeImports(contents: string): string[] {
  const imports: string[] = [];
  const regexes = [
    /import\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g,
    /export\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g,
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];

  for (const re of regexes) {
    let match;
    while ((match = re.exec(contents)) !== null) {
      if (match[1]) {
        imports.push(match[1]);
      }
    }
  }

  return imports;
}

/**
 * Parse a single file and find module-level mutable state pitfalls
 */
function scanFileForPitfalls(filePath: string, contents: string): HaPitfall[] {
  const pitfalls: HaPitfall[] = [];
  const lines = contents.split(/\r?\n/);

  let inBlockComment = false;
  let inBacktick = false;
  let braceDepth = 0;
  let parenDepth = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const lineNum = lineIdx + 1;
    let i = 0;

    // Scan line character by character tracking syntax depth
    while (i < rawLine.length) {
      const ch = rawLine[i];
      const nextCh = rawLine[i + 1];

      // Handle block comment continuation
      if (inBlockComment) {
        if (ch === "*" && nextCh === "/") {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // Handle backtick template literal continuation
      if (inBacktick) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "`") {
          inBacktick = false;
          i++;
          continue;
        }
        if (ch === "$" && nextCh === "{") {
          braceDepth++;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // Check comments
      if (ch === "/" && nextCh === "/") {
        // Line comment: rest of line is ignored
        break;
      }
      if (ch === "/" && nextCh === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }

      // Check strings
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < rawLine.length) {
          if (rawLine[i] === "\\") {
            i += 2;
            continue;
          }
          if (rawLine[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }

      // Check backticks
      if (ch === "`") {
        inBacktick = true;
        i++;
        continue;
      }

      // Track braces and parentheses
      if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      }

      i++;
    }

    // Module-level detection: only inspect statements at top level (braceDepth === 0, parenDepth === 0)
    // Note: To capture lines that open a top-level block, evaluate when braceDepth was 0 prior to or at declaration
    const trimmed = rawLine.trim();

    // Skip empty lines or comment-only lines
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    // Only flag at module level (brace depth 0 or 1 if line closes it)
    if (braceDepth === 0 || (braceDepth === 1 && (trimmed.includes("{") || trimmed.endsWith("{")))) {
      // 1. In-memory Collections: new Map, new Set, new WeakMap, new WeakSet
      const collectionMatch = /(?:(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*)?new\s+(Map|Set|WeakMap|WeakSet)\b/.exec(trimmed);
      if (collectionMatch) {
        const varName = collectionMatch[1] || collectionMatch[2];
        const collType = collectionMatch[2];
        pitfalls.push({
          file: filePath,
          line: lineNum,
          type: "collection",
          name: varName,
          snippet: trimmed,
          description: `Module-level in-memory collection '${collType}' will lose all data on worker reload or crash failover.`,
          remediation: `Migrate to BS9 Hub State:\n    import { state } from "bs9/runtime";\n    await state.set("${varName}:" + key, value);`,
        });
        continue;
      }

      // 2. Mutable Variables: let or var at module level
      const mutableMatch = /(?:^|[;\s])(?:export\s+)?(let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(trimmed);
      if (mutableMatch) {
        const keyword = mutableMatch[1];
        const varName = mutableMatch[2];
        // Skip for-loop counters if somehow at top level
        if (trimmed.startsWith("for ") || trimmed.startsWith("for(")) {
          continue;
        }

        pitfalls.push({
          file: filePath,
          line: lineNum,
          type: "mutable-variable",
          name: varName,
          snippet: trimmed,
          description: `Module-level mutable variable '${varName}' declared with '${keyword}' will reset to initial value on reload.`,
          remediation: `Store counter/variable in BS9 Hub State:\n    import { state } from "bs9/runtime";\n    await state.set("${varName}", val);`,
        });
        continue;
      }

      // 3. In-memory Cache / Session objects
      const cacheObjectMatch = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]*(?:cache|session|sessions|token|tokens|store|state)[a-zA-Z0-9_$]*)\s*(?::\s*[^=]+)?=\s*(\{\}|\[\]|new\s+Object)/i.exec(trimmed);
      if (cacheObjectMatch) {
        const varName = cacheObjectMatch[1];
        pitfalls.push({
          file: filePath,
          line: lineNum,
          type: "cache-object",
          name: varName,
          snippet: trimmed,
          description: `Module-level in-memory state object '${varName}' stored in worker heap without persistence.`,
          remediation: `Migrate to BS9 Hub State:\n    import { state } from "bs9/runtime";\n    await state.set("sessions:" + id, data);`,
        });
        continue;
      }
    }
  }

  return pitfalls;
}

/**
 * Deeply inspect an application and referenced relative files
 */
export function inspectApplicationHa(entryFile: string): HaInspectionReport {
  const resolvedEntry = resolve(entryFile);
  if (!existsSync(resolvedEntry)) {
    throw new Error(`Target file not found: ${entryFile}`);
  }

  const visited = new Set<string>();
  const toVisit: string[] = [resolvedEntry];
  const scannedFiles: string[] = [];

  let detectedFramework = "Generic HTTP Server";
  let frameworkDetected = false;
  let usesBs9Runtime = false;
  const runtimeFeatures = new Set<string>();
  const allPitfalls: HaPitfall[] = [];

  while (toVisit.length > 0) {
    const current = toVisit.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    scannedFiles.push(current);

    let content = "";
    try {
      content = readFileSync(current, "utf-8");
    } catch {
      continue;
    }

    // Framework detection from entry or root modules
    if (!frameworkDetected) {
      const fw = detectFramework(content);
      if (fw.detected) {
        detectedFramework = fw.name;
        frameworkDetected = true;
      }
    }

    // BS9 Runtime managed state detection
    const managed = detectManagedState(content);
    if (managed.usesBs9Runtime) {
      usesBs9Runtime = true;
      for (const feat of managed.features) runtimeFeatures.add(feat);
    }

    // Scan for in-memory state pitfalls
    const filePitfalls = scanFileForPitfalls(current, content);
    allPitfalls.push(...filePitfalls);

    // Discover referenced relative imports
    const relImports = extractRelativeImports(content);
    for (const imp of relImports) {
      const resolvedPath = resolveRelativeImport(current, imp);
      if (resolvedPath && !visited.has(resolvedPath)) {
        toVisit.push(resolvedPath);
      }
    }
  }

  // Tier Classification
  let tier: HaTier = 1;
  let tierName = "Tier 1: Fully Stateless / HA Ready";
  let haReady = true;
  let summary = "Fully stateless architecture. Ready for zero-downtime rolling reload & failover.";

  if (allPitfalls.length > 0) {
    tier = 3;
    tierName = "Tier 3: Unmanaged In-Memory State Warning";
    haReady = false;
    summary = `Detected ${allPitfalls.length} unmanaged in-memory state pitfall(s) that will be lost on worker restart or reload.`;
  } else if (usesBs9Runtime) {
    tier = 2;
    tierName = "Tier 2: Managed State HA Ready";
    haReady = true;
    const featStr = Array.from(runtimeFeatures).join(", ") || "State Hub";
    summary = `State is managed via bs9/runtime (${featStr}). Resilient across zero-downtime reloads and failover.`;
  }

  return {
    file: resolvedEntry,
    framework: detectedFramework,
    frameworkDetected,
    tier,
    tierName,
    haReady,
    summary,
    pitfalls: allPitfalls,
    managedState: {
      usesBs9Runtime,
      features: Array.from(runtimeFeatures),
    },
    scannedFiles,
  };
}

/**
 * Format and print inspection results to terminal with colors and remediation
 */
function displayReport(report: HaInspectionReport): void {
  const border = "═".repeat(78);
  const thinDivider = "─".repeat(78);

  console.log(`\n╔${border}╗`);
  console.log(`║ 🔍  BS9 HIGH-AVAILABILITY ARCHITECTURE INSPECTION                          ║`);
  console.log(`╚${border}╝\n`);

  console.log(`📁 Target File:      ${report.file}`);
  console.log(`⚡ HTTP Framework:   ${report.framework}`);
  console.log(`📦 Scanned Files:    ${report.scannedFiles.length} file(s) analyzed`);
  if (report.managedState.usesBs9Runtime) {
    console.log(`🔄 BS9 Runtime:      Active (${report.managedState.features.join(", ") || "Connected"})`);
  }
  console.log(thinDivider);

  if (report.tier === 1) {
    console.log(`\n\x1b[1m\x1b[32m[TIER 1] FULLY STATELESS / HA READY\x1b[0m`);
    console.log(`  ✅ 100% safe for zero-downtime rolling reload & violent failover.`);
    console.log(`  ✅ No unmanaged in-memory mutable state or collections detected.`);
    console.log(`  ✨ Summary: ${report.summary}\n`);
  } else if (report.tier === 2) {
    console.log(`\n\x1b[1m\x1b[36m[TIER 2] MANAGED STATE HA READY\x1b[0m`);
    console.log(`  ✅ Uses bs9/runtime: ${report.managedState.features.join(", ")}`);
    console.log(`  ✅ State is synchronized across cluster workers and persisted via BS9 State Hub.`);
    console.log(`  ✨ Summary: ${report.summary}\n`);
  } else {
    console.log(`\n\x1b[1m\x1b[33m[TIER 3] UNMANAGED IN-MEMORY STATE WARNING\x1b[0m`);
    console.log(`  ⚠️  State will be lost during rolling reloads or worker failover.`);
    console.log(`  ⚠️  ${report.summary}\n`);

    console.log(`\x1b[1m⚠️  DETECTED IN-MEMORY STATE PITFALLS (${report.pitfalls.length}):\x1b[0m\n`);

    report.pitfalls.forEach((pitfall, idx) => {
      console.log(`  ${idx + 1}. \x1b[33m[${pitfall.type.toUpperCase()}]\x1b[0m \x1b[1m${pitfall.name}\x1b[0m at ${pitfall.file}:${pitfall.line}`);
      console.log(`     \x1b[90mCode:\x1b[0m    ${pitfall.snippet}`);
      console.log(`     \x1b[90mImpact:\x1b[0m  ${pitfall.description}`);
      console.log(`     \x1b[32mAction:\x1b[0m  ${pitfall.remediation.replace(/\n/g, "\n             ")}\n`);
    });

    console.log(thinDivider);
    console.log(`\x1b[1m💡 REMEDIATION GUIDE FOR BS9 CLUSTER:\x1b[0m`);
    console.log(`   To make this service resilient against worker crashes and rolling reloads:`);
    console.log(`   1. Install/Import BS9 Runtime:`);
    console.log(`      \x1b[36mimport { state, lease, queue } from "bs9/runtime";\x1b[0m`);
    console.log(`   2. Replace local in-memory Maps/Sets with Hub state methods:`);
    console.log(`      \x1b[36mawait state.set("key", value);\x1b[0m`);
    console.log(`      \x1b[36mconst value = await state.get("key");\x1b[0m`);
    console.log(`   3. Verify zero-downtime reliability with:`);
    console.log(`      \x1b[36mbs9 verify-ha ${report.file}\x1b[0m\n`);
  }
}

/**
 * Main command action for `bs9 inspect-ha <file>`
 */
export async function inspectHaCommand(file: string, options: InspectHaOptions = {}): Promise<HaInspectionReport> {
  try {
    const report = inspectApplicationHa(file);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      displayReport(report);
    }

    return report;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`\x1b[31m❌ Inspection failed: ${err.message}\x1b[0m`);
    }
    throw err;
  }
}
