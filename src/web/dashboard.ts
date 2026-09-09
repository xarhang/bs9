#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * Web Dashboard — Glassmorphism UI with WebSocket live push
 *
 * Features:
 *   - Real-time metrics via WebSocket (2s push, no polling)
 *   - Restart / Stop actions with Bearer token auth
 *   - Glassmorphism dark-mode UI
 *   - Cluster worker grouping
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { serve } from "bun";
import { listServices, ServiceMetrics as UnifiedMetrics } from "../utils/service-discovery.js";
import { execSync } from "node:child_process";

const SESSION_TOKEN = process.env.WEB_SESSION_TOKEN || "";
const PORT = Number(process.env.WEB_DASHBOARD_PORT) || 8080;

// --- Active WebSocket clients ---
const clients = new Set<{ send: (data: string) => void }>();

// --- Data helpers ---
const getMetrics = async (): Promise<UnifiedMetrics[]> => {
  try {
    const services = await listServices();
    return await Promise.all(services.map(async (service) => {
      try {
        const portMatch = service.description.match(/port[=:]?\s*(\d+)/i);
        const port = portMatch?.[1];
        if (port) {
          try {
            const h = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
            service.health = h.status === 200 ? "healthy" : "unhealthy";
          } catch { service.health = "unhealthy"; }
        } else {
          service.health = "no_port";
        }
      } catch { service.health = "unknown"; }
      return service;
    }));
  } catch { return []; }
};

const formatMemory = (bytes: number): string => {
  if (bytes === 0) return "0B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${sizes[i]}`;
};

const buildPayload = async () => {
  const services = await getMetrics();
  const running = services.filter(s => s.active === "active").length;
  const totalMemoryBytes = services.reduce((sum, s) => {
    const m = s.memory.match(/([\d.]+)(B|KB|MB|GB)/);
    if (m) return sum + Number(m[1]) * Math.pow(1024, ["B", "KB", "MB", "GB"].indexOf(m[2]));
    return sum;
  }, 0);
  return {
    services,
    total: services.length,
    running,
    totalMemory: formatMemory(totalMemoryBytes),
    lastUpdate: new Date().toLocaleTimeString(),
  };
};

// --- Auth check helper ---
const isAuthorized = (req: Request): boolean => {
  if (!SESSION_TOKEN) return true; // No token configured = open
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7) === SESSION_TOKEN;
  }
  // Also allow token as query param for WebSocket handshake
  const url = new URL(req.url);
  return url.searchParams.get("token") === SESSION_TOKEN;
};

// --- WebSocket push loop ---
const startPushLoop = () => {
  setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const payload = await buildPayload();
      const msg = JSON.stringify({ type: "metrics", data: payload });
      for (const client of clients) {
        try { client.send(msg); } catch { clients.delete(client); }
      }
    } catch {}
  }, 2000);
};

// --- HTML Template (Glassmorphism dark UI) ---
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BS9 Dashboard</title>
  <style>
    :root { --bg: #0d0d1a; --surface: rgba(255,255,255,0.06); --border: rgba(255,255,255,0.12); --accent: #7c6aff; --green: #22c55e; --red: #ef4444; --yellow: #eab308; --text: #e2e8f0; --muted: #94a3b8; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height:100vh; padding:24px; }
    h1 { font-size:1.6rem; font-weight:700; background: linear-gradient(135deg, #a78bfa, #60a5fa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; }
    .ws-dot { width:8px; height:8px; border-radius:50%; background:var(--green); display:inline-block; margin-right:6px; animation:pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:24px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:20px; backdrop-filter:blur(12px); }
    .card-val { font-size:2rem; font-weight:800; color:var(--accent); }
    .card-lbl { font-size:.8rem; color:var(--muted); margin-top:4px; }
    .table-wrap { background:var(--surface); border:1px solid var(--border); border-radius:16px; overflow:hidden; backdrop-filter:blur(12px); }
    table { width:100%; border-collapse:collapse; }
    th { background:rgba(255,255,255,0.04); padding:12px 16px; text-align:left; font-size:.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
    td { padding:12px 16px; border-top:1px solid var(--border); font-size:.88rem; }
    .badge { display:inline-block; padding:2px 10px; border-radius:99px; font-size:.75rem; font-weight:600; }
    .badge-green { background:rgba(34,197,94,.15); color:var(--green); }
    .badge-red   { background:rgba(239,68,68,.15); color:var(--red); }
    .badge-yellow{ background:rgba(234,179,8,.15);  color:var(--yellow); }
    .btn { border:none; border-radius:8px; padding:4px 12px; font-size:.78rem; font-weight:600; cursor:pointer; transition:opacity .15s; }
    .btn:hover { opacity:.8; }
    .btn-restart { background:rgba(124,106,255,.25); color:#a78bfa; }
    .btn-stop    { background:rgba(239,68,68,.25);   color:var(--red); }
    #last-update { font-size:.8rem; color:var(--muted); }
    tr:hover td { background:rgba(255,255,255,0.02); }
  </style>
</head>
<body>
<div class="header">
  <h1>🔍 BS9 Dashboard</h1>
  <span id="last-update"><span class="ws-dot" id="ws-dot"></span>connecting...</span>
</div>
<div class="stats" id="stats"></div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Service</th><th>State</th><th>Health</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Actions</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
const TOKEN = "${SESSION_TOKEN}";
const wsUrl = (TOKEN ? \`ws://\${location.host}/ws?token=\${TOKEN}\` : \`ws://\${location.host}/ws\`);
let ws;

function healthBadge(h) {
  if (h === 'healthy')   return '<span class="badge badge-green">Healthy</span>';
  if (h === 'unhealthy') return '<span class="badge badge-red">Unhealthy</span>';
  return '<span class="badge badge-yellow">' + h + '</span>';
}

function render(data) {
  document.getElementById('last-update').innerHTML = \`<span class="ws-dot" id="ws-dot"></span>\${data.lastUpdate}\`;
  document.getElementById('stats').innerHTML = \`
    <div class="card"><div class="card-val">\${data.total}</div><div class="card-lbl">Total Services</div></div>
    <div class="card"><div class="card-val">\${data.running}</div><div class="card-lbl">Running</div></div>
    <div class="card"><div class="card-val">\${data.totalMemory}</div><div class="card-lbl">Total Memory</div></div>
  \`;
  document.getElementById('tbody').innerHTML = data.services.map(s => \`
    <tr>
      <td><strong>\${s.name}</strong></td>
      <td>\${s.state}</td>
      <td>\${healthBadge(s.health)}</td>
      <td>\${s.cpu}</td>
      <td>\${s.memory}</td>
      <td>\${s.uptime}</td>
      <td>
        <button class="btn btn-restart" onclick="action('\${s.name}','restart')">↺ Restart</button>
        <button class="btn btn-stop"    onclick="action('\${s.name}','stop')">■ Stop</button>
      </td>
    </tr>
  \`).join('');
}

async function action(name, cmd) {
  if (!confirm(\`\${cmd} '\${name}'?\`)) return;
  const res = await fetch(\`/api/services/\${encodeURIComponent(name)}/\${cmd}\`, {
    method: 'POST',
    headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}
  });
  const j = await res.json();
  alert(j.message || j.error || res.statusText);
}

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { document.getElementById('ws-dot').style.background = '#22c55e'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'metrics') render(m.data); };
  ws.onclose = () => { document.getElementById('ws-dot').style.background = '#ef4444'; setTimeout(connect, 3000); };
}
connect();
</script>
</body>
</html>`;

serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // --- WebSocket upgrade ---
    if (url.pathname === "/ws") {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- REST: metrics ---
    if (url.pathname === "/api/metrics") {
      const data = await buildPayload();
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }

    // --- REST: action (restart / stop) ---
    const actionMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/(restart|stop)$/);
    if (actionMatch && req.method === "POST") {
      if (!isAuthorized(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      const name = decodeURIComponent(actionMatch[1]);
      const cmd = actionMatch[2];
      try {
        execSync(`bun run "${import.meta.dir}/../../../bin/bs9" ${cmd} "${name}"`, { stdio: "ignore" });
        return new Response(JSON.stringify({ message: `Service '${name}' ${cmd} initiated` }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // --- HTML dashboard ---
    if (url.pathname === "/") {
      return new Response(HTML_TEMPLATE.replace("${SESSION_TOKEN}", SESSION_TOKEN), { headers: { "Content-Type": "text/html" } });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) { clients.add(ws); },
    close(ws) { clients.delete(ws); },
    message(_ws, _msg) {},
  },
});

startPushLoop();
console.log(`🌐 BS9 Dashboard → http://localhost:${PORT}  (WebSocket live push enabled)`);
if (SESSION_TOKEN) console.log(`🔑 Session token: ${SESSION_TOKEN.slice(0, 8)}...`);