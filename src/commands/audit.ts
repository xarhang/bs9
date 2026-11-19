/**
 * BS9 - Audit Log Viewer Command (`bs9 audit`)
 *
 * Displays tamper-safe security & lifecycle audit events recorded by BS9.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readAuditEvents } from "../utils/audit-log.js";

export interface AuditOptions {
  limit?: string;
  action?: string;
  json?: boolean;
}

export async function auditCommand(options: AuditOptions = {}): Promise<void> {
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 50));
  let events = readAuditEvents(options.action ? 1000 : limit);

  if (options.action) {
    const filter = options.action.trim().toLowerCase();
    events = events.filter((e) => e.action.toLowerCase() === filter).slice(-limit);
  }

  if (options.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log("ℹ️  No audit events recorded.");
    return;
  }

  console.log("🔐 BS9 Security & Lifecycle Audit Log");
  console.log("─".repeat(88));
  console.log(
    `${"TIMESTAMP".padEnd(26)} ${"ACTION".padEnd(14)} ${"TARGET".padEnd(20)} ${"STATUS".padEnd(10)} DETAILS`
  );
  console.log("─".repeat(88));

  for (const e of events) {
    console.log(
      `${e.timestamp.padEnd(26)} ${e.action.slice(0, 13).padEnd(14)} ${e.target.slice(0, 19).padEnd(20)} ${e.status.padEnd(10)} ${e.details || "-"}`
    );
  }
}
