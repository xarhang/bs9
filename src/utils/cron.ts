/**
 * BS9 - Lightweight 5-Field Cron Expression Parser
 *
 * Zero-dependency scheduler helper supporting standard 5-field cron expressions:
 *   minute (0-59)  hour (0-23)  dayOfMonth (1-31)  month (1-12)  dayOfWeek (0-6)
 * Supports `*`, `* /n`, `a-b`, `a,b`, and single integers.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  const trimmed = field.trim();
  if (!trimmed) {
    throw new Error(`Empty cron field`);
  }

  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) throw new Error(`Invalid cron token in '${field}'`);

    const stepParts = token.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron step in '${token}'`);
    const rangePart = stepParts[0];
    if (!rangePart) throw new Error(`Invalid cron field '${token}'`);
    const step = stepParts[1] !== undefined ? Number(stepParts[1]) : 1;
    if (!stepParts[1] && stepParts.length === 2) {
      throw new Error(`Invalid cron step in '${token}'`);
    }
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step value '${stepParts[1]}'`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const rangeBounds = rangePart.split("-");
        if (rangeBounds.length !== 2 || !rangeBounds[0] || !rangeBounds[1]) {
          throw new Error(`Invalid cron range '${rangePart}' (expected ${min}-${max})`);
        }
        const a = Number(rangeBounds[0]);
        const b = Number(rangeBounds[1]);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) {
          throw new Error(`Invalid cron range '${rangePart}' (expected ${min}-${max})`);
        }
        start = a;
        end = b;
      } else {
        const val = Number(rangePart);
        if (!Number.isInteger(val) || val < min || val > max) {
          throw new Error(`Cron value '${rangePart}' out of bounds (${min}-${max})`);
        }
        start = val;
        end = stepParts[1] !== undefined ? max : val;
      }
    }

    for (let v = start; v <= end; v += step) {
      result.add(v);
    }
  }

  if (result.size === 0) {
    throw new Error(`Cron field '${field}' matched no values`);
  }
  return result;
}

export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression '${expr}': expected 5 fields (min hour dom month dow)`);
  }
  return {
    minutes: parseCronField(parts[0], 0, 59),
    hours: parseCronField(parts[1], 0, 23),
    daysOfMonth: parseCronField(parts[2], 1, 31),
    months: parseCronField(parts[3], 1, 12),
    daysOfWeek: parseCronField(parts[4], 0, 6),
  };
}

export function getNextCronDate(expr: string, from: Date = new Date()): Date {
  const parsed = parseCronExpression(expr);
  // Start checking from the next whole minute (advance monotonically by 60s to avoid DST skips/repeats)
  const startMs = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const candidate = new Date(startMs);

  // Bounded search up to 4 years (handles Feb 29 leap-day expressions without infinite loops on Feb 31)
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (
      parsed.months.has(candidate.getMonth() + 1) &&
      parsed.daysOfMonth.has(candidate.getDate()) &&
      parsed.daysOfWeek.has(candidate.getDay()) &&
      parsed.hours.has(candidate.getHours()) &&
      parsed.minutes.has(candidate.getMinutes())
    ) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }

  throw new Error(`Cron expression '${expr}' has no matching date within the next 4 years`);
}

export function getNextCronDelayMs(expr: string, from: Date = new Date()): number {
  const next = getNextCronDate(expr, from);
  return Math.max(1000, next.getTime() - from.getTime());
}
