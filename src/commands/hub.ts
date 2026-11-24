/**
 * BS9 - Multi-Host State Hub Management Command (`bs9 hub`)
 *
 * Subcommands:
 * - `bs9 hub init`   : Initialize cluster secret & node ID in <stateDir>/hub-peer/
 * - `bs9 hub status` : Show local State Hub & Raft-lite replication status
 * - `bs9 hub peers`  : Show configured/connected cluster peers
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { getPlatformInfo } from "../platform/detect.js";
import { ensurePrivateDirectory, securePrivateFile } from "../utils/private-files.js";
import { ControllerAdminClient } from "../cluster/admin-client.js";
import { isDaemonResponsive } from "../daemon/ensure.js";

export interface HubCommandOptions {
  nodeId?: string;
  secret?: string;
  force?: boolean;
  json?: boolean;
  stateDir?: string;
}

export function initHubClusterIdentity(options: HubCommandOptions = {}): {
  nodeId: string;
  secret: string;
  secretFile: string;
  nodeIdFile: string;
} {
  const baseDir = options.stateDir || getPlatformInfo().stateDir;
  const peerDir = join(baseDir, "hub-peer");
  ensurePrivateDirectory(peerDir);

  const secretFile = join(peerDir, "cluster.secret");
  const nodeIdFile = join(peerDir, "node.id");

  let secret = options.secret?.trim() || "";
  if (!secret) {
    if (existsSync(secretFile) && !options.force) {
      secret = readFileSync(secretFile, "utf-8").trim();
    } else {
      secret = randomBytes(32).toString("hex");
      writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
      securePrivateFile(secretFile);
    }
  } else {
    if (secret.length < 16) {
      throw new Error("Cluster secret must be at least 16 characters");
    }
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    securePrivateFile(secretFile);
  }

  let nodeId = options.nodeId?.trim() || "";
  if (!nodeId) {
    if (existsSync(nodeIdFile) && !options.force) {
      nodeId = readFileSync(nodeIdFile, "utf-8").trim();
    } else {
      const host = hostname().replace(/[^a-zA-Z0-9_-]/g, "-") || "node";
      nodeId = `${host}-${randomBytes(3).toString("hex")}`;
      writeFileSync(nodeIdFile, `${nodeId}\n`, { mode: 0o600 });
      securePrivateFile(nodeIdFile);
    }
  } else {
    writeFileSync(nodeIdFile, `${nodeId}\n`, { mode: 0o600 });
    securePrivateFile(nodeIdFile);
  }

  return { nodeId, secret, secretFile, nodeIdFile };
}

export async function hubCommand(
  action: string = "status",
  options: HubCommandOptions = {}
): Promise<void> {
  switch (action) {
    case "init": {
      const res = initHubClusterIdentity(options);
      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log("✅ Initialized BS9 Multi-Host State Hub identity:");
      console.log(`   Node ID:     ${res.nodeId} (${res.nodeIdFile})`);
      console.log(`   Secret File: ${res.secretFile}`);
      console.log(`\n📋 Copy this cluster secret to your other nodes (requires >= 3 nodes for automatic failover):`);
      console.log(`   bs9 hub init --secret ${res.secret} --node-id <other-node-id>`);
      console.log(`\n🚀 Start daemon with multi-host replication enabled:`);
      console.log(`   BS9_HUB_LISTEN=0.0.0.0:7409 BS9_HUB_PEERS=host2:7409,host3:7409 bs9 daemon start`);
      return;
    }

    case "peers":
    case "status":
    default: {
      const active = await isDaemonResponsive();
      if (!active) {
        if (options.json) {
          console.log(JSON.stringify({ running: false }, null, 2));
        } else {
          console.log("❌ BS9 Persistent Daemon is NOT running.");
        }
        return;
      }

      const adminClient = new ControllerAdminClient();
      if (!(await adminClient.connect())) {
        console.error("❌ Failed to connect to BS9 Controller Admin socket.");
        process.exit(1);
      }

      try {
        const report = await adminClient.ping();
        if (options.json) {
          console.log(JSON.stringify(report.hub, null, 2));
          return;
        }

        console.log("🌐 BS9 State Hub Status:");
        console.log(`   Listening:   ${report.hub.listening ? "yes" : "no"}`);
        console.log(`   Namespaces:  ${report.hub.namespacesCount}`);
        console.log(`   WAL Records: ${report.hub.walRecordsCount} (recovered: ${report.hub.walRecovered ? "yes" : "no"})`);

        if (!report.hub.cluster?.enabled) {
          console.log(`   Mode:        Single-Host (UDS / Named Pipe, zero-config)`);
          console.log(`   Tip:         Run 'bs9 hub init' and set BS9_HUB_PEERS to enable Multi-Host Raft-lite replication.`);
        } else {
          const c = report.hub.cluster;
          console.log(`   Mode:        Multi-Host Cluster (Raft-lite over TLS)`);
          console.log(`   Node ID:     ${c.nodeId}`);
          console.log(`   Role:        ${c.role.toUpperCase()} (term ${c.term})`);
          console.log(`   Leader ID:   ${c.leaderId || "electing..."}`);
          console.log(`   Committed:   index ${c.commitIndex}`);
          console.log(`   Connected:   ${c.peersCount} peer(s)`);
        }
      } finally {
        adminClient.disconnect();
      }
      return;
    }
  }
}
