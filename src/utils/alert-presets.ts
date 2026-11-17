/**
 * BS9 - Notification Alert Presets (Telegram, Discord, Slack)
 *
 * Formats structured, bounded, injection-safe webhook payloads for popular
 * messaging platforms without external SDK dependencies.
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type AlertProvider = "telegram" | "discord" | "slack";

export interface Bs9AlertEvent {
  service: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  host?: string;
  timestamp?: string;
  chatId?: string;
}

function clampText(val: unknown, maxLen: number): string {
  return String(val ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, maxLen);
}

export function formatTelegramAlert(event: Bs9AlertEvent): Record<string, unknown> {
  const icon = event.severity === "critical" ? "🚨" : event.severity === "warning" ? "⚠️" : "ℹ️";
  const text = [
    `${icon} BS9 Alert: ${clampText(event.title, 120)}`,
    `Service: ${clampText(event.service, 64)}`,
    `Severity: ${event.severity.toUpperCase()}`,
    event.host ? `Host: ${clampText(event.host, 128)}` : "",
    `Details: ${clampText(event.message, 1000)}`,
    `Time: ${clampText(event.timestamp || new Date().toISOString(), 64)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const payload: Record<string, unknown> = { text };
  if (event.chatId) {
    payload.chat_id = clampText(event.chatId, 64);
  }
  return payload;
}

export function formatDiscordAlert(event: Bs9AlertEvent): Record<string, unknown> {
  const color = event.severity === "critical" ? 0xef4444 : event.severity === "warning" ? 0xf59e0b : 0x3b82f6;
  return {
    username: "BS9 Sentinel",
    embeds: [
      {
        title: clampText(event.title, 200),
        description: clampText(event.message, 1500),
        color,
        fields: [
          { name: "Service", value: clampText(event.service, 64), inline: true },
          { name: "Severity", value: event.severity.toUpperCase(), inline: true },
          ...(event.host ? [{ name: "Host", value: clampText(event.host, 128), inline: true }] : []),
        ],
        timestamp: event.timestamp || new Date().toISOString(),
      },
    ],
  };
}

export function formatSlackAlert(event: Bs9AlertEvent): Record<string, unknown> {
  const icon = event.severity === "critical" ? ":rotating_light:" : event.severity === "warning" ? ":warning:" : ":information_source:";
  const summary = `${icon} *BS9 Alert — ${clampText(event.title, 150)}* (${clampText(event.service, 64)})`;
  return {
    text: summary,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${summary}\n*Severity:* ${event.severity.toUpperCase()}${event.host ? ` | *Host:* ${clampText(event.host, 128)}` : ""}\n${clampText(event.message, 1500)}`,
        },
      },
    ],
  };
}

export function formatAlertPayload(provider: AlertProvider, event: Bs9AlertEvent): Record<string, unknown> {
  switch (provider) {
    case "telegram":
      return formatTelegramAlert(event);
    case "discord":
      return formatDiscordAlert(event);
    case "slack":
      return formatSlackAlert(event);
    default:
      throw new Error(`Unsupported alert provider: ${String(provider)}`);
  }
}
