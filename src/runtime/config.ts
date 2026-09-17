/**
 * BS9 - Runtime Configuration & Detection
 *
 * Implements:
 * - Runtime configuration options and default getters.
 * - Detection of BS9 environment (BS9_CLUSTER, BS9_HUB_SOCKET, BS9_AUTH_TOKEN_FILE).
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface RuntimeConfig {
  socketPath?: string;
  namespace?: string;
  authToken?: string;
  authTokenFile?: string;
  allowDegradedLocal?: boolean;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/**
 * Checks if the current process is executing within a BS9 environment.
 * Rule 1 / Rule 2: BS9 environment is detected if:
 * - Explicit socketPath or authTokenFile is provided in config, OR
 * - BS9_CLUSTER is set and not false/0, OR
 * - BS9_HUB_SOCKET is set and non-empty, OR
 * - BS9_AUTH_TOKEN_FILE is set and non-empty.
 */
export function isBs9Environment(config?: RuntimeConfig): boolean {
  if (config?.socketPath || config?.authTokenFile) {
    return true;
  }
  const cluster = process.env.BS9_CLUSTER;
  const isCluster = Boolean(cluster && cluster !== "false" && cluster !== "0");
  const hubSocket = process.env.BS9_HUB_SOCKET;
  const isHubSocket = Boolean(hubSocket && hubSocket.trim().length > 0);
  const tokenFile = process.env.BS9_AUTH_TOKEN_FILE;
  const isTokenFile = Boolean(tokenFile && tokenFile.trim().length > 0);

  return isCluster || isHubSocket || isTokenFile;
}
