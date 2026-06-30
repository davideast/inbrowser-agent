# Publish checklist for `@inbrowser` v0.4.0

This release publishes all six packages at the same version to keep installs, docs, and agent-generated code aligned.

## Before publishing

Confirm the release branch contains:

- all package versions set to `0.4.0`
- `publishConfig.access` set to `public` in every package manifest
- `README.md` version table set to `0.4.0` for all packages
- `releases/v0.4.0.md` ready to use as the GitHub release body

Run the preparation script from the repo root:

```sh
./scripts/release.sh 0.4.0
```

The script validates the repo, rebuilds generated site docs used by typecheck, runs the smoke pack, and writes publishable tarballs to `.release/v0.4.0`.

## Publish manually

Publish the tarballs printed by the preparation script. Dependency order is:

```sh
npm publish .release/v0.4.0/inbrowser-model-0.4.0.tgz --access public
npm publish .release/v0.4.0/inbrowser-resumable-0.4.0.tgz --access public
npm publish .release/v0.4.0/inbrowser-workspace-0.4.0.tgz --access public
npm publish .release/v0.4.0/inbrowser-relay-0.4.0.tgz --access public
npm publish .release/v0.4.0/inbrowser-sandbox-0.4.0.tgz --access public
npm publish .release/v0.4.0/inbrowser-agent-0.4.0.tgz --access public
```

Do not publish directly from package directories unless the packed manifest has been inspected. The repo uses `workspace:^` internal dependencies, and `bun pm pack` rewrites them to semver for publication.

## Verify npm

```sh
npm view @inbrowser/model@0.4.0 version
npm view @inbrowser/resumable@0.4.0 version
npm view @inbrowser/workspace@0.4.0 version
npm view @inbrowser/relay@0.4.0 version
npm view @inbrowser/sandbox@0.4.0 version
npm view @inbrowser/agent@0.4.0 version
```

## Tag and release

```sh
git tag v0.4.0
git push origin v0.4.0
```

Create a GitHub release named `@inbrowser v0.4.0` using `releases/v0.4.0.md` as the body.
