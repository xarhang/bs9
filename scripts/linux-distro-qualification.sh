#!/usr/bin/env bash
set -euo pipefail

echo "=== Distribution ==="
cat /etc/os-release
uname -a

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "=== Runtime ==="
bun --version

# Work from the copied checkout, not the read-only host mount.
bun install --frozen-lockfile
bun run build
bunx tsc --noEmit

# Cross-distro contracts plus filesystem and persistence behavior that is valid
# inside containers and on the GitHub-hosted runner environments.
bun test tests/cross-platform-contract-matrix.test.ts
bun test tests/log-growth-recovery.test.ts tests/wal-chaos-recovery.test.ts

pack_dir=$(mktemp -d)
trap 'rm -rf "$pack_dir"' EXIT
bun pm pack --destination "$pack_dir" --quiet
tarball=$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -print -quit)
test -n "$tarball"

bun add -g "$tarball"
test "$(bs9 -V)" = "$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
bs9 --help | grep -q '^Usage: bs9'
bs9 doctor

echo "DISTRO_QUALIFICATION_PASSED"
