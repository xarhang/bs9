# BS9 Test and Release Qualification

BS9 uses layered tests rather than treating a large raw count as proof of reliability.

## Required pull-request gates

- The complete Bun test suite runs on Linux, Windows, and macOS.
- Each OS runs against the oldest supported Bun line and the latest Bun release.
- Native lifecycle tests exercise Windows service/watchdog and macOS launchd behavior.
- Native HA tests maintain traffic while workers crash, reload, and scale.
- The release gate cannot pass unless every matrix job passes.

Run the same checks locally with:

```bash
bun run test:release
bun run test:contracts
bun run test:resilience
```

## Published-package canary

`.github/workflows/published-canary.yml` installs the package back from npm on all three operating systems. It verifies version, help, diagnostics, and visible CLI output. The registry lookup retries to tolerate npm propagation delay.

## Nightly load and chaos

The scheduled CI run increases native HA concurrency and soak duration. It verifies rolling reload under traffic, violent worker termination, replacement generations, controller recovery, WAL replay, queue/lease behavior, and cleanup of native services.

## Real reboot qualification

Hosted CI machines cannot safely reboot and resume the same job. Reboot qualification therefore runs on disposable self-hosted machines, once per supported OS image:

```bash
BS9_REBOOT_E2E=1 bun scripts/reboot-recovery.ts before
# Reboot the machine through the platform or cloud control plane.
BS9_REBOOT_E2E=1 bun scripts/reboot-recovery.ts after
```

The before phase starts a health endpoint, saves its configuration, enables startup recovery, and writes a durable checkpoint. The after phase requires the checkpoint, verifies or resurrects the service, probes health, checks process discovery, and removes the canary.

## Staging and progressive rollout

Production releases should progress through these environments:

1. Build and test the immutable npm candidate.
2. Deploy to staging and run at least one hour of load and chaos.
3. Deploy to a 5% canary pool and observe for 24 hours.
4. Promote to 25%, 50%, and 100% only while crash, restart, availability, latency, memory, and recovery objectives remain healthy.
5. Roll back automatically when an objective breaches its configured threshold.

Infrastructure credentials, hosts, traffic sources, and rollback commands are deployment-specific and must be supplied by the operator. They must not be embedded in the repository.

## Quality targets

- At least 2,000 independently reported logical cases.
- Zero failures on Linux, Windows, and macOS release gates.
- At least 90% line and 85% branch coverage for core packages.
- Zero dropped requests in bounded rolling-reload verification.
- No orphan or duplicate worker after crash/recovery tests.
- Successful persisted-state recovery after WAL tail corruption.
- Successful service recovery after a real host reboot.
