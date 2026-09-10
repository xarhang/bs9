#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * Web Dashboard — Glassmorphism UI with WebSocket live push
 *
 * Features:
 *   - Real-time metrics via WebSocket (2s push, no polling)
 *   - Restart / Stop actions with secure HttpOnly cookie / Bearer token auth
 *   - Safe process spawning without shell interpolation
 *   - Glassmorphism dark-mode UI with high contrast input fields
 *   - Cluster worker grouping
 *
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { serve } from "bun";
import { listServices, ServiceMetrics as UnifiedMetrics } from "../utils/service-discovery.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SESSION_TOKEN = process.env.WEB_SESSION_TOKEN || "";
const PORT = Number(process.env.WEB_DASHBOARD_PORT) || 8080;
const HOST = process.env.WEB_DASHBOARD_HOST || "127.0.0.1";

// Resolve bs9 binary relative to current file: d:\bs9\src\web -> d:\bs9\bin\bs9
const bs9Bin = resolve(import.meta.dir, "../../bin/bs9");

// Security: Service name validation
function isValidServiceName(name: string): boolean {
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  return validPattern.test(name) && name.length <= 64 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

const ALLOWED_ACTIONS = new Set(["restart", "stop"]);

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

// --- Coalescing Cache for Metrics (Finding 7 & 14) ---
let cachedPayload: any = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 2000;

const getCachedOrFreshPayload = async () => {
  const now = Date.now();
  if (cachedPayload && (now - lastCacheTime) < CACHE_TTL_MS) {
    return cachedPayload;
  }
  cachedPayload = await buildPayload();
  lastCacheTime = now;
  return cachedPayload;
};

// --- Auth check helper ---
function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k && v) cookies[k] = decodeURIComponent(v);
  }
  return cookies;
}

const isAuthorized = (req: Request): boolean => {
  if (!SESSION_TOKEN) return true; // No token configured = open
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7) === SESSION_TOKEN;
  }
  const cookies = parseCookies(req.headers.get("Cookie"));
  if (cookies["bs9_session"] === SESSION_TOKEN) {
    return true;
  }
  // Allow token as query param for WebSocket handshake
  const url = new URL(req.url);
  return url.searchParams.get("token") === SESSION_TOKEN;
};

// --- WebSocket push loop ---
const startPushLoop = () => {
  setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const payload = await getCachedOrFreshPayload();
      const msg = JSON.stringify({ type: "metrics", data: payload });
      for (const client of clients) {
        try { client.send(msg); } catch { clients.delete(client); }
      }
    } catch {}
  }, 2000);
};

// --- Login Page Template (when authentication is required) ---
const LOGIN_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BS9 Dashboard - Login</title>
  <style>
    :root {
      --bg: #0d0d1a;
      --surface: rgba(255,255,255,0.06);
      --border: rgba(255,255,255,0.18);
      --accent: #7c6aff;
      --accent-hover: #9384ff;
      --text: #f8fafc;
      --muted: #cbd5e1;
      --input-bg: #1e1e38;
      --input-text: #ffffff;
      --red: #ef4444;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:36px; max-width:420px; width:100%; backdrop-filter:blur(16px); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { font-size:1.6rem; font-weight:700; background: linear-gradient(135deg, #a78bfa, #60a5fa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:8px; }
    p { color:var(--muted); font-size:0.9rem; margin-bottom:24px; line-height:1.4; }
    .form-group { margin-bottom:20px; }
    label { display:block; font-size:0.85rem; font-weight:600; margin-bottom:8px; color:var(--text); }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--input-bg);
      color: var(--input-text);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(124,106,255,0.3); }
    .btn-submit {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 10px;
      background: var(--accent);
      color: #ffffff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn-submit:hover { background: var(--accent-hover); }
    .error-msg { color: var(--red); font-size: 0.85rem; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 BS9 Sentinel</h1>
    <p>Session authentication required to manage services.</p>
    <form id="loginForm" onsubmit="handleLogin(event)">
      <div class="form-group">
        <label for="token">Session Token</label>
        <input type="password" id="token" placeholder="Paste session token" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn-submit" id="submitBtn">Sign In</button>
      <div id="errorMsg" class="error-msg"></div>
    </form>
  </div>
  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const token = document.getElementById('token').value.trim();
      const err = document.getElementById('errorMsg');
      const btn = document.getElementById('submitBtn');
      err.style.display = 'none';
      btn.disabled = true;
      btn.innerText = 'Verifying...';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          err.innerText = data.error || 'Authentication failed';
          err.style.display = 'block';
        }
      } catch (ex) {
        err.innerText = 'Network error: ' + ex.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.innerText = 'Sign In';
      }
    }
  </script>
</body>
</html>`;

// --- HTML Template (Glassmorphism dark UI, zero embedded tokens) ---
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
    .header-right { display:flex; align-items:center; gap:16px; }
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
    .btn-logout  { background:rgba(255,255,255,0.1); color:var(--muted); }
    #last-update { font-size:.8rem; color:var(--muted); }
    tr:hover td { background:rgba(255,255,255,0.02); }
  </style>
</head>
<body>
<div class="header">
  <h1>🔍 BS9 Dashboard</h1>
  <div class="header-right">
    <span id="last-update"><span class="ws-dot" id="ws-dot"></span>connecting...</span>
    <button class="btn btn-logout" onclick="logout()">Logout</button>
  </div>
</div>
<div class="stats" id="stats"></div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Service</th><th>State</th><th>Health</th><th>CPU</th><th>Memory</th><th>Uptime</th><th>Actions</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
let ws;

function healthBadge(h) {
  if (h === 'healthy')   return '<span class="badge badge-green">Healthy</span>';
  if (h === 'unhealthy') return '<span class="badge badge-red">Unhealthy</span>';
  return '<span class="badge badge-yellow">' + h + '</span>';
}

function render(data) {
  document.getElementById('last-update').innerHTML = '<span class="ws-dot" id="ws-dot"></span>' + data.lastUpdate;
  document.getElementById('stats').innerHTML = 
    '<div class="card"><div class="card-val">' + data.total + '</div><div class="card-lbl">Total Services</div></div>' +
    '<div class="card"><div class="card-val">' + data.running + '</div><div class="card-lbl">Running</div></div>' +
    '<div class="card"><div class="card-val">' + data.totalMemory + '</div><div class="card-lbl">Total Memory</div></div>';
  document.getElementById('tbody').innerHTML = data.services.map(s => 
    '<tr>' +
      '<td><strong>' + s.name + '</strong></td>' +
      '<td>' + s.state + '</td>' +
      '<td>' + healthBadge(s.health) + '</td>' +
      '<td>' + s.cpu + '</td>' +
      '<td>' + s.memory + '</td>' +
      '<td>' + s.uptime + '</td>' +
      '<td>' +
        '<button class="btn btn-restart" onclick="action(\\'' + s.name + '\\',\\'restart\\')">↺ Restart</button> ' +
        '<button class="btn btn-stop"    onclick="action(\\'' + s.name + '\\',\\'stop\\')">■ Stop</button>' +
      '</td>' +
    '</tr>'
  ).join('');
}

async function action(name, cmd) {
  if (!confirm(cmd + ' \\'' + name + '\\'?')) return;
  const res = await fetch('/api/services/' + encodeURIComponent(name) + '/' + cmd, {
    method: 'POST'
  });
  const j = await res.json();
  alert(j.message || j.error || res.statusText);
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
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
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // --- Authentication: Login ---
    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        const body = await req.json() as { token?: string };
        if (SESSION_TOKEN && body.token === SESSION_TOKEN) {
          const isHttps = url.protocol === "https:";
          const cookieVal = `bs9_session=${encodeURIComponent(SESSION_TOKEN)}; HttpOnly; SameSite=Strict; Path=/${isHttps ? "; Secure" : ""}; Max-Age=86400`;
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": cookieVal,
            },
          });
        }
        return new Response(JSON.stringify({ error: "Invalid session token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

    // --- Authentication: Logout ---
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "bs9_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
    }

    // --- WebSocket upgrade ---
    if (url.pathname === "/ws") {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- REST: metrics ---
    if (url.pathname === "/api/metrics") {
      if (!isAuthorized(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      const data = await getCachedOrFreshPayload();
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=2"
        }
      });
    }

    // --- REST: action (restart / stop) ---
    const actionMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/(restart|stop)$/);
    if (actionMatch && req.method === "POST") {
      if (!isAuthorized(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      const name = decodeURIComponent(actionMatch[1]);
      const cmd = actionMatch[2];

      // Security: Validate command and service name against strict allowlist & regex
      if (!ALLOWED_ACTIONS.has(cmd) || !isValidServiceName(name)) {
        return new Response(JSON.stringify({ error: "Security: Invalid command or service name" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      // Security: Verify service existence against current discovered services
      const currentServices = await listServices();
      const cleanName = name.replace(/^(BS9_|bs9\.)/, "");
      const serviceExists = currentServices.some(s => {
        const sClean = s.name.replace(/^(BS9_|bs9\.)/, "");
        return s.name === name || sClean === cleanName;
      });
      if (!serviceExists) {
        return new Response(JSON.stringify({ error: `Service '${name}' not found` }), { status: 404, headers: { "Content-Type": "application/json" } });
      }

      try {
        // Safe process invocation using argument array and shell: false
        const child = spawn("bun", ["run", bs9Bin, cmd, name], {
          stdio: "ignore",
          shell: false,
          detached: true
        });
        child.unref();
        return new Response(JSON.stringify({ message: `Service '${name}' ${cmd} initiated` }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // --- HTML dashboard / Login ---
    if (url.pathname === "/") {
      if (SESSION_TOKEN && !isAuthorized(req)) {
        return new Response(LOGIN_TEMPLATE, { headers: { "Content-Type": "text/html" } });
      }
      return new Response(HTML_TEMPLATE, { headers: { "Content-Type": "text/html" } });
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
console.log(`🌐 BS9 Dashboard → http://${HOST}:${PORT} (WebSocket live push enabled)`);
if (SESSION_TOKEN) console.log(`🔑 Session authentication active`);