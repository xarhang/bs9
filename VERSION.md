# BS9 Version and Release Management

## Current release

- Source version: **1.6.12**
- Release date: **September 20, 2026**
- License: **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)**
- Previous Git tag: `v1.6.11`
- Planned tag for this release: `v1.6.12`

`package.json` is the authoritative source for the CLI and package version. The CLI reads it at runtime; do not hard-code a second version in `bin/bs9`.

## Version policy

BS9 follows Semantic Versioning:

- Patch (`1.6.11` to `1.6.12`): compatible fixes and documentation corrections.
- Minor (`1.6.x` to `1.7.0`): backward-compatible features.
- Major (`1.x` to `2.0.0`): incompatible public API or CLI contract changes.

A license change is always called out prominently in the changelog and release notes even when runtime APIs remain compatible.

## Files that must agree

Before tagging a release, verify all of the following:

- `package.json` version and SPDX license expression;
- `bun.lock` dependency graph;
- README version badge, installation URL, and license badge;
- `INSTALL.md` release URL;
- `CHANGELOG.md` release heading and date;
- documentation version footers;
- canonical `LICENSE` text and source SPDX identifiers.

Search for stale release references with:

```bash
rg -n "BS9 Version:|releases/download/v|version-[0-9]+\\.[0-9]+\\.[0-9]+" -g "*.md"
rg -n "MIT License|License-MIT|opensource.org/licenses/MIT" -g "!node_modules/**"
```

Historical changelog entries and the statement that older releases remain MIT-licensed are intentional and must not be rewritten.

## Release verification

Run the complete verification sequence before committing or tagging:

```bash
bun install --frozen-lockfile
bun ./node_modules/typescript/bin/tsc --noEmit
bun run build
bun test
git diff --check
npm pack --dry-run
```

For the high-availability runtime, also retain the JSON output of an isolated verification run:

```bash
bs9 verify-ha examples/express-app.js --json
```

## Commit, tag, and publish

Review the complete diff before staging. The working tree may contain implementation changes in addition to generated version metadata.

```bash
git add --all
git commit -m "release: bs9 v1.6.12"
git tag -a v1.6.12 -m "BS9 v1.6.12"
git push origin main
git push origin v1.6.12
npm publish
```

Pushing the branch, creating the GitHub release, and publishing to npm are separate external actions. Confirm each one independently and never reuse a version that has already been published to npm.

## Automated scripts

The repository exposes `version:patch`, `version:minor`, `version:major`, and matching publish scripts. These scripts can commit, tag, push, or publish. Use them only from a reviewed, clean working tree; for a release containing many hand-written changes, the explicit workflow above is easier to audit.
