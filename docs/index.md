---
layout: default
title: Documentation
description: Self-healing process manager for Bun with zero-downtime clustering, real-time dashboards, TypeScript build support, and durable same-host state.
home: true
permalink: /
---

<section class="hero">
  <p class="eyebrow">Bun Sentinel 9 · v1.6.3</p>
  <h1>Keep services running.<br><span>Stay in control.</span></h1>
  <p class="lede">Self-healing process manager for Bun with zero-downtime clustering, real-time dashboards, TypeScript build support, and durable same-host state.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/commands/' | relative_url }}">Explore commands →</a>
    <a class="button" href="https://github.com/xarhang/bs9">View on GitHub ↗</a>
  </div>
  <div class="install"><pre><code>bun add -g bs9
bs9 start app.ts --name api -i max
bs9 status</code></pre></div>
</section>

<section class="feature-grid" aria-label="Key capabilities">
  <article class="card">
    <span class="kicker">Resilience</span>
    <h3>Zero-downtime reloads</h3>
    <p>Replace-first rolling generations preserve ready capacity while your application updates.</p>
  </article>
  <article class="card">
    <span class="kicker">Portable</span>
    <h3>Native supervision</h3>
    <p>Runs with systemd, launchd, and the Windows watchdog without requiring root access.</p>
  </article>
  <article class="card">
    <span class="kicker">Observable</span>
    <h3>Diagnostics built in</h3>
    <p>Inspect health, logs, exceptions, metrics, cluster state, and recovery from one CLI.</p>
  </article>
</section>

## Documentation

<section class="docs-grid" aria-label="Documentation sections">
  <a class="card" href="{{ '/commands/' | relative_url }}">
    <span class="kicker">39 commands</span>
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
