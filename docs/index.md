---
layout: default
title: Documentation
description: Self-healing process manager for Bun with zero-downtime clustering, real-time dashboards, TypeScript build support, and durable same-host or opt-in multi-host state.
home: true
permalink: /
---

<section class="hero">
  <p class="eyebrow">Bun Sentinel 9 · v1.8.0</p>
  <h1>Keep services running.<br><span>Stay in control.</span></h1>
  <p class="lede">Self-healing process manager for Bun with zero-downtime clustering, WebSocket live dashboards, AI-safe MCP guardrails, and durable same-host or opt-in multi-host state.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/commands/' | relative_url }}">Explore commands →</a>
    <a class="button" href="https://github.com/xarhang/bs9">View on GitHub ↗</a>
  </div>
  <div class="install"><pre><code>bun add -g bs9
bs9 start app.ts --name api -i max --wait-ready
bs9 status</code></pre></div>
</section>

<section class="feature-grid" aria-label="Key capabilities">
  <article class="card">
    <span class="kicker">Resilience &amp; Multi-Host</span>
    <h3>Zero-downtime &amp; Raft-lite Hub</h3>
    <p>Replace-first rolling generations, SharedMap/SharedSet, Web session/rate-limit adapters, and opt-in TLS Multi-Host State Hub replication.</p>
  </article>
  <article class="card">
    <span class="kicker">AI-Safe MCP &amp; llms.txt</span>
    <h3>Read-only &amp; audit-logged</h3>
    <p>Native 16-tool MCP server with <code>--readonly</code> guardrails, secret redaction, <code>llms.txt</code> indexing, and tamper-safe <code>bs9 audit</code>.</p>
  </article>
  <article class="card">
    <span class="kicker">Observable &amp; PM2 Ready</span>
    <h3>Live logs &amp; PM2 migration</h3>
    <p>WebSocket delta log streaming, complex PM2 <code>ecosystem.config.js</code> support (<code>--env</code>, <code>kill_timeout</code>), plus Nginx, Caddy, and Grafana exports.</p>
  </article>
</section>

## Documentation

<section class="docs-grid" aria-label="Documentation sections">
  <a class="card" href="{{ '/commands/' | relative_url }}">
    <span class="kicker">41+ commands</span>
    <h3>CLI reference →</h3>
    <p>Lifecycle, monitoring, clustering, deployment, diagnostics, and platform commands.</p>
  </a>
  <a class="card" href="{{ '/api/' | relative_url }}">
    <span class="kicker">Integrate</span>
    <h3>API reference →</h3>
    <p>REST management endpoints and typed runtime primitives for state, leases, and queues.</p>
  </a>
  <a class="card" href="{{ '/high-availability/' | relative_url }}">
    <span class="kicker">Architecture</span>
    <h3>High availability →</h3>
    <p>Understand worker generations, shared state, recovery guarantees, and operating boundaries.</p>
  </a>
</section>

## Quick start

Start one service and let BS9 choose a resilient worker layout:

```bash
bs9 start server.ts --name web -p 3000 -i max
```

Check the daemon and runtime components:

```bash
bs9 ping
bs9 status
bs9 logs web
```

Perform a replace-first rolling reload when a new version is ready:

```bash
bs9 reload web
```
