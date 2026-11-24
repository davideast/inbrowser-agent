#!/usr/bin/env bash
# Prepare publishable tarballs for every @inbrowser package.
#
# This script intentionally stops before publishing. It builds, checks,
# smoke-tests, packs each package with `bun pm pack` so workspace deps are
# rewritten to semver, then prints the npm commands to run manually.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-0.5.0}"
OUT_DIR=".release/v${VERSION}"

PACKAGES=(
  packages/model
  packages/resumable
  packages/workspace
  packages/node
  packages/relay
  packages/sandbox
  packages/agent
  packages/driver
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
UNPUBLISHED=()
for package_dir in "${PACKAGES[@]}"; do
  pkg_name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name)' "${package_dir}/package.json")"
  pkg_version="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "${package_dir}/package.json")"
  if [[ "$pkg_version" != "$VERSION" ]]; then
    echo "ERROR: ${pkg_name} version is ${pkg_version}, expected ${VERSION}" >&2
    exit 1
  fi
  tarball_path="$(cd "$package_dir" && bun pm pack --destination "../../${OUT_DIR}" --quiet)"
  tarball="${OUT_DIR}/$(basename "$tarball_path")"
  # Verify bun pm pack rewrote every internal workspace: specifier.
  tar -xOzf "$tarball" package/package.json | node -e '
    const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(m[k] || {})) {
        if (String(range).startsWith("workspace:")) {
          console.error(`ERROR: ${m.name}@${m.version} has unresolved ${k}.${dep}=${range}`);
          process.exit(1);
        }
      }
    }
  '
  TARBALLS+=("$tarball")
  if npm view "${pkg_name}@${pkg_version}" version --registry=https://registry.npmjs.org/ >/dev/null 2>&1; then
    echo "  ${tarball}  [already published on npm]"
  else
    echo "  ${tarball}  [ready to publish]"
    UNPUBLISHED+=("$tarball")
  fi
done

echo
echo "Manual publish commands (${#UNPUBLISHED[@]} unpublished of ${#TARBALLS[@]} total):"
if [[ "${#UNPUBLISHED[@]}" -eq 0 ]]; then
  echo "  (none — all packages at ${VERSION} are already published)"
else
  for tarball in "${UNPUBLISHED[@]}"; do
    echo "npm publish ${tarball} --access public"
  done
fi

echo
echo "After npm publish succeeds:"
echo "git tag v${VERSION}"
echo "git push origin v${VERSION}"
echo "Create the GitHub release from releases/v${VERSION}.md"
