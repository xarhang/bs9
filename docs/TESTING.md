# BS9 Test and Release Qualification

BS9 uses layered tests rather than treating a large raw count as proof of reliability.

## Required pull-request gates

- The complete Bun test suite runs on Linux, Windows, and macOS.
- Each OS runs against the oldest supported Bun line and the latest Bun release.
- Native lifecycle tests exercise Windows service/watchdog and macOS launchd behavior.
- Native HA tests maintain traffic while workers crash, reload, and scale.
- The release gate cannot pass unless every matrix job passes.

The compatibility matrix additionally installs and tests the packed CLI on Ubuntu 22.04/24.04/26.04, Debian 12/13, CentOS Stream 9, Red Hat UBI 9, Rocky Linux 9, AlmaLinux 9, Fedora, openSUSE Leap, Arch Linux, Alpine Linux, Linux Mint 21.3, Windows Server 2022/2025, and macOS 14/15/26. Container jobs validate distribution libraries, installation, packaging, CLI output, contracts, log files, and WAL recovery. The automated scope is intentionally limited to GitHub-hosted runners and Docker images running on GitHub Actions; no self-hosted infrastructure is required.

Run the same checks locally with:

```bash
bun run test:release
bun run test:contracts
bun run test:resilience
```

## Published-package canary

`.github/workflows/published-canary.yml` installs the package back from npm on all three operating systems. It verifies version, help, diagnostics, and visible CLI output. The registry lookup retries to tolerate npm propagation delay.

Every source commit also runs a pre-publish black-box qualification. CI creates the real npm tarball, installs it into an empty sandbox, invokes the packaged binary, and then executes native load, live reload, crash recovery, scaling, log growth, log flushing, and final worker-count checks on Linux, Windows, and macOS. This catches missing package files and behavior differences hidden by source-only tests.

## Nightly load and chaos

The scheduled CI run increases native HA concurrency and soak duration. It verifies rolling reload under traffic, violent worker termination, replacement generations, controller recovery, WAL replay, queue/lease behavior, and cleanup of native services.

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
