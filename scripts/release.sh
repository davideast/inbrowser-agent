#!/usr/bin/env bash
# Publish all three packages in dependency order.
# Bump versions in each packages/<name>/package.json first, then run this.
set -euo pipefail

cd "$(dirname "$0")/.."

bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test

echo "About to publish. npm whoami:"
npm whoami

read -p "Continue? [y/N] " -n 1 -r
echo
[[ $REPLY =~ ^[Yy]$ ]] || exit 1

# Order matters: relay depends on resumable.
(cd packages/resumable && npm publish --access public)
(cd packages/relay     && npm publish --access public)
(cd packages/agent     && npm publish --access public)

echo "Published. Tag with: git tag inbrowser-<pkg>@<version> && git push --tags"
