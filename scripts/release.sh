#!/usr/bin/env bash
# Prepare publishable tarballs for every @inbrowser package.
#
# This script intentionally stops before publishing. It builds, checks,
# smoke-tests, packs each package with `bun pm pack` so workspace deps are
# rewritten to semver, then prints the npm commands to run manually.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-0.4.0}"
OUT_DIR=".release/v${VERSION}"

PACKAGES=(
  packages/model
  packages/resumable
  packages/workspace
  packages/relay
  packages/sandbox
  packages/agent
)

echo "Preparing @inbrowser v${VERSION} tarballs"
echo

bun install --frozen-lockfile
bun run check
bun run build
bun run test
bun run --cwd site build-graph
bun run --cwd site build-chunk-index
bun run typecheck
bun run smoke

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo
echo "Packing packages into ${OUT_DIR}"
TARBALLS=()
for package_dir in "${PACKAGES[@]}"; do
  tarball_path="$(cd "$package_dir" && bun pm pack --destination "../../${OUT_DIR}" --quiet)"
  tarball="${OUT_DIR}/$(basename "$tarball_path")"
  TARBALLS+=("$tarball")
  echo "  ${tarball}"
done

echo
echo "Manual publish commands:"
for tarball in "${TARBALLS[@]}"; do
  echo "npm publish ${tarball} --access public"
done

echo
echo "After npm publish succeeds:"
echo "git tag v${VERSION}"
echo "git push origin v${VERSION}"
echo "Create the GitHub release from releases/v${VERSION}.md"
